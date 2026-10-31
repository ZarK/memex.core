// The small driver interface that the library uses. An adapter maps one SQLite
// binding onto it: node:sqlite (built into Node 22.13 and later) or
// better-sqlite3 (a peer dependency). Both are synchronous.

/** A value that SQLite can bind. Blobs come back as Uint8Array (node:sqlite) or Buffer (better-sqlite3). */
export type SqlValue = null | number | bigint | string | Uint8Array;

export interface RunResult {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
}

export interface SqliteStatement {
  run(...params: SqlValue[]): RunResult;
  get(...params: SqlValue[]): unknown;
  all(...params: SqlValue[]): unknown[];
  /** Reads every integer as a bigint (node:sqlite setReadBigInts, better-sqlite3 safeIntegers). Optional for other drivers. */
  readBigInts?(on: boolean): void;
}

export interface SqliteConnection {
  exec(sql: string): unknown;
  prepare(sql: string): SqliteStatement;
  close(): unknown;
}

export interface SqliteDriver {
  /** The binding's name, for messages. */
  readonly name: string;
  open(path: string, options: { readonly: boolean }): SqliteConnection;
}
