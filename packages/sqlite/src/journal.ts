// The change journal, from Finance's journal.ts. A write calls track(table, key)
// before it changes, inserts, or deletes rows; the journal keeps the rows as
// they were and, when the write is done, as they are, and records the
// difference in memex_change and memex_change_data. undoChange puts the rows
// back.
//
// A key is the primary key value of a table with a one-column primary key, or
// an object of column values ({ transaction_id: id } tracks every label row of
// one transaction). The rows a key matches are kept as an array.
//
// Storage stays small: a row that was updated keeps only its key and the
// columns that changed; inserted and deleted rows keep the whole row. The
// entries of one change are stored as deflated JSON in chunks.
import { randomUUID } from "node:crypto";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import type { SqliteDatabase } from "./database.js";
import type { SqlValue, SqliteStatement } from "./driver.js";
import { JournalError } from "./errors.js";
import { migrate, type Migration, type MigrationResult } from "./migrate.js";

export type Row = Record<string, unknown>;
export type Key = string | number | Record<string, unknown>;
/**
 * The rows one key matched before and after a change. partial: one row was
 * updated, and before and after hold only its primary key and the columns that
 * changed.
 */
export interface ChangedRows {
  table: string;
  key: Record<string, unknown>;
  before: Row[];
  after: Row[];
  partial?: boolean;
}

export const JOURNAL_SCOPE = "memex-sqlite.journal";

export const JOURNAL_MIGRATIONS: readonly Migration[] = [
  {
    name: "0001_change_journal.sql",
    sql: `-- memex_change is one write; memex_change_data holds its rows in chunks of
-- deflated JSON. counts_json holds the inserted, updated, and deleted rows per
-- table, so listing changes does not read the rows.
CREATE TABLE memex_change (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  origin TEXT NOT NULL,
  capability TEXT NOT NULL,
  summary TEXT NOT NULL,
  input_json TEXT NOT NULL,
  -- applied: in effect; undone: reverted by a later change; final: recorded without row images, cannot be undone.
  status TEXT NOT NULL DEFAULT 'applied' CHECK (status IN ('applied', 'undone', 'final')),
  undone_by TEXT REFERENCES memex_change(id),
  undoes TEXT REFERENCES memex_change(id),
  counts_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX memex_change_created ON memex_change(created_at);
CREATE TABLE memex_change_data (
  change_id TEXT NOT NULL REFERENCES memex_change(id),
  seq INTEGER NOT NULL,
  entries BLOB NOT NULL,
  PRIMARY KEY (change_id, seq)
);
`,
  },
];

/** Makes the journal tables (scope memex-sqlite.journal). */
export function installJournal(db: SqliteDatabase): MigrationResult {
  return migrate(db, JOURNAL_SCOPE, JOURNAL_MIGRATIONS);
}

export type ChangeStatus = "applied" | "undone" | "final";

export interface ChangeRecord {
  id: string;
  created_at: string;
  origin: string;
  capability: string;
  summary: string;
  input_json: string;
  status: ChangeStatus;
  undone_by: string | null;
  undoes: string | null;
  counts_json: string;
}

interface TableInfo {
  columns: Set<string>;
  pk: string[];
}
const tables = new WeakMap<SqliteDatabase, Map<string, TableInfo>>();

/** Columns and primary key of a table, checked against the schema so names are safe to quote into SQL. */
export function tableInfo(db: SqliteDatabase, table: string): TableInfo {
  let cache = tables.get(db);
  if (!cache) tables.set(db, (cache = new Map()));
  let info = cache.get(table);
  if (!info) {
    if (!db.get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", table)) {
      throw new JournalError("invalid-key", `The journal cannot track ${table}: there is no such table.`);
    }
    const cols = db.all<{ name: string; pk: number }>("SELECT name, pk FROM pragma_table_info(?)", table);
    info = {
      columns: new Set(cols.map((c) => c.name)),
      pk: cols
        .filter((c) => c.pk > 0)
        .sort((a, b) => a.pk - b.pk)
        .map((c) => c.name),
    };
    cache.set(table, info);
  }
  return info;
}

const q = (name: string) => `"${name.replace(/"/g, '""')}"`;
const same = (a: unknown, b: unknown) =>
  a === b || (a !== null && b !== null && typeof a === "object" && typeof b === "object" && JSON.stringify(encode(a)) === JSON.stringify(encode(b)));
// encode makes a Buffer (better-sqlite3) and a Uint8Array (from the stored JSON) with the same bytes one id.
const keyOfRow = (pk: string[]) =>
  pk.length === 1 ? (row: Row) => JSON.stringify(encode(row[pk[0]!])) : (row: Row) => JSON.stringify(pk.map((c) => encode(row[c])));
