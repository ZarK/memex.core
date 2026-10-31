// openDatabase: one SQLite connection with the Memex settings (WAL, a busy
// timeout, foreign keys), synchronous transactions that nest, and WAL
// checkpoints when the connection is idle and when the process exits. Memex has
// no backup or restore: a checkpoint keeps the main database file complete, so
// that the user's own backup tool copies a whole database.
import type { RunResult, SqlValue, SqliteConnection, SqliteDriver, SqliteStatement } from "./driver.js";
import { SqliteError } from "./errors.js";

export type CheckpointMode = "PASSIVE" | "FULL" | "RESTART" | "TRUNCATE";

export interface CheckpointResult {
  /** 1 when the checkpoint could not finish because another connection was busy. */
  busy: number;
  /** Frames in the WAL file (-1 when the database is not in WAL mode). */
  log: number;
  /** Frames copied back into the database file. */
  checkpointed: number;
}

export interface OpenOptions {
  driver: SqliteDriver;
  readonly?: boolean;
  /** How long a statement waits for a lock held by another connection. Default 5000 ms. */
  busyTimeoutMs?: number;
  /** A passive checkpoint runs this long after the last write. Default 30000 ms; 0 turns it off. */
  idleCheckpointMs?: number;
}

const open = new Set<SqliteDatabase>();
let exitHookInstalled = false;

/** Opens a database. The file is made when it does not exist (unless readonly). */
export function openDatabase(path: string, options: OpenOptions): SqliteDatabase {
  const readonly = options.readonly ?? false;
  const connection = options.driver.open(path, { readonly });
  const db = new SqliteDatabase(connection, options.driver, path, readonly, options.idleCheckpointMs ?? 30_000);
  try {
    db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(options.busyTimeoutMs ?? 5000))}`);
    if (!readonly) db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
  } catch (error) {
    connection.close();
    throw error;
  }
  open.add(db);
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once("exit", closeOpenDatabases);
  }
  return db;
}

/**
 * Checkpoints and closes every database this process opened and did not close.
 * Runs on process exit. An app that stops on a signal calls it (or exits with
 * process.exit) in its signal handler.
 */
export function closeOpenDatabases(): void {
  for (const db of [...open]) {
    try {
      db.close();
    } catch {
      // Exiting: a database that cannot close keeps its WAL, which SQLite replays on the next open.
    }
  }
}

export class SqliteDatabase {
  private depth = 0;
  private closed = false;
  private idleTimer: NodeJS.Timeout | undefined;
  private readonly statements = new Map<string, SqliteStatement>();

  constructor(
    readonly connection: SqliteConnection,
    readonly driver: SqliteDriver,
    readonly path: string,
    readonly readonly: boolean,
    private readonly idleCheckpointMs: number,
  ) {}

  get isOpen(): boolean {
    return !this.closed;
  }

  get inTransaction(): boolean {
    return this.depth > 0;
  }

  exec(sql: string): void {
    this.assertOpen();
    this.connection.exec(sql);
    this.touch();
  }

  /** A prepared statement. Its run() counts as a write for the idle checkpoint. */
  prepare(sql: string): SqliteStatement {
    this.assertOpen();
    const statement = this.connection.prepare(sql);
    return {
      run: (...params: SqlValue[]): RunResult => {
        const result = statement.run(...params);
        this.touch();
        return result;
      },
      get: (...params: SqlValue[]) => statement.get(...params),
      all: (...params: SqlValue[]) => statement.all(...params),
      ...(statement.readBigInts ? { readBigInts: (on: boolean) => statement.readBigInts!(on) } : {}),
    };
  }

  /** A prepared statement kept on this connection, so loops prepare each SQL text once. */
  cached(sql: string): SqliteStatement {
    let statement = this.statements.get(sql);
    if (!statement) this.statements.set(sql, (statement = this.prepare(sql)));
    return statement;
  }

  run(sql: string, ...params: SqlValue[]): RunResult {
    return this.cached(sql).run(...params);
  }

  get<T = Record<string, unknown>>(sql: string, ...params: SqlValue[]): T | undefined {
    return this.cached(sql).get(...params) as T | undefined;
  }

  all<T = Record<string, unknown>>(sql: string, ...params: SqlValue[]): T[] {
    return this.cached(sql).all(...params) as T[];
  }

  /**
   * Runs fn in a transaction: BEGIN IMMEDIATE at the outside, a savepoint inside
   * another transaction. Commits when fn returns, rolls back when it throws.
   */
  transaction<T>(fn: () => T): T {
    this.assertOpen();
    const outer = this.depth === 0;
    const savepoint = `memex_sqlite_${this.depth}`;
    this.connection.exec(outer ? "BEGIN IMMEDIATE" : `SAVEPOINT ${savepoint}`);
    this.depth += 1;
    let result: T;
    try {
      result = fn();
      if (result instanceof Promise) {
        result.catch(() => undefined);
        throw new SqliteError("ASYNC_TRANSACTION", "A transaction function must be synchronous; it returned a promise.");
      }
      this.connection.exec(outer ? "COMMIT" : `RELEASE ${savepoint}`);
    } catch (error) {
      this.depth -= 1;
      try {
        this.connection.exec(outer ? "ROLLBACK" : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
      } catch {
        // SQLite rolled the transaction back already (for example after SQLITE_FULL).
      }
      throw error;
    }
    this.depth -= 1;
    this.touch();
    return result;
  }

  /** Copies the WAL back into the database file. TRUNCATE also empties the WAL file. */
  checkpoint(mode: CheckpointMode = "PASSIVE"): CheckpointResult {
    this.assertOpen();
    const row = this.connection.prepare(`PRAGMA wal_checkpoint(${mode})`).get() as Record<string, number | bigint>;
    return { busy: Number(row.busy), log: Number(row.log), checkpointed: Number(row.checkpointed) };
  }

  /** Checkpoints (TRUNCATE) and closes. Closing twice does nothing. */
  close(): void {
    if (this.closed) return;
    clearTimeout(this.idleTimer);
    try {
      if (!this.readonly && this.depth === 0) this.checkpoint("TRUNCATE");
    } finally {
      this.closed = true;
      open.delete(this);
      this.statements.clear();
      this.connection.close();
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new SqliteError("CLOSED", `The database ${this.path} is closed.`);
  }

  /** A write happened: the idle checkpoint runs idleCheckpointMs after the last one. */
  private touch(): void {
    if (this.readonly || this.idleCheckpointMs <= 0 || this.depth > 0) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.idle(), this.idleCheckpointMs);
    this.idleTimer.unref();
  }

  private idle(): void {
    this.idleTimer = undefined;
    if (this.closed || this.depth > 0) return;
    try {
      this.checkpoint("PASSIVE");
    } catch {
      // A failed idle checkpoint is retried after the next write and on close.
    }
  }
}
