import { installJournal, migrate, type Migration, type SqliteDatabase } from "@tjalve/memex-sqlite";
import { migrateCore } from "@tjalve/memex-schema";

/** The migration scope of the import tables. */
export const IMPORT_SCOPE = "memex-import";

export const IMPORT_MIGRATIONS: readonly Migration[] = [
  {
    name: "0001_import_batches.sql",
    sql: `-- One import run. A batch is undone as a whole: each of its files' journal
-- changes is undone, newest first. state: running while it runs; committed when
-- it finished; stopped when it ended early (its finished files stay committed);
-- undone when its changes were undone. owner_pid and owner_host name the process
-- that runs it, so that a running batch whose process is gone is marked stopped.
CREATE TABLE import_batch (
  id TEXT PRIMARY KEY,
  origin TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('running', 'committed', 'stopped', 'undone')),
  roots_json TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  undone_at TEXT,
  totals_json TEXT,
  owner_pid INTEGER,
  owner_host TEXT
);
CREATE INDEX idx_import_batch_started ON import_batch(started_at);

-- Every file a batch found, with its outcome and record counts, so that every
-- input record is accounted for. change_id is the memex_change of the file's
-- commit (null when nothing was written); it has no foreign key, because the
-- journal may be pruned.
CREATE TABLE import_file (
  batch_id TEXT NOT NULL REFERENCES import_batch(id),
  seq INTEGER NOT NULL,
  path TEXT NOT NULL,
  size INTEGER,
  outcome TEXT NOT NULL CHECK (outcome IN ('imported', 'unchanged', 'copy', 'archive', 'unrecognised', 'online-only', 'ignored', 'failed')),
  reason TEXT,
  file_hash TEXT,
  reader TEXT,
  source TEXT,
  records_json TEXT NOT NULL,
  change_id TEXT,
  PRIMARY KEY (batch_id, seq)
);
CREATE INDEX idx_import_file_hash ON import_file(file_hash, reader) WHERE file_hash IS NOT NULL;
`,
  },
  {
    name: "0002_file_keys.sql",
    sql: `-- file_key: what the reader takes from a file besides its bytes (Reader.fileKey), such as
-- the name of a daily file that holds its date. A file is unchanged only when the same bytes
-- with the same key were imported before. forgotten_at: when the app took away what the file
-- gave (Importer.forget), so that the next run reads it again.
ALTER TABLE import_file ADD COLUMN file_key TEXT;
ALTER TABLE import_file ADD COLUMN forgotten_at TEXT;
`,
  },
];

/**
 * Makes everything an import writes to: the core migrations (entity spine and provenance v2), the change
 * journal, and the import tables. Call it outside a transaction, before the app's own migrations that refer to
 * the entity table.
 */
export function setupImport(db: SqliteDatabase): void {
  migrateCore(db);
  installJournal(db);
  migrate(db, IMPORT_SCOPE, IMPORT_MIGRATIONS);
}