const values = (list: unknown[]) => list as SqlValue[];

// Blobs and big integers do not survive JSON as they are; they are stored as tagged objects.
function encode(value: unknown): unknown {
  if (value instanceof Uint8Array) return { $blob: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("base64") };
  if (typeof value === "bigint") return { $bigint: value.toString() };
  return value;
}
function decode(value: unknown): unknown {
  if (value !== null && typeof value === "object") {
    const tagged = value as { $blob?: string; $bigint?: string };
    if (typeof tagged.$blob === "string") return new Uint8Array(Buffer.from(tagged.$blob, "base64"));
    if (typeof tagged.$bigint === "string") return BigInt(tagged.$bigint);
  }
  return value;
}
const encodeRow = (row: Row): Row => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, encode(v)]));
const decodeRow = (row: Row): Row => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, decode(v)]));

function normalizeKey(db: SqliteDatabase, table: string, key: Key): Record<string, unknown> {
  const info = tableInfo(db, table);
  if (typeof key !== "object" || key === null) {
    if (info.pk.length !== 1) {
      throw new JournalError("invalid-key", `${table} has a ${info.pk.length}-column key; track it with an object of column values.`);
    }
    return { [info.pk[0]!]: key };
  }
  const entries = Object.entries(key);
  if (!entries.length) throw new JournalError("invalid-key", `Name at least one column to track rows of ${table}.`);
  for (const [column] of entries) {
    if (!info.columns.has(column)) throw new JournalError("invalid-key", `${table} has no column ${column}.`);
  }
  // Sorted, so one key always has one JSON spelling.
  return Object.fromEntries(entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

// The journal reads integers as bigints, so that a value above 2^53 is kept
// exactly; a value that fits a number comes back as a number.
const exactStatements = new WeakMap<SqliteDatabase, Map<string, SqliteStatement>>();
function readExact(db: SqliteDatabase, sql: string, params: SqlValue[]): Row[] {
  let cache = exactStatements.get(db);
  if (!cache) exactStatements.set(db, (cache = new Map()));
  let statement = cache.get(sql);
  if (!statement) {
    statement = db.prepare(sql);
    statement.readBigInts?.(true);
    cache.set(sql, statement);
  }
  return (statement.all(...params) as Row[]).map(toNumbers);
}
const toNumbers = (row: Row): Row =>
  Object.fromEntries(
    Object.entries(row).map(([k, v]) => [k, typeof v === "bigint" && v >= MIN_SAFE && v <= MAX_SAFE ? Number(v) : v]),
  );
const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/** The rows a key matches, in primary key order. Integers above 2^53 come back as bigints. */
export function selectRows(db: SqliteDatabase, table: string, key: Record<string, unknown>): Row[] {
  const info = tableInfo(db, table);
  const where = Object.keys(key)
    .map((c) => `${q(c)} IS ?`)
    .join(" AND ");
  const order = (info.pk.length ? info.pk : ["rowid"]).map(q).join(", ");
  return readExact(db, `SELECT * FROM ${q(table)} WHERE ${where} ORDER BY ${order}`, values(Object.values(key)));
}

/**
 * Makes the rows a key matches equal `rows`: deletes the extra ones, updates the
 * changed ones, inserts the missing ones. A row may hold only some columns (its
 * primary key and the columns to set); the others keep their values.
 */
export function restoreRows(db: SqliteDatabase, table: string, key: Record<string, unknown>, rows: Row[]): void {
  const info = tableInfo(db, table);
  const pk = info.pk.length ? info.pk : [...info.columns];
  const id = keyOfRow(pk);
  const wanted = new Set(rows.map(id));
  const byPk = pk.map((c) => `${q(c)} IS ?`).join(" AND ");
  const current = new Set<string>();
  for (const row of selectRows(db, table, key)) {
    const k = id(row);
    if (wanted.has(k)) current.add(k);
    else db.run(`DELETE FROM ${q(table)} WHERE ${byPk}`, ...values(pk.map((c) => row[c])));
  }
  for (const row of rows) {
    const cols = Object.keys(row).filter((c) => info.columns.has(c));
    // A row the key no longer matches may still exist under its primary key.
    const exists = current.has(id(row)) || db.get(`SELECT 1 FROM ${q(table)} WHERE ${byPk}`, ...values(pk.map((c) => row[c])));
    if (exists) {
      const set = cols.filter((c) => !pk.includes(c));
      if (set.length) {
        db.run(
          `UPDATE ${q(table)} SET ${set.map((c) => `${q(c)} = ?`).join(", ")} WHERE ${byPk}`,
          ...values([...set.map((c) => row[c]), ...pk.map((c) => row[c])]),
        );
      }
    } else {
      db.run(
        `INSERT INTO ${q(table)} (${cols.map(q).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
        ...values(cols.map((c) => row[c])),
      );
    }
  }
}

/** Whether two row arrays hold the same values (column order may differ). */
export function sameRows(a: Row[], b: Row[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((row, i) => {
    const other = b[i]!;
    const keys = Object.keys(row);
    return keys.length === Object.keys(other).length && keys.every((k) => k in other && same(row[k], other[k]));
  });
}

/** Whether the rows a key matches now are the rows a change left (for a partial entry: the changed columns still hold their new values). */
export function stillAfter(db: SqliteDatabase, entry: ChangedRows): boolean {
  const now = selectRows(db, entry.table, entry.key);
  if (!entry.partial) return sameRows(now, entry.after);
  const after = entry.after[0]!;
  return now.length === 1 && Object.keys(after).every((c) => same(now[0]![c], after[c]));
}

export interface PreviewItem {
  op: "insert" | "update" | "delete";
  table: string;
  key: Record<string, unknown>;
  row?: Row;
  changes?: Record<string, { before: unknown; after: unknown }>;
}
export type ChangeCounts = Record<string, { inserted: number; updated: number; deleted: number }>;

/** Counts per table and operation, and a sample of row changes (updates show only the changed columns). */
export function describeChanges(db: SqliteDatabase, rows: ChangedRows[], sample = 10): { counts: ChangeCounts; sample: PreviewItem[] } {
  const counts: ChangeCounts = {};
  const items: PreviewItem[] = [];
  for (const entry of rows) {
    const info = tableInfo(db, entry.table);
    const pk = info.pk.length ? info.pk : [...info.columns];
    const id = keyOfRow(pk);
    const before = new Map(entry.before.map((r) => [id(r), r]));
    const after = new Map(entry.after.map((r) => [id(r), r]));
    const count = (counts[entry.table] ??= { inserted: 0, updated: 0, deleted: 0 });
    const keyOf = (row: Row) => Object.fromEntries(pk.map((c) => [c, row[c]]));
    for (const [k, row] of after) {
      const old = before.get(k);
      if (!old) {
        count.inserted += 1;
        if (items.length < sample) items.push({ op: "insert", table: entry.table, key: keyOf(row), row });
        continue;
      }
      let changes: Record<string, { before: unknown; after: unknown }> | null = null;
      for (const c of Object.keys(row)) if (!same(row[c], old[c])) (changes ??= {})[c] = { before: old[c], after: row[c] };
      if (changes) {
        count.updated += 1;
        if (items.length < sample) items.push({ op: "update", table: entry.table, key: keyOf(row), changes });
      }
    }
    for (const [k, row] of before) {
      if (after.has(k)) continue;
      count.deleted += 1;
      if (items.length < sample) items.push({ op: "delete", table: entry.table, key: keyOf(row), row });
    }
  }
  return { counts, sample: items };
}

/** One updated row reduced to its key and changed columns; other entries unchanged. */
function compact(db: SqliteDatabase, entry: ChangedRows): ChangedRows {
  if (entry.before.length !== 1 || entry.after.length !== 1) return entry;
  const { pk } = tableInfo(db, entry.table);
  const before = entry.before[0]!;
  const after = entry.after[0]!;
  if (!pk.length || pk.some((c) => !same(before[c], after[c]))) return entry;
  const b: Row = {};
  const a: Row = {};
  for (const c of pk) {
    b[c] = before[c];
    a[c] = after[c];
  }
  for (const c of Object.keys(after)) {
    if (!pk.includes(c) && !same(before[c], after[c])) {
      b[c] = before[c];
      a[c] = after[c];
    }
  }
  return { table: entry.table, key: entry.key, before: [b], after: [a], partial: true };
}

/** Entries per stored chunk; each chunk is one deflated JSON array. */
const CHUNK = 2000;

interface StoredEntry {
  t: string;
  k: Row;
  b: Row[];
  a: Row[];
  p?: 1;
}

/** The rows a recorded change touched, in tracking order. */
export function changeEntries(db: SqliteDatabase, changeId: string): ChangedRows[] {
  const out: ChangedRows[] = [];
  for (const { entries } of db.all<{ entries: Uint8Array }>("SELECT entries FROM memex_change_data WHERE change_id = ? ORDER BY seq", changeId)) {
    for (const e of JSON.parse(inflateRawSync(entries).toString("utf8")) as StoredEntry[]) {
      out.push({ table: e.t, key: decodeRow(e.k), before: e.b.map(decodeRow), after: e.a.map(decodeRow), ...(e.p ? { partial: true } : {}) });
    }
  }
  return out;
}

/** One recorded change, or undefined. */
export function getChange(db: SqliteDatabase, changeId: string): ChangeRecord | undefined {
  return db.get<ChangeRecord>("SELECT * FROM memex_change WHERE id = ?", changeId);
}

/** Recorded changes, newest first. */
export function listChanges(db: SqliteDatabase, options: { limit?: number; offset?: number } = {}): ChangeRecord[] {
  return db.all<ChangeRecord>(
    "SELECT * FROM memex_change ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?",
    options.limit ?? 50,
    options.offset ?? 0,
  );
}

/**
 * Deletes the changes made before a cutoff (an ISO timestamp) with their row
 * images; they can no longer be undone. Returns how many changes and how many
 * stored bytes went.
 */
export function pruneJournal(db: SqliteDatabase, before: string): { changes: number; bytes: number } {
  return db.transaction(() => {
    const old = "SELECT id FROM memex_change WHERE created_at < ?";
    const bytes = Number(db.get<{ n: number }>(`SELECT COALESCE(SUM(LENGTH(entries)), 0) AS n FROM memex_change_data WHERE change_id IN (${old})`, before)!.n);
    db.run(`DELETE FROM memex_change_data WHERE change_id IN (${old})`, before);
    db.run(`UPDATE memex_change SET undoes = NULL WHERE undoes IN (${old})`, before);
    db.run(`UPDATE memex_change SET undone_by = NULL WHERE undone_by IN (${old})`, before);
    const { changes } = db.run("DELETE FROM memex_change WHERE created_at < ?", before);
    return { changes: Number(changes), bytes };
  });
}

/** The ISO timestamp `days` days before now. */
export const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

export interface ChangeInfo {
  /** Who asked for the write, for example user, agent, or api. */
  origin: string;
  /** What made the write, for example a capability id. */
  capability: string;
  summary: string;
  input?: unknown;
}

export class ChangeJournal {
  /** The id this change will be recorded under. */
  readonly changeId = randomUUID();
  /** Set by undoChange: the change this one reverts. */
  undoes: string | null = null;
  private readonly entries = new Map<string, { table: string; key: Record<string, unknown>; before: Row[] }>();

  constructor(private readonly db: SqliteDatabase) {}

  /** Keeps the rows a key matches as they are now. Call before changing, inserting (the key of the new row), or deleting. Repeats are ignored. */
  track(table: string, key: Key): void {
    const norm = normalizeKey(this.db, table, key);
    const id = `${table}\u0000${JSON.stringify(encodeRow(norm))}`;
    if (!this.entries.has(id)) this.entries.set(id, { table, key: norm, before: selectRows(this.db, table, norm) });
  }

  /** Records the rows a key matched before a change that already happened. Ignored when the key is tracked already. */
  trackBefore(table: string, key: Key, before: Row[]): void {
    const norm = normalizeKey(this.db, table, key);
    const id = `${table}\u0000${JSON.stringify(encodeRow(norm))}`;
    if (!this.entries.has(id)) this.entries.set(id, { table, key: norm, before });
  }

  trackMany(table: string, keys: Iterable<Key>): void {
    for (const key of keys) this.track(table, key);
  }

  /**
   * Tracks every row a condition selects now, by primary key (rows it selects
   * later are not tracked: track new rows by their key). where is SQL after
   * WHERE, with ? parameters. Returns the number of rows.
   */
  trackWhere(table: string, where: string, params: SqlValue[] = []): number {
    const info = tableInfo(this.db, table);
    if (!info.pk.length) throw new JournalError("invalid-key", `${table} has no primary key; track its rows with column values.`);
    const rows = readExact(this.db, `SELECT * FROM ${q(table)} WHERE ${where}`, params);
    for (const row of rows) {
      const key = Object.fromEntries(info.pk.map((c) => [c, row[c]]));
      this.trackBefore(table, info.pk.length === 1 ? (row[info.pk[0]!] as Key) : key, [row]);
    }
    return rows.length;
  }

  /** The tracked keys whose rows changed, with before and after rows, in tracking order. */
  finish(): ChangedRows[] {
    const out: ChangedRows[] = [];
    for (const entry of this.entries.values()) {
      const after = selectRows(this.db, entry.table, entry.key);
      if (!sameRows(entry.before, after)) out.push({ ...entry, after });
    }
    return out;
  }

  preview(rows: ChangedRows[]) {
    return describeChanges(this.db, rows);
  }

  /** Writes the change and its rows. A final change keeps no row images and cannot be undone. Returns the change id. */
  record(change: ChangeInfo & { rows: ChangedRows[]; status?: "applied" | "final" }): string {
    const status = change.status ?? "applied";
    const { counts } = describeChanges(this.db, change.rows, 0);
    this.db.run(
      "INSERT INTO memex_change (id, origin, capability, summary, input_json, status, undoes, counts_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      this.changeId,
      change.origin,
      change.capability,
      change.summary,
      JSON.stringify(change.input ?? null),
      status,
      this.undoes,
      JSON.stringify(counts),
    );
    if (status !== "applied") return this.changeId;
    for (let i = 0, seq = 0; i < change.rows.length; i += CHUNK, seq += 1) {
      const chunk = change.rows
        .slice(i, i + CHUNK)
        .map((r) => compact(this.db, r))
        .map((r): StoredEntry => ({ t: r.table, k: encodeRow(r.key), b: r.before.map(encodeRow), a: r.after.map(encodeRow), ...(r.partial ? { p: 1 as const } : {}) }));
      this.db.run("INSERT INTO memex_change_data (change_id, seq, entries) VALUES (?, ?, ?)", this.changeId, seq, deflateRawSync(JSON.stringify(chunk)));
    }
    return this.changeId;
  }
}

/**
 * Runs a write in a transaction with a journal, and records the change when
 * rows changed. Returns the write's result and the change id (null when
 * nothing changed).
 */
export function recordChange<T>(db: SqliteDatabase, info: ChangeInfo, write: (journal: ChangeJournal) => T): { result: T; changeId: string | null } {
  return db.transaction(() => {
    const journal = new ChangeJournal(db);
    const result = write(journal);
    const rows = journal.finish();
    if (!rows.length && journal.undoes === null) return { result, changeId: null };
    return { result, changeId: journal.record({ ...info, rows }) };
  });
}

/**
 * Reverts one change: every row it touched goes back to how it was before, in
 * one transaction. Refuses (conflict) when a row changed again since, or when
 * other rows still refer to rows it created. The undo is itself a change and
 * can be undone. Returns the id of the undo change.
 */
export function undoChange(db: SqliteDatabase, changeId: string, info: Omit<ChangeInfo, "summary"> & { summary?: string }): string {
  const change = getChange(db, changeId);
  if (!change) throw new JournalError("not-found", `There is no change ${changeId}.`);
  if (change.status === "undone") throw new JournalError("already-undone", `Change ${change.id} was already undone by change ${change.undone_by}. Undo that change to apply it again.`);
  if (change.status === "final") throw new JournalError("not-undoable", `Change ${change.id} (${change.capability}) was recorded without row images and cannot be undone.`);
  const { changeId: undoId } = recordChange(db, { ...info, summary: info.summary ?? `Undo: ${change.summary}`, input: info.input ?? { change_id: change.id } }, (journal) => {
    const rows = changeEntries(db, change.id);
    const moved = rows.filter((r) => !stillAfter(db, r));
    if (moved.length) {
      const first = moved[0]!;
      throw new JournalError(
        "conflict",
        `Change ${change.id} cannot be undone: ${moved.length} of its rows changed since (first: ${first.table} ${JSON.stringify(encodeRow(first.key))}). Undo the later changes first, newest first.`,
      );
    }
    // Rows go back in reverse order; foreign keys are checked once all of them are back.
    db.exec("PRAGMA defer_foreign_keys = ON");
    for (const r of [...rows].reverse()) {
      journal.track(r.table, r.key);
      restoreRows(db, r.table, r.key, r.before);
    }
    const broken = db.all<{ table: string }>("PRAGMA foreign_key_check");
    if (broken.length) {
      throw new JournalError(
        "conflict",
        `Change ${change.id} cannot be undone: ${broken.length} rows in ${[...new Set(broken.map((b) => b.table))].join(", ")} still refer to rows it created. Undo or edit the later changes that use those rows first.`,
      );
    }
    journal.undoes = change.id;
    db.run("UPDATE memex_change SET status = 'undone', undone_by = ? WHERE id = ?", journal.changeId, change.id);
    // Undoing an undo puts the original change back in effect.
    if (change.undoes) db.run("UPDATE memex_change SET status = 'applied', undone_by = NULL WHERE id = ?", change.undoes);
  });
  return undoId!;
}
