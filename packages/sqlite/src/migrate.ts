// Numbered migrations per scope, from ai-workspace's migrate.ts. Each scope (an
// app, a library) has its own list of .sql files, applied in name order, each in
// its own transaction, and recorded in schema_migrations with a checksum. The
// library refuses a database instead of guessing:
//
// - SCHEMA_DRIFT: a migration file changed after the database applied it, or a
//   new file sorts before a migration the database already applied.
// - NEWER_DATABASE: the database applied migrations that this version of the
//   app does not have, so a newer version wrote it.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { openDatabase, type SqliteDatabase } from "./database.js";
import { SqliteError } from "./errors.js";

export interface Migration {
  /** The file name, for example 0001_init.sql. Migrations run in name order. */
  name: string;
  sql: string;
}

export interface MigrationResult {
  scope: string;
  applied: string[];
}

/** The .sql files of a folder, in name order. */
export function readMigrations(dir: string): Migration[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(dir, name), "utf-8") }));
}

/** SHA-256 of the SQL with LF line endings, so a checkout with CRLF has the same checksum. */
export function migrationChecksum(sql: string): string {
  return createHash("sha256").update(sql.replace(/\r\n/g, "\n")).digest("hex");
}

function ensureMigrationsTable(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      scope TEXT NOT NULL,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      checksum TEXT,
      PRIMARY KEY (scope, name)
    )
  `);
  // Databases made by @memex/schema 0.1 have the table without a checksum.
  const columns = db.all<{ name: string }>("SELECT name FROM pragma_table_info('schema_migrations')");
  if (!columns.some((c) => c.name === "checksum")) db.exec("ALTER TABLE schema_migrations ADD COLUMN checksum TEXT");
}

/**
 * Applies the migrations of a scope that the database has not applied, in name
 * order. migrations is a folder of .sql files or a list. Foreign keys are off
 * while a migration runs (so a migration can rebuild a table) and checked
 * before its transaction commits. Call it outside a transaction: SQLite cannot
 * turn foreign keys off inside one (MIGRATION_IN_TRANSACTION). Another process
 * may migrate the same database at the same time: a migration that it applied
 * while this one waited for the lock is skipped.
 */
export function migrate(db: SqliteDatabase, scope: string, migrations: string | readonly Migration[]): MigrationResult {
  if (db.inTransaction) throw inTransaction(db);
  const list = [...(typeof migrations === "string" ? readMigrations(migrations) : migrations)].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  ensureMigrationsTable(db);
  const known = new Map(list.map((m) => [m.name, migrationChecksum(m.sql)]));
  const done = db.all<{ name: string; checksum: string | null }>(
    "SELECT name, checksum FROM schema_migrations WHERE scope = ? ORDER BY name",
    scope,
  );

  const unknown = done.filter((row) => !known.has(row.name)).map((row) => row.name);
  if (unknown.length) {
    throw new SqliteError(
      "NEWER_DATABASE",
      `The database ${db.path} was written by a newer version: it applied ${scope} migrations that this version does not have (${unknown.join(", ")}). Update the app.`,
    );
  }
  const changed = done.filter((row) => row.checksum !== null && row.checksum !== known.get(row.name)).map((row) => row.name);
  if (changed.length) {
    throw new SqliteError(
      "SCHEMA_DRIFT",
      `The ${scope} migrations ${changed.join(", ")} changed after the database ${db.path} applied them. Put the files back and add a new migration, or use a new database.`,
    );
  }
  const applied = new Set(done.map((row) => row.name));
  const last = done.at(-1)?.name;
  const pending = list.filter((m) => !applied.has(m.name));
  const early = last === undefined ? [] : pending.filter((m) => m.name < last).map((m) => m.name);
  if (early.length) {
    throw new SqliteError(
      "SCHEMA_DRIFT",
      `The ${scope} migrations ${early.join(", ")} sort before ${last}, which the database ${db.path} already applied. Give them names after ${last}.`,
    );
  }

  // Rows recorded by @memex/schema 0.1 get the checksum of the file they ran from.
  for (const row of done) {
    if (row.checksum === null) {
      db.run("UPDATE schema_migrations SET checksum = ? WHERE scope = ? AND name = ?", known.get(row.name)!, scope, row.name);
    }
  }
  if (!pending.length) return { scope, applied: [] };

  const foreignKeysOn = () => Number(db.get<{ foreign_keys: number }>("PRAGMA foreign_keys")?.foreign_keys ?? 0) === 1;
  const foreignKeys = foreignKeysOn();
  if (foreignKeys) db.exec("PRAGMA foreign_keys = OFF");
  const ran: string[] = [];
  try {
    // SQLite ignores the pragma inside a transaction, for example one begun with exec("BEGIN").
    if (foreignKeysOn()) throw inTransaction(db);
    for (const migration of pending) {
      db.transaction(() => {
        // Another process may have applied it while this one waited for the write lock.
        const row = db.get<{ checksum: string | null }>("SELECT checksum FROM schema_migrations WHERE scope = ? AND name = ?", scope, migration.name);
        if (row) {
          if (row.checksum !== null && row.checksum !== known.get(migration.name)) {
            throw new SqliteError(
              "SCHEMA_DRIFT",
              `The ${scope} migration ${migration.name} was applied to the database ${db.path} from a different file. Put the files back and add a new migration, or use a new database.`,
            );
          }
          return;
        }
        db.exec(migration.sql);
        const broken = db.all<{ table: string }>("PRAGMA foreign_key_check");
        if (broken.length) {
          throw new SqliteError(
            "MIGRATION_FOREIGN_KEYS",
            `The ${scope} migration ${migration.name} left ${broken.length} rows that break a foreign key (in ${[...new Set(broken.map((b) => b.table))].join(", ")}).`,
          );
        }
        db.run("INSERT INTO schema_migrations (scope, name, checksum) VALUES (?, ?, ?)", scope, migration.name, known.get(migration.name)!);
        ran.push(migration.name);
      });
    }
  } finally {
    if (foreignKeys) db.exec("PRAGMA foreign_keys = ON");
  }
  return { scope, applied: ran };
}

function inTransaction(db: SqliteDatabase): SqliteError {
  return new SqliteError(
    "MIGRATION_IN_TRANSACTION",
    `migrate was called inside a transaction on ${db.path}. SQLite cannot turn foreign keys off there, so a table rebuild would cascade. Call migrate outside a transaction.`,
  );
}

/** The schema objects of a database, by type and name, with whitespace-normalized SQL. */
export function schemaObjects(db: SqliteDatabase): Map<string, string> {
  const rows = db.all<{ type: string; name: string; sql: string | null }>(
    "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
  );
  // Line endings and indentation of a migration file do not change the schema.
  return new Map(rows.map((row) => [`${row.type} ${row.name}`, (row.sql ?? "").replace(/\s+/g, " ").trim()]));
}

/**
 * Refuses (SCHEMA_DRIFT) a database whose whole schema is not the schema that
 * prepare makes in a new, empty database. prepare runs the app's migrations; it
 * runs once on an in-memory database with the same driver.
 */
export function assertSchemaMatches(db: SqliteDatabase, prepare: (reference: SqliteDatabase) => void): void {
  const reference = openDatabase(":memory:", { driver: db.driver, idleCheckpointMs: 0 });
  let expected: Map<string, string>;
  try {
    prepare(reference);
    expected = schemaObjects(reference);
  } finally {
    reference.close();
  }
  const actual = schemaObjects(db);
  const differences: string[] = [];
  for (const [key, sql] of expected) {
    const found = actual.get(key);
    if (found === undefined) differences.push(`missing ${key}`);
    else if (found !== sql) differences.push(`changed ${key}`);
  }
  for (const key of actual.keys()) if (!expected.has(key)) differences.push(`unexpected ${key}`);
  if (differences.length) {
    throw new SqliteError(
      "SCHEMA_DRIFT",
      `The schema of ${db.path} does not match the migration files: ${differences.join(", ")}. Use a new database.`,
    );
  }
}
