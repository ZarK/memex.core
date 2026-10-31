import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ChangeJournal,
  JournalError,
  SqliteError,
  assertSchemaMatches,
  betterSqlite3,
  changeEntries,
  closeOpenDatabases,
  getChange,
  installJournal,
  listChanges,
  migrate,
  openDatabase,
  pruneJournal,
  recordChange,
  undoChange,
  type BetterSqlite3Constructor,
  type Migration,
  type SqliteDatabase,
  type SqliteDriver,
} from "../src/index.js";
import { nodeSqlite } from "../src/node-sqlite.js";

// better-sqlite3 is a peer dependency; its tests run where it is installed and built.
function loadBetterSqlite3(): BetterSqlite3Constructor | undefined {
  try {
    const Database = createRequire(import.meta.url)("better-sqlite3") as BetterSqlite3Constructor;
    new Database(":memory:").close();
    return Database;
  } catch {
    return undefined;
  }
}
const BetterSqlite3 = loadBetterSqlite3();
const drivers: [string, SqliteDriver | undefined][] = [
  ["node:sqlite", nodeSqlite],
  ["better-sqlite3", BetterSqlite3 && betterSqlite3(BetterSqlite3)],
];

const folders: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "memex-sqlite-"));
  folders.push(dir);
  return dir;
}

