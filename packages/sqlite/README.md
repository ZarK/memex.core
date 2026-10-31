# @tjalve/memex-sqlite

SQLite for Memex apps: `openDatabase` with WAL, a busy timeout, and foreign keys; numbered migrations per scope that refuse a drifted or newer database; the change journal that lists and undoes writes; and WAL checkpoints when the connection is idle and when the process exits.

Memex has no backup, restore, or snapshot features. The checkpoints keep the main database file complete, so that the user's own backup tool copies a whole database.

The library runs on a small synchronous driver interface with two adapters:

- **node:sqlite**, built into Node 22.13 and later. No dependency. The tests use it.
- **better-sqlite3** 13.0.2, an optional peer dependency. The app installs it. The adapter is typed against the small part of its API that it uses, so this package builds without it. Its tests run where better-sqlite3 is installed and built; elsewhere they are skipped.

## Open a database

```ts
import { openDatabase, migrate, installJournal } from "@tjalve/memex-sqlite";
import { nodeSqlite } from "@tjalve/memex-sqlite/node-sqlite";
// or: import Database from "better-sqlite3"; import { betterSqlite3 } from "@tjalve/memex-sqlite";
//     const driver = betterSqlite3(Database);

const db = openDatabase(join(paths.data, "finance.db"), { driver: nodeSqlite });
migrate(db, "finance", fileURLToPath(new URL("../migrations", import.meta.url)));
installJournal(db);
```

`openDatabase(path, options)`:

| Option | Default | |
|---|---|---|
| `driver` | required | `nodeSqlite` or `betterSqlite3(Database)` |
| `readonly` | `false` | A read-only connection does not set WAL or checkpoint. |
| `busyTimeoutMs` | `5000` | How long a statement waits for another connection's lock. |
| `idleCheckpointMs` | `30000` | A passive checkpoint runs this long after the last write; `0` turns it off. |

The returned `SqliteDatabase` has `exec`, `prepare`, `cached` (a statement kept per SQL text), `run`, `get`, `all`, `transaction(fn)`, `checkpoint(mode)`, and `close()`.

- `transaction(fn)` is synchronous. The outer one is `BEGIN IMMEDIATE`, so that two writers in WAL mode wait for each other instead of failing on the lock upgrade; an inner one is a savepoint. It commits when `fn` returns and rolls back when it throws. A function that returns a promise is refused (`ASYNC_TRANSACTION`).
- `close()` runs a `TRUNCATE` checkpoint, then closes. On process exit, every database that is still open is closed the same way (`closeOpenDatabases`). An app that stops on a signal calls `closeOpenDatabases()` or `process.exit()` in its signal handler.

## Migrations

`migrate(db, scope, migrations)` applies the migrations of one scope that the database has not applied. `migrations` is a folder of `.sql` files or a list of `{ name, sql }`. They run in name order (`0001_init.sql`, `0002_...`), each in its own transaction, and are recorded in `schema_migrations` with a SHA-256 of the SQL (line endings do not count). Foreign keys are off while a migration runs, so that a migration can rebuild a table, and `foreign_key_check` must be clean before its transaction commits (`MIGRATION_FOREIGN_KEYS`). A migration file does not contain `BEGIN` or `COMMIT`.

Call `migrate` outside a transaction. SQLite cannot turn foreign keys off inside one, so a table rebuild would cascade and delete child rows; `migrate` refuses instead (`MIGRATION_IN_TRANSACTION`). Two processes can migrate one database at the same time (an app, its CLI, and its MCP server after an update): each migration checks `schema_migrations` again after it has the write lock and skips a migration that the other process applied.

The library refuses a database instead of guessing. Each refusal is a `SqliteError` and changes nothing:

| Code | When |
|---|---|
| `SCHEMA_DRIFT` | A migration file changed after the database applied it, or a new file sorts before a migration that the database already applied. |
| `NEWER_DATABASE` | The database applied migrations of this scope that this version does not have: a newer version of the app wrote it. |
| `MIGRATION_IN_TRANSACTION` | `migrate` was called inside a transaction. |

`assertSchemaMatches(db, prepare)` compares the whole schema with the schema that `prepare` makes in a new in-memory database, and refuses with `SCHEMA_DRIFT` when an object is missing, changed, or unexpected. Use it after the migrations of every scope, when the database must hold nothing else.

A `schema_migrations` table made by `@memex/schema` 0.1 (no checksum column) is taken over: the column is added and filled from the files.

## Change journal

From Finance's journal. A write tracks the rows it is about to change; the journal records what changed in `memex_change` and `memex_change_data` (scope `memex-sqlite.journal`, made by `installJournal`), and `undoChange` puts the rows back.

```ts
const { result, changeId } = recordChange(db, { origin: "user", capability: "accounts.rename", summary: "Rename account", input }, (journal) => {
  journal.track("account", id);              // a one-column primary key
  journal.track("label", { account_id: id }); // or the rows that column values match
  db.run("UPDATE account SET name = ? WHERE id = ?", name, id);
  return { id };
});

undoChange(db, changeId!, { origin: "user", capability: "changes.undo" });
```

- `recordChange` runs the write in a transaction and records a change only when tracked rows changed (`changeId` is `null` otherwise). A write that throws is rolled back and recorded nowhere.
- An updated row keeps only its key and the changed columns; inserted and deleted rows keep the whole row. Blobs and integers above 2^53 are kept exactly: the journal reads integers as bigints and gives back a number when the value fits one.
- `undoChange` refuses (`JournalError`, code `conflict`) when a row changed again since, or when other rows still refer to rows the change created. The undo is itself a change; undoing it puts the original back.
- `ChangeJournal` alone gives `track`, `trackMany`, `trackWhere`, `trackBefore`, `finish`, `preview`, and `record` (status `final` keeps no row images and cannot be undone), for apps that run their own transactions.
- `listChanges`, `getChange`, `changeEntries`, and `pruneJournal(db, daysAgo(90))`.