afterEach(() => {
  closeOpenDatabases();
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const M1: Migration = { name: "0001_init.sql", sql: "CREATE TABLE account (id TEXT PRIMARY KEY, name TEXT NOT NULL);\n" };
const M2: Migration = {
  name: "0002_entry.sql",
  sql: "CREATE TABLE entry (id INTEGER PRIMARY KEY, account_id TEXT NOT NULL REFERENCES account(id), amount INTEGER NOT NULL, note BLOB);\n",
};
const M3: Migration = { name: "0003_label.sql", sql: "ALTER TABLE account ADD COLUMN label TEXT;\n" };

describe.each(drivers)("%s", (name, driver) => {
  const run = driver ? it : it.skip;
  const d = driver!;
  const memory = () => openDatabase(":memory:", { driver: d });

  describe("openDatabase", () => {
    run("sets WAL, the busy timeout, and foreign keys", () => {
      const db = openDatabase(join(tempDir(), "app.db"), { driver: d, busyTimeoutMs: 1234 });
      expect(db.get<{ journal_mode: string }>("PRAGMA journal_mode")?.journal_mode).toBe("wal");
      expect(Number(db.get<{ timeout: number }>("PRAGMA busy_timeout")?.timeout)).toBe(1234);
      expect(Number(db.get<{ foreign_keys: number }>("PRAGMA foreign_keys")?.foreign_keys)).toBe(1);
      db.exec("CREATE TABLE parent (id INTEGER PRIMARY KEY); CREATE TABLE child (parent_id INTEGER REFERENCES parent(id))");
      expect(() => db.run("INSERT INTO child (parent_id) VALUES (?)", 7)).toThrow(/FOREIGN KEY/);
    });

    run("rolls back a transaction that throws, and nests with savepoints", () => {
      const db = memory();
      db.exec("CREATE TABLE t (v INTEGER)");
      expect(() =>
        db.transaction(() => {
          db.run("INSERT INTO t VALUES (1)");
          throw new Error("stop");
        }),
      ).toThrow("stop");
      db.transaction(() => {
        db.run("INSERT INTO t VALUES (2)");
        expect(() =>
          db.transaction(() => {
            db.run("INSERT INTO t VALUES (3)");
            throw new Error("inner");
          }),
        ).toThrow("inner");
        db.transaction(() => db.run("INSERT INTO t VALUES (4)"));
      });
      expect(db.all<{ v: number }>("SELECT v FROM t ORDER BY v").map((r) => Number(r.v))).toEqual([2, 4]);
      expect(db.inTransaction).toBe(false);
    });

    run("refuses an async transaction function", () => {
      const db = memory();
      expect(() => db.transaction(async () => 1)).toThrow(SqliteError);
      expect(db.inTransaction).toBe(false);
    });
  });

  describe("migrate", () => {
    run("applies migrations in name order, once", () => {
      const db = memory();
      expect(migrate(db, "app", [M2, M1]).applied).toEqual(["0001_init.sql", "0002_entry.sql"]);
      expect(migrate(db, "app", [M1, M2]).applied).toEqual([]);
      expect(migrate(db, "app", [M1, M2, M3]).applied).toEqual(["0003_label.sql"]);
      const rows = db.all<{ scope: string; name: string; checksum: string }>("SELECT scope, name, checksum FROM schema_migrations ORDER BY name");
      expect(rows.map((r) => r.name)).toEqual(["0001_init.sql", "0002_entry.sql", "0003_label.sql"]);
      expect(rows.every((r) => /^[0-9a-f]{64}$/.test(r.checksum))).toBe(true);
    });

    run("keeps scopes apart", () => {
      const db = memory();
      migrate(db, "app", [M1]);
      expect(migrate(db, "other", [{ name: "0001_init.sql", sql: "CREATE TABLE other (id INTEGER);" }]).applied).toEqual(["0001_init.sql"]);
      expect(migrate(db, "app", [M1]).applied).toEqual([]);
    });

    run("reads a folder of .sql files, and CRLF line endings do not count as a change", () => {
      const dir = join(tempDir(), "migrations");
      mkdirSync(dir);
      writeFileSync(join(dir, "0002_entry.sql"), M2.sql);
      writeFileSync(join(dir, "0001_init.sql"), M1.sql);
      writeFileSync(join(dir, "notes.txt"), "not a migration");
      const db = memory();
      expect(migrate(db, "app", dir).applied).toEqual(["0001_init.sql", "0002_entry.sql"]);
      writeFileSync(join(dir, "0001_init.sql"), M1.sql.replace(/\n/g, "\r\n"));
      expect(migrate(db, "app", dir).applied).toEqual([]);
    });

    run("rolls back a failing migration and the ones after it do not run", () => {
      const db = memory();
      const bad: Migration = { name: "0002_bad.sql", sql: "CREATE TABLE half (id INTEGER); INSERT INTO nowhere VALUES (1);" };
      expect(() => migrate(db, "app", [M1, bad, M3])).toThrow(/nowhere/);
      expect(db.get("SELECT 1 FROM sqlite_master WHERE name = 'half'")).toBeUndefined();
      expect(db.all("SELECT name FROM schema_migrations")).toHaveLength(1);
      expect(Number(db.get<{ foreign_keys: number }>("PRAGMA foreign_keys")?.foreign_keys)).toBe(1);
    });

    run("rebuilds a table with foreign keys off, and refuses one that breaks them", () => {
      const db = memory();
      migrate(db, "app", [M1, M2]);
      db.run("INSERT INTO account (id, name) VALUES ('a', 'A')");
      db.run("INSERT INTO entry (account_id, amount) VALUES ('a', 5)");
      const rebuild: Migration = {
        name: "0003_rebuild.sql",
        sql: "CREATE TABLE account_new (id TEXT PRIMARY KEY, name TEXT NOT NULL, closed INTEGER NOT NULL DEFAULT 0); INSERT INTO account_new (id, name) SELECT id, name FROM account; DROP TABLE account; ALTER TABLE account_new RENAME TO account;",
      };
      expect(migrate(db, "app", [M1, M2, rebuild]).applied).toEqual(["0003_rebuild.sql"]);
      const orphan: Migration = { name: "0004_orphan.sql", sql: "DELETE FROM account;" };
      expect(() => migrate(db, "app", [M1, M2, rebuild, orphan])).toThrow(expect.objectContaining({ code: "MIGRATION_FOREIGN_KEYS" }));
      expect(db.get("SELECT 1 FROM account")).toBeDefined();
    });

    run("refuses to run inside a transaction, where a table rebuild would cascade", () => {
      const db = memory();
      const parent: Migration = {
        name: "0001_parent.sql",
        sql: "CREATE TABLE account (id TEXT PRIMARY KEY); CREATE TABLE entry (id INTEGER PRIMARY KEY, account_id TEXT REFERENCES account(id) ON DELETE CASCADE); INSERT INTO account VALUES ('a'); INSERT INTO entry (account_id) VALUES ('a'), ('a');",
      };
      const rebuild: Migration = {
        name: "0002_rebuild.sql",
        sql: "CREATE TABLE account_new (id TEXT PRIMARY KEY, name TEXT); INSERT INTO account_new (id) SELECT id FROM account; DROP TABLE account; ALTER TABLE account_new RENAME TO account;",
      };
      migrate(db, "app", [parent]);
      expect(() => db.transaction(() => migrate(db, "app", [parent, rebuild]))).toThrow(expect.objectContaining({ code: "MIGRATION_IN_TRANSACTION" }));
      // A transaction begun outside db.transaction is caught as well.
      db.exec("BEGIN");
      expect(() => migrate(db, "app", [parent, rebuild])).toThrow(expect.objectContaining({ code: "MIGRATION_IN_TRANSACTION" }));
      db.exec("ROLLBACK");
      expect(Number(db.get<{ foreign_keys: number }>("PRAGMA foreign_keys")?.foreign_keys)).toBe(1);
      expect(migrate(db, "app", [parent, rebuild]).applied).toEqual(["0002_rebuild.sql"]);
      expect(Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM entry")?.n)).toBe(2);
    });

    run("skips a migration that another connection applied while this one waited for the lock", () => {
      const path = join(tempDir(), "app.db");
      const a = openDatabase(path, { driver: d, idleCheckpointMs: 0 });
      const b = openDatabase(path, { driver: d, idleCheckpointMs: 0 });
      // b has read schema_migrations; a migrates before b gets the write lock.
      const transaction = b.transaction.bind(b);
      let raced = false;
      b.transaction = <T>(fn: () => T): T => {
        if (!raced) {
          raced = true;
          expect(migrate(a, "app", [M1, M2]).applied).toEqual(["0001_init.sql", "0002_entry.sql"]);
        }
        return transaction(fn);
      };
      expect(migrate(b, "app", [M1, M2]).applied).toEqual([]);
      expect(b.all("SELECT name FROM schema_migrations")).toHaveLength(2);
    });

    run("refuses with SCHEMA_DRIFT when an applied migration changed", () => {
      const db = memory();
      migrate(db, "app", [M1, M2]);
      const changed = { ...M1, sql: "CREATE TABLE account (id TEXT PRIMARY KEY, name TEXT);\n" };
      expect(() => migrate(db, "app", [changed, M2])).toThrow(expect.objectContaining({ code: "SCHEMA_DRIFT", message: expect.stringContaining("0001_init.sql") }));
    });

    run("refuses with SCHEMA_DRIFT when a new migration sorts before an applied one", () => {
      const db = memory();
      migrate(db, "app", [M1, M3]);
      expect(() => migrate(db, "app", [M1, M2, M3])).toThrow(expect.objectContaining({ code: "SCHEMA_DRIFT", message: expect.stringContaining("0002_entry.sql") }));
    });

    run("refuses with NEWER_DATABASE when the database has migrations this version does not have", () => {
      const db = memory();
      migrate(db, "app", [M1, M2, M3]);
      expect(() => migrate(db, "app", [M1, M2])).toThrow(expect.objectContaining({ code: "NEWER_DATABASE", message: expect.stringContaining("0003_label.sql") }));
      // Nothing was changed by the refusal.
      expect(db.all("SELECT name FROM schema_migrations")).toHaveLength(3);
    });

    run("takes over a schema_migrations table without checksums (@memex/schema 0.1)", () => {
      const db = memory();
      db.exec("CREATE TABLE schema_migrations (scope TEXT NOT NULL, name TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT 'x', PRIMARY KEY (scope, name))");
      db.exec(M1.sql);
      db.run("INSERT INTO schema_migrations (scope, name) VALUES ('app', ?)", M1.name);
      expect(migrate(db, "app", [M1, M2]).applied).toEqual(["0002_entry.sql"]);
      expect(db.get<{ checksum: string | null }>("SELECT checksum FROM schema_migrations WHERE name = ?", M1.name)?.checksum).toMatch(/^[0-9a-f]{64}$/);
    });

    run("assertSchemaMatches refuses a schema changed outside the migrations", () => {
      const db = memory();
      const prepare = (target: SqliteDatabase) => migrate(target, "app", [M1, M2]);
      prepare(db);
      expect(() => assertSchemaMatches(db, prepare)).not.toThrow();
      db.exec("CREATE INDEX entry_amount ON entry(amount)");
      expect(() => assertSchemaMatches(db, prepare)).toThrow(expect.objectContaining({ code: "SCHEMA_DRIFT", message: expect.stringContaining("unexpected index entry_amount") }));
    });
  });

  describe("change journal", () => {
    function journalDb() {
      const db = memory();
      migrate(db, "app", [M1, M2]);
      installJournal(db);
      db.run("INSERT INTO account (id, name) VALUES ('a', 'Checking')");
      return db;
    }

    run("records inserts, updates and deletes, and undoes them", () => {
      const db = journalDb();
      const { changeId } = recordChange(db, { origin: "user", capability: "entries.add", summary: "Add two entries", input: { n: 2 } }, (journal) => {
        journal.track("account", "a");
        db.run("UPDATE account SET name = 'Main' WHERE id = 'a'");
        journal.track("entry", { account_id: "a" });
        db.run("INSERT INTO entry (id, account_id, amount, note) VALUES (1, 'a', 10, ?)", new Uint8Array([1, 2, 3]));
        db.run("INSERT INTO entry (id, account_id, amount) VALUES (2, 'a', 20)");
      });
      expect(changeId).not.toBeNull();
      const change = getChange(db, changeId!)!;
      expect(change.status).toBe("applied");
      expect(JSON.parse(change.counts_json)).toEqual({ account: { inserted: 0, updated: 1, deleted: 0 }, entry: { inserted: 2, updated: 0, deleted: 0 } });
      const entries = changeEntries(db, changeId!);
      // The updated row keeps only its key and the changed column.
      expect(entries[0]).toEqual({ table: "account", key: { id: "a" }, before: [{ id: "a", name: "Checking" }], after: [{ id: "a", name: "Main" }], partial: true });
      expect(Array.from(entries[1]!.after[0]!.note as Uint8Array)).toEqual([1, 2, 3]);

      const undoId = undoChange(db, changeId!, { origin: "user", capability: "changes.undo" });
      expect(db.get<{ name: string }>("SELECT name FROM account WHERE id = 'a'")?.name).toBe("Checking");
      expect(db.all("SELECT * FROM entry")).toEqual([]);
      expect(getChange(db, changeId!)).toMatchObject({ status: "undone", undone_by: undoId });
      expect(getChange(db, undoId)).toMatchObject({ status: "applied", undoes: changeId });

      // Undoing the undo puts the change back, blob and all.
      undoChange(db, undoId, { origin: "user", capability: "changes.undo" });
      expect(getChange(db, changeId!)?.status).toBe("applied");
      const note = db.get<{ note: Uint8Array }>("SELECT note FROM entry WHERE id = 1")?.note;
      expect(Array.from(note!)).toEqual([1, 2, 3]);
      expect(db.get<{ name: string }>("SELECT name FROM account WHERE id = 'a'")?.name).toBe("Main");
      expect(listChanges(db)).toHaveLength(3);
    });

    run("records nothing when no tracked row changed", () => {
      const db = journalDb();
      const { result, changeId } = recordChange(db, { origin: "api", capability: "noop", summary: "Nothing" }, (journal) => {
        journal.track("account", "a");
        return 42;
      });
      expect(result).toBe(42);
      expect(changeId).toBeNull();
      expect(listChanges(db)).toEqual([]);
    });

    run("rolls back the write and records nothing when the write throws", () => {
      const db = journalDb();
      expect(() =>
        recordChange(db, { origin: "user", capability: "x", summary: "x" }, (journal) => {
          journal.track("account", "a");
          db.run("UPDATE account SET name = 'Gone' WHERE id = 'a'");
          throw new Error("refused");
        }),
      ).toThrow("refused");
      expect(db.get<{ name: string }>("SELECT name FROM account WHERE id = 'a'")?.name).toBe("Checking");
      expect(listChanges(db)).toEqual([]);
    });

    run("refuses to undo a change whose rows changed since", () => {
      const db = journalDb();
      const { changeId } = recordChange(db, { origin: "user", capability: "rename", summary: "Rename" }, (journal) => {
        journal.track("account", "a");
        db.run("UPDATE account SET name = 'Main' WHERE id = 'a'");
      });
      db.run("UPDATE account SET name = 'Later' WHERE id = 'a'");
      expect(() => undoChange(db, changeId!, { origin: "user", capability: "changes.undo" })).toThrow(expect.objectContaining({ code: "conflict" }));
      expect(getChange(db, changeId!)?.status).toBe("applied");
    });

    run("refuses to undo a change when later rows refer to rows it created", () => {
      const db = journalDb();
      const { changeId } = recordChange(db, { origin: "user", capability: "accounts.add", summary: "Add account b" }, (journal) => {
        journal.track("account", "b");
        db.run("INSERT INTO account (id, name) VALUES ('b', 'Savings')");
      });
      db.run("INSERT INTO entry (account_id, amount) VALUES ('b', 1)");
      expect(() => undoChange(db, changeId!, { origin: "user", capability: "changes.undo" })).toThrow(expect.objectContaining({ code: "conflict", message: expect.stringContaining("entry") }));
      expect(db.get("SELECT 1 FROM account WHERE id = 'b'")).toBeDefined();
    });

    run("tracks rows by condition, refuses unknown tables, and keeps final changes without rows", () => {
      const db = journalDb();
      db.run("INSERT INTO entry (account_id, amount) VALUES ('a', 1), ('a', 2), ('a', 3)");
      const journal = new ChangeJournal(db);
      expect(journal.trackWhere("entry", "amount >= ?", [2])).toBe(2);
      expect(() => journal.track("missing", 1)).toThrow(JournalError);
      db.transaction(() => {
        db.run("DELETE FROM entry WHERE amount >= 2");
        const rows = journal.finish();
        expect(journal.preview(rows).counts).toEqual({ entry: { inserted: 0, updated: 0, deleted: 2 } });
        journal.record({ origin: "agent", capability: "bulk", summary: "Bulk delete", rows, status: "final" });
      });
      expect(changeEntries(db, journal.changeId)).toEqual([]);
      expect(() => undoChange(db, journal.changeId, { origin: "user", capability: "changes.undo" })).toThrow(expect.objectContaining({ code: "not-undoable" }));
    });

    run("undoes an update on a table whose primary key is a blob", () => {
      const db = memory();
      migrate(db, "app", [
        {
          name: "0001_file.sql",
          sql: "CREATE TABLE file (hash BLOB PRIMARY KEY, name TEXT NOT NULL, size INTEGER NOT NULL); CREATE TABLE tag (hash BLOB NOT NULL REFERENCES file(hash) ON DELETE CASCADE, tag TEXT NOT NULL);",
        },
      ]);
      installJournal(db);
      const hash = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
      db.run("INSERT INTO file (hash, name, size) VALUES (?, 'a.jpg', 100)", hash);
      db.run("INSERT INTO tag (hash, tag) VALUES (?, 'holiday')", hash);
      const { changeId } = recordChange(db, { origin: "user", capability: "files.rename", summary: "Rename" }, (journal) => {
        journal.track("file", { hash });
        db.run("UPDATE file SET name = 'b.jpg' WHERE hash = ?", hash);
      });
      expect(changeEntries(db, changeId!)[0]!.partial).toBe(true);
      undoChange(db, changeId!, { origin: "user", capability: "changes.undo" });
      expect(db.get<{ name: string; size: number }>("SELECT name, size FROM file WHERE hash = ?", hash)).toMatchObject({ name: "a.jpg", size: 100 });
      expect(db.all("SELECT tag FROM tag")).toHaveLength(1);
    });

    run("keeps integers above 2^53 exactly", () => {
      const db = memory();
      migrate(db, "app", [{ name: "0001_photo.sql", sql: "CREATE TABLE photo (id TEXT PRIMARY KEY, phash INTEGER, size INTEGER);" }]);
      installJournal(db);
      const big = 9007199254740993n;
      db.run("INSERT INTO photo (id, phash, size) VALUES ('p1', ?, 5)", big);
      const { changeId } = recordChange(db, { origin: "user", capability: "photos.delete", summary: "Delete" }, (journal) => {
        journal.track("photo", "p1");
        db.run("DELETE FROM photo WHERE id = 'p1'");
      });
      // Integers that fit a number stay numbers.
      expect(changeEntries(db, changeId!)[0]!.before).toEqual([{ id: "p1", phash: big, size: 5 }]);
      undoChange(db, changeId!, { origin: "user", capability: "changes.undo" });
      expect(db.get<{ v: string }>("SELECT CAST(phash AS TEXT) AS v FROM photo WHERE id = 'p1'")?.v).toBe(big.toString());
      // trackWhere reads exactly too.
      const journal = new ChangeJournal(db);
      expect(journal.trackWhere("photo", "id = ?", ["p1"])).toBe(1);
      db.transaction(() => {
        db.run("UPDATE photo SET size = 6 WHERE id = 'p1'");
        expect(journal.finish()[0]!.before).toEqual([{ id: "p1", phash: big, size: 5 }]);
      });
    });

    run("prunes changes before a cutoff", () => {
      const db = journalDb();
      const { changeId } = recordChange(db, { origin: "user", capability: "rename", summary: "Rename" }, (journal) => {
        journal.track("account", "a");
        db.run("UPDATE account SET name = 'Main' WHERE id = 'a'");
      });
      db.run("UPDATE memex_change SET created_at = '2020-01-01T00:00:00.000Z' WHERE id = ?", changeId!);
      const pruned = pruneJournal(db, "2021-01-01T00:00:00.000Z");
      expect(pruned.changes).toBe(1);
      expect(pruned.bytes).toBeGreaterThan(0);
      expect(listChanges(db)).toEqual([]);
    });
  });

  describe("checkpoints", () => {
    // A copy of only the main file is what a backup tool sees when it skips the WAL.
    function mainFileHas(path: string, id: string): boolean {
      const copy = `${path}.copy`;
      copyFileSync(path, copy);
      const reader = openDatabase(copy, { driver: d, readonly: true });
      try {
        return reader.get("SELECT 1 FROM sqlite_master WHERE name = 'account'") !== undefined && reader.get("SELECT 1 FROM account WHERE id = ?", id) !== undefined;
      } finally {
        reader.close();
        rmSync(copy);
      }
    }

    run("checkpoint() copies the WAL into the database file", () => {
      const path = join(tempDir(), "app.db");
      const db = openDatabase(path, { driver: d, idleCheckpointMs: 0 });
      migrate(db, "app", [M1]);
      db.run("INSERT INTO account (id, name) VALUES ('a', 'A')");
      expect(mainFileHas(path, "a")).toBe(false);
      const result = db.checkpoint();
      expect(result.busy).toBe(0);
      expect(result.checkpointed).toBe(result.log);
      expect(mainFileHas(path, "a")).toBe(true);
    });

    run("checkpoints when the connection is idle after a write", async () => {
      const path = join(tempDir(), "app.db");
      const db = openDatabase(path, { driver: d, idleCheckpointMs: 20 });
      migrate(db, "app", [M1]);
      db.run("INSERT INTO account (id, name) VALUES ('a', 'A')");
      expect(mainFileHas(path, "a")).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(mainFileHas(path, "a")).toBe(true);
      db.close();
    });

    run("close() and the exit hook truncate the WAL", () => {
      const path = join(tempDir(), "app.db");
      const db = openDatabase(path, { driver: d, idleCheckpointMs: 0 });
      migrate(db, "app", [M1]);
      db.run("INSERT INTO account (id, name) VALUES ('a', 'A')");
      expect(statSync(`${path}-wal`).size).toBeGreaterThan(0);
      // A second connection stays open, so SQLite does not checkpoint and remove
      // the WAL on the last close: the truncation is close()'s own.
      const other = openDatabase(path, { driver: d, idleCheckpointMs: 0 });
      expect(other.get("SELECT 1 FROM account WHERE id = 'a'")).toBeDefined();
      db.close();
      expect(db.isOpen).toBe(false);
      expect(statSync(`${path}-wal`).size).toBe(0);
      expect(mainFileHas(path, "a")).toBe(true);
      expect(() => db.exec("SELECT 1")).toThrow(expect.objectContaining({ code: "CLOSED" }));
      db.close(); // twice does nothing
      other.run("INSERT INTO account (id, name) VALUES ('b', 'B')");
      closeOpenDatabases(); // what process exit runs
      expect(other.isOpen).toBe(false);
      expect(existsSync(`${path}-wal`) ? statSync(`${path}-wal`).size : 0).toBe(0);
      expect(mainFileHas(path, "b")).toBe(true);
    });

    run("registers the exit hook", () => {
      memory();
      expect(process.listeners("exit")).toContain(closeOpenDatabases);
    });
  });

  it.runIf(!driver)(`${name} is not installed here; its tests are skipped`, () => {
    expect(driver).toBeUndefined();
  });
});
