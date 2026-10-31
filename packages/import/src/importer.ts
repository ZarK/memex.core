// The import run: walk the roots, detect each file's reader, read and normalize
// its records, hash them, dedupe on provenance (source, content_hash), and write
// the new ones with provenance v2 (batch_id, file_hash, reader).
//
// A preview runs the same writes in one transaction and rolls it back, so it
// shows exactly what a commit would do and changes nothing. A commit writes each
// file in its own transaction, recorded in the change journal; undoing a batch
// undoes those changes, newest first, in one transaction.
//
// From Finance's import (preview and commit of one file, provenance dedupe,
// numbered identical rows) and Health's import (walking folders and archives,
// detection by score, copies counted once, the import record and its undo).
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  getChange,
  recordChange,
  tableInfo,
  undoChange,
  JournalError,
  type ChangeCounts,
  type ChangeJournal,
  type Key,
  type SqlValue,
  type SqliteDatabase,
} from "@tjalve/memex-sqlite";
import { createEntity, findEntityByProvenance, getEntity, link } from "@tjalve/memex-schema";
import type { ListFolderOptions } from "@tjalve/memex-folders";
import { canonicalJson, contentHash, hashChunks, sha256 } from "./hash.js";
import { KEEP_BYTES, RootError, expandArchive, isGzip, isSystemFile, isZip, listRoot, sampleOf, type Entry } from "./walk.js";
import type {
  BatchRow,
  FileOutcome,
  FileReport,
  ImportEntry,
  ImportReport,
  ImportTotals,
  ReadItem,
  ReadSkip,
  Reader,
  RecordCounts,
  UndoResult,
  WriteContext,
} from "./types.js";

export type ImportErrorCode = "invalid-reader" | "not-found" | "already-undone" | "conflict" | "invalid-write";

export class ImportError extends Error {
  constructor(
    readonly code: ImportErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ImportError";
  }
}

export interface ImporterOptions {
  // Readers of different record types are kept in one list.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readers: Reader<any>[];
  /** Who runs the import, for the journal: "user", "agent", "cli". Default "user". */
  origin?: string;
}

export interface RunOptions {
  /** The user confirmed reading online-only files, which downloads them. Default false. */
  allowOnlineOnly?: boolean;
  /** Passed to listFolder: includeHidden, ignore, a backend. */
  listing?: ListFolderOptions;
  /** The lowest detect() score that picks a reader. Default 15. */
  minScore?: number;
  /** Read files again even when the same bytes were imported before. Default false. */
  reread?: boolean;
  signal?: AbortSignal;
  /** Called after each file. */
  onFile?: (file: FileReport) => void;
}

const SAMPLE_RECORDS = 5;
const KEPT_SKIPS = 20;
const READER_ID = /^[a-z0-9][a-z0-9.-]*$/;
const OUTCOMES: FileOutcome[] = ["imported", "unchanged", "copy", "archive", "unrecognised", "online-only", "ignored", "failed"];

const emptyCounts = (): RecordCounts => ({ read: 0, new: 0, duplicate: 0, repeated: 0, skipped: 0 });
const now = () => new Date().toISOString();

/** A file ready to write: its reader, hash, and records, or a report that needs no writing. */
type Prepared =
  | { kind: "done"; report: FileReport }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  | { kind: "read"; path: string; reader: Reader<any>; hash: string; key: string | null; items: ReadItem<any>[]; size: number };

function fileReport(entryPath: string, size: number | null, outcome: FileOutcome, extra: Partial<FileReport> = {}): FileReport {
  return { path: entryPath, size, outcome, records: emptyCounts(), skips: [], sample: [], tables: {}, changeId: null, ...extra };
}

function addCounts(into: ChangeCounts, from: ChangeCounts): void {
  for (const [table, c] of Object.entries(from)) {
    const t = (into[table] ??= { inserted: 0, updated: 0, deleted: 0 });
    t.inserted += c.inserted;
    t.updated += c.updated;
    t.deleted += c.deleted;
  }
}

/** Whether every file has an outcome and every file's records add up, and the totals are the sums of the files. */
export function isAccounted(files: FileReport[], totals: ImportTotals): boolean {
  const sum = emptyCounts();
  for (const f of files) {
    if (!OUTCOMES.includes(f.outcome)) return false;
    const r = f.records;
    if (r.read !== r.new + r.duplicate + r.repeated + r.skipped) return false;
    if ((f.outcome === "imported" || f.outcome === "unchanged") && !f.reader) return false;
    for (const k of Object.keys(sum) as (keyof RecordCounts)[]) sum[k] += r[k];
  }
  const byOutcome = OUTCOMES.reduce((n, o) => n + totals.files[o], 0);
  return (
    totals.files.all === files.length &&
    byOutcome === files.length &&
    (Object.keys(sum) as (keyof RecordCounts)[]).every((k) => sum[k] === totals.records[k])
  );
}

export function totalsOf(files: FileReport[]): ImportTotals {
  const byOutcome = Object.fromEntries(OUTCOMES.map((o) => [o, 0])) as Record<FileOutcome, number>;
  const records = emptyCounts();
  const tables: ChangeCounts = {};
  for (const f of files) {
    byOutcome[f.outcome] += 1;
    for (const k of Object.keys(records) as (keyof RecordCounts)[]) records[k] += f.records[k];
    addCounts(tables, f.tables);
  }
  return { files: { ...byOutcome, all: files.length }, records, tables };
}

/** The batches this process is committing now. */
const RUNNING = new Set<string>();

/** Whether the process that started a running batch is still there. A batch of another computer counts as live. */
function ownerAlive(batchId: string, pid: number | null, host: string | null): boolean {
  if (pid === null || host !== os.hostname()) return true;
  if (pid === process.pid) return RUNNING.has(batchId);
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

class Rollback extends Error {
  constructor(readonly report: ImportReport) {
    super("preview rollback");
  }
}

export class Importer {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly readers: Reader<any>[];
  readonly origin: string;
  /** Where each report of a committed run was written, for archives whose outcome is known later. */
  private readonly placed = new WeakMap<FileReport, { batchId: string; seq: number }>();

  constructor(
    readonly db: SqliteDatabase,
    options: ImporterOptions,
  ) {
    const ids = new Set<string>();
    for (const r of options.readers) {
      if (!READER_ID.test(r.id)) throw new ImportError("invalid-reader", `A reader id is lowercase letters, digits, "." and "-": ${JSON.stringify(r.id)}.`);
      if (!Number.isInteger(r.version) || r.version < 1) throw new ImportError("invalid-reader", `The reader ${r.id} needs a whole version number from 1.`);
      if (!r.source) throw new ImportError("invalid-reader", `The reader ${r.id} needs a provenance source.`);
      if (ids.has(r.id)) throw new ImportError("invalid-reader", `Two readers have the id ${r.id}.`);
      ids.add(r.id);
    }
    this.readers = [...options.readers];
    this.origin = options.origin ?? "user";
  }

  /** Shows what a commit would do, by doing it in one transaction and rolling it back. Nothing is written. */
  async preview(roots: string[], options: RunOptions = {}): Promise<ImportReport> {
    await checkRoots(roots);
    const batchId = randomUUID();
    const startedAt = now();
    const prepared: Prepared[] = [];
    const { warnings, onlineOnly } = await this.prepare(roots, options, async (p) => {
      prepared.push(p);
    });
    try {
      this.db.transaction(() => {
        this.insertBatch(batchId, roots, startedAt);
        const files = prepared.map((p, seq) => {
          const report = this.apply(p, batchId, seq);
          options.onFile?.(report);
          return report;
        });
        throw new Rollback(this.finish("preview", batchId, roots, startedAt, files, warnings, onlineOnly));
      });
    } catch (error) {
      if (error instanceof Rollback) return error.report;
      throw error;
    }
    throw new Error("unreachable");
  }

  /** Imports: each file is written in its own transaction, so a file that fails leaves the others in place. */
  async commit(roots: string[], options: RunOptions = {}): Promise<ImportReport> {
    await checkRoots(roots);
    this.recoverStale();
    const batchId = randomUUID();
    const startedAt = now();
    this.db.transaction(() => this.insertBatch(batchId, roots, startedAt));
    RUNNING.add(batchId);
    const files: FileReport[] = [];
    let finished = false;
    try {
      const { warnings, onlineOnly } = await this.prepare(roots, options, async (p) => {
        const report = this.apply(p, batchId, files.length);
        files.push(report);
        options.onFile?.(report);
      });
      const report = this.finish("commit", batchId, roots, startedAt, files, warnings, onlineOnly);
      this.db.run("UPDATE import_batch SET state = 'committed', finished_at = ?, totals_json = ? WHERE id = ?", report.finishedAt, JSON.stringify(report.totals), batchId);
      finished = true;
      return report;
    } finally {
      RUNNING.delete(batchId);
      if (!finished) {
        this.db.run("UPDATE import_batch SET state = 'stopped', finished_at = ?, totals_json = ? WHERE id = ?", now(), JSON.stringify(totalsOf(files)), batchId);
      }
    }
  }

  /**
   * Marks a running batch whose process is gone (a crash, a closed app, a killed process) as stopped, with its
   * totals rebuilt from its files, so that it can be undone. Returns the ids of the batches it marked.
   */
  recoverStale(): string[] {
    const rows = this.db.all<{ id: string; owner_pid: number | null; owner_host: string | null }>(
      "SELECT id, owner_pid, owner_host FROM import_batch WHERE state = 'running'",
    );
    const stale = rows.filter((r) => !ownerAlive(r.id, r.owner_pid === null ? null : Number(r.owner_pid), r.owner_host));
    for (const { id } of stale) {
      const files = this.db.all<{ outcome: string; records_json: string; change_id: string | null }>(
        "SELECT outcome, records_json, change_id FROM import_file WHERE batch_id = ? ORDER BY seq",
        id,
      );
      const reports = files.map((f) => {
        const change = f.change_id ? getChange(this.db, f.change_id) : undefined;
        return fileReport("", null, f.outcome as FileOutcome, {
          records: JSON.parse(f.records_json) as RecordCounts,
          tables: change ? (JSON.parse(change.counts_json) as ChangeCounts) : {},
        });
      });
      this.db.run(
        "UPDATE import_batch SET state = 'stopped', finished_at = ?, totals_json = ? WHERE id = ? AND state = 'running'",
        now(),
        JSON.stringify(totalsOf(reports)),
        id,
      );
    }
    return stale.map((r) => r.id);
  }

  /**
   * Forgets that files were imported, for an app that took away what they gave (a folder the user removed, an older
   * version of a file): the next run reads them again instead of finding them unchanged. Each file is its hash, its
   * reader as `<id>/<version>`, and its fileKey. Returns how many import rows it marked.
   */
  forget(files: Array<{ hash: string; reader: string; key?: string | null }>): number {
    const at = now();
    return this.db.transaction(() => {
      let n = 0;
      for (const f of files) {
        const { changes } = this.db.run(
          "UPDATE import_file SET forgotten_at = ? WHERE file_hash = ? AND reader = ? AND file_key IS ? AND outcome = 'imported' AND forgotten_at IS NULL",
          at,
          f.hash,
          f.reader,
          f.key ?? null,
        );
        n += Number(changes);
      }
      return n;
    });
  }

  /**
   * Undoes a batch: the journal change of each of its files, newest first, in one transaction. Refuses (conflict)
   * when rows the batch wrote changed since or other rows refer to them; then nothing is undone.
   */
  undo(batchId: string, options: { origin?: string } = {}): UndoResult {
    this.recoverStale();
    const batch = this.db.get<{ state: string; owner_pid: number | null; owner_host: string | null }>(
      "SELECT state, owner_pid, owner_host FROM import_batch WHERE id = ?",
      batchId,
    );
    if (!batch) throw new ImportError("not-found", `There is no import batch ${batchId}.`);
    if (batch.state === "undone") throw new ImportError("already-undone", `The import batch ${batchId} was undone already.`);
    if (batch.state === "running") {
      const where = batch.owner_host && batch.owner_host !== os.hostname() ? `on ${batch.owner_host}` : `in process ${batch.owner_pid ?? "unknown"}`;
      throw new ImportError("conflict", `The import batch ${batchId} is still running ${where}. Stop it, or wait until it ends, then undo it.`);
    }
    const files = this.db.all<{ path: string; change_id: string }>(
      "SELECT path, change_id FROM import_file WHERE batch_id = ? AND change_id IS NOT NULL ORDER BY seq DESC",
      batchId,
    );
    try {
      return this.db.transaction(() => {
        const undone: string[] = [];
        const undoChanges: string[] = [];
        const tables: ChangeCounts = {};
        for (const f of files) {
          const id = undoChange(this.db, f.change_id, {
            origin: options.origin ?? this.origin,
            capability: "import.undo",
            summary: `Undo the import of ${f.path}`,
            input: { batch_id: batchId, change_id: f.change_id },
          });
          undone.push(f.change_id);
          undoChanges.push(id);
          addCounts(tables, JSON.parse(getChange(this.db, id)!.counts_json) as ChangeCounts);
        }
        this.db.run("UPDATE import_batch SET state = 'undone', undone_at = ? WHERE id = ?", now(), batchId);
        return { batchId, undone, undoChanges, tables };
      });
    } catch (error) {
      if (error instanceof JournalError) {
        throw new ImportError("conflict", `The import batch ${batchId} cannot be undone: ${error.message}`, { cause: error });
      }
      throw error;
    }
  }

  /** The batches, newest first. */
  batches(limit = 50): BatchRow[] {
    this.recoverStale();
    return this.db
      .all<Record<string, string | null>>("SELECT * FROM import_batch ORDER BY started_at DESC, rowid DESC LIMIT ?", limit)
      .map(batchRow);
  }

  /** One batch with its files. */
  batch(batchId: string): { batch: BatchRow; files: Array<Omit<FileReport, "skips" | "sample" | "tables">> } | undefined {
    this.recoverStale();
    const row = this.db.get<Record<string, string | null>>("SELECT * FROM import_batch WHERE id = ?", batchId);
    if (!row) return undefined;
    const files = this.db
      .all<Record<string, string | number | null>>("SELECT * FROM import_file WHERE batch_id = ? ORDER BY seq", batchId)
      .map((f) => ({
        path: String(f.path),
        size: f.size === null ? null : Number(f.size),
        outcome: f.outcome as FileOutcome,
        ...(f.reason ? { reason: String(f.reason) } : {}),
        ...(f.file_hash ? { hash: String(f.file_hash) } : {}),
        ...(f.reader ? { reader: String(f.reader) } : {}),
        ...(f.source ? { source: String(f.source) } : {}),
        ...(f.file_key !== null && f.file_key !== undefined ? { key: String(f.file_key) } : {}),
        records: JSON.parse(String(f.records_json)) as RecordCounts,
        changeId: f.change_id === null ? null : String(f.change_id),
      }));
    return { batch: batchRow(row), files };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private choose(sample: Awaited<ReturnType<typeof sampleOf>>, minScore: number): Reader<any> | null {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let best: Reader<any> | null = null;
    let score = 0;
    for (const reader of this.readers) {
      let s = 0;
      try {
        s = reader.detect(sample) ?? 0;
      } catch {
        s = 0;
      }
      if (s > score) {
        score = s;
        best = reader;
      }
    }
    return best && score >= minScore ? best : null;
  }

  /** Walks the roots and hands each file to `next`, read and ready to write, in walk order. */
  private async prepare(
    roots: string[],
    options: RunOptions,
    next: (p: Prepared) => Promise<void>,
  ): Promise<{ warnings: string[]; onlineOnly: { files: number; bytes: number } | null }> {
    const minScore = options.minScore ?? 15;
    const warnings: string[] = [];
    let onlineFiles = 0;
    let onlineBytes = 0;
    const seen = new Map<string, string>();
    const aborted = () => {
      if (options.signal?.aborted) throw options.signal.reason ?? new Error("The import was cancelled.");
    };

    const visit = async (entry: Entry, root: string): Promise<void> => {
      aborted();
      if (isSystemFile(entry.path)) {
        await next({ kind: "done", report: fileReport(entry.path, entry.size, "ignored", { reason: "a system file" }) });
        return;
      }
      let reader;
      let head: Buffer;
      let sample: Awaited<ReturnType<typeof sampleOf>>;
      try {
        sample = await sampleOf(entry);
        head = sample.bytes;
        reader = this.choose(sample, minScore);
      } catch (error) {
        await next({ kind: "done", report: fileReport(entry.path, entry.size, "failed", { reason: `It could not be read: ${message(error)}` }) });
        return;
      }
      const archive = isZip(head) ? "zip" : isGzip(head) ? "gzip" : null;
      if (!reader && archive) {
        const at = await this.reserve(next, entry);
        let entries = 0;
        try {
          for await (const inner of expandArchive(entry, archive)) {
            entries += 1;
            await visit(inner, root);
          }
          at.resolve(fileReport(entry.path, entry.size, "archive", { entries }));
        } catch (error) {
          at.resolve(fileReport(entry.path, entry.size, "failed", { entries, reason: `The ${archive} could not be read to its end: ${message(error)}` }));
          if (options.signal?.aborted) throw error;
        }
        return;
      }
      if (!reader) {
        await next({ kind: "done", report: fileReport(entry.path, entry.size, "unrecognised", { reason: describeUnknown(entry, head) }) });
        return;
      }
      const readerName = `${reader.id}/${reader.version}`;
      let key: string | null;
      try {
        key = reader.fileKey?.(sample) ?? null;
      } catch (error) {
        await next({ kind: "done", report: fileReport(entry.path, entry.size, "failed", { reader: readerName, source: reader.source, reason: `${reader.label ?? reader.id} could not name it: ${message(error)}` }) });
        return;
      }
      const keyed = key === null ? {} : { key };
      let hash: string;
      let size: number;
      try {
        // A file small enough to keep is read once: the hash and the reader use the same bytes.
        if (entry.size !== null && entry.size <= KEEP_BYTES) {
          const data = await entry.buffer();
          ({ hash, size } = { hash: sha256(data), size: data.length });
        } else ({ hash, bytes: size } = await hashChunks(entry.chunks()));
      } catch (error) {
        await next({ kind: "done", report: fileReport(entry.path, entry.size, "failed", { reader: readerName, source: reader.source, ...keyed, reason: `It could not be read: ${message(error)}` }) });
        return;
      }
      // The same bytes with the same key: a copy. A reader whose records depend on the name gives a key, so two
      // equal files with different names are both read.
      const seenKey = `${readerName}\u0000${hash}\u0000${key ?? ""}`;
      const copyOf = seen.get(seenKey);
      if (copyOf !== undefined) {
        await next({ kind: "done", report: fileReport(entry.path, size, "copy", { hash, reader: readerName, source: reader.source, ...keyed, copyOf }) });
        return;
      }
      seen.set(seenKey, entry.path);
      if (!options.reread) {
        const earlier = this.importedBefore(hash, readerName, key);
        if (earlier) {
          const before = earlier.records;
          // Every record of the file is in the database already, from that batch or before it.
          const records: RecordCounts = { read: before.read, new: 0, duplicate: before.new + before.duplicate, repeated: before.repeated, skipped: before.skipped };
          await next({ kind: "done", report: fileReport(entry.path, size, "unchanged", { hash, reader: readerName, source: reader.source, ...keyed, importedIn: earlier.batchId, records }) });
          return;
        }
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const items: ReadItem<any>[] = [];
      try {
        const result = await reader.read(entry, { root, hash, key, ...(options.signal ? { signal: options.signal } : {}) });
        for await (const item of result as AsyncIterable<ReadItem<unknown>>) {
          items.push(item);
          if (items.length % 10000 === 0) aborted();
        }
      } catch (error) {
        aborted();
        await next({ kind: "done", report: fileReport(entry.path, size, "failed", { hash, reader: readerName, source: reader.source, ...keyed, reason: `${reader.label ?? reader.id} could not read it: ${message(error)}` }) });
        return;
      }
      // Only the path goes on, not the entry, so a preview does not keep each file's bytes until it writes.
      await next({ kind: "read", path: entry.path, reader, hash, key, items, size });
    };

    for (const root of roots) {
      aborted();
      const absolute = path.resolve(root);
      const listing = await listRoot(absolute, {
        ...(options.allowOnlineOnly ? { allowOnlineOnly: true } : {}),
        ...(options.listing ? { listing: options.listing } : {}),
      }).catch((error: unknown) => {
        throw error instanceof RootError ? new ImportError("not-found", error.message, { cause: error }) : error;
      });
      warnings.push(...listing.warnings);
      for (const item of listing.items) {
        if (item.skipped) {
          if (item.skipped.outcome === "online-only") {
            onlineFiles += 1;
            onlineBytes += item.skipped.size ?? 0;
          }
          await next({ kind: "done", report: fileReport(item.skipped.path, item.skipped.size, item.skipped.outcome, { reason: item.skipped.reason }) });
          continue;
        }
        await visit(item.entry!, absolute);
      }
    }
    return { warnings, onlineOnly: onlineFiles ? { files: onlineFiles, bytes: onlineBytes } : null };
  }

  /**
   * An archive is reported where it was found, before its entries, but its outcome is known only after them:
   * the report is handed on now and filled in later. A row written for it already is updated.
   */
  private async reserve(next: (p: Prepared) => Promise<void>, entry: Entry): Promise<{ resolve: (report: FileReport) => void }> {
    const report = fileReport(entry.path, entry.size, "archive");
    await next({ kind: "done", report });
    return {
      resolve: (final) => {
        Object.assign(report, final);
        const row = this.placed.get(report);
        if (row) this.db.run("UPDATE import_file SET outcome = ?, reason = ? WHERE batch_id = ? AND seq = ?", report.outcome, fileReason(report), row.batchId, row.seq);
      },
    };
  }

  /**
   * The latest import of the same bytes with the same key by the same reader in a batch that is not undone, when
   * nothing was undone since and the app did not forget the file.
   */
  private importedBefore(hash: string, reader: string, key: string | null): { batchId: string; records: RecordCounts } | undefined {
    const row = this.db.get<{ batch_id: string; records_json: string; started_at: string }>(
      `SELECT f.batch_id, f.records_json, b.started_at FROM import_file f JOIN import_batch b ON b.id = f.batch_id
       WHERE f.file_hash = ? AND f.reader = ? AND f.file_key IS ? AND f.forgotten_at IS NULL AND f.outcome = 'imported' AND b.state IN ('committed', 'stopped')
       ORDER BY b.started_at DESC, b.rowid DESC LIMIT 1`,
      hash,
      reader,
      key,
    );
    if (!row) return undefined;
    // An undo since that batch started may have taken away records the file's duplicates relied on: read it again.
    // started_at, not finished_at: an undo while the batch ran may have come after the batch checked the file.
    const since = row.started_at;
    if (this.db.get("SELECT 1 FROM import_batch WHERE state = 'undone' AND undone_at >= ? LIMIT 1", since)) return undefined;
    return { batchId: row.batch_id, records: JSON.parse(row.records_json) as RecordCounts };
  }

  private insertBatch(batchId: string, roots: string[], startedAt: string): void {
    this.db.run(
      "INSERT INTO import_batch (id, origin, state, roots_json, started_at, owner_pid, owner_host) VALUES (?, ?, 'running', ?, ?, ?, ?)",
      batchId,
      this.origin,
      JSON.stringify(roots.map((r) => path.resolve(r))),
      startedAt,
      process.pid,
      os.hostname(),
    );
  }

  private insertFile(batchId: string, seq: number, report: FileReport): void {
    this.placed.set(report, { batchId, seq });
    this.db.run(
      `INSERT INTO import_file (batch_id, seq, path, size, outcome, reason, file_hash, reader, source, records_json, change_id, file_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      batchId,
      seq,
      report.path,
      report.size,
      report.outcome,
      fileReason(report),
      report.hash ?? null,
      report.reader ?? null,
      report.source ?? null,
      JSON.stringify(report.records),
      report.changeId,
      report.key ?? null,
    );
  }

  /** Writes one file: its new records in one journal change, and its import_file row, in one transaction. */
  private apply(p: Prepared, batchId: string, seq: number): FileReport {
    if (p.kind === "done") {
      this.db.transaction(() => this.insertFile(batchId, seq, p.report));
      return p.report;
    }
    const { reader, hash, key, items } = p;
    const entry = { path: p.path };
    const readerName = `${reader.id}/${reader.version}`;
    const keyed = key === null ? {} : { key };
    const report = fileReport(entry.path, p.size, "imported", { hash, reader: readerName, source: reader.source, ...keyed });
    const repeats = reader.repeats ?? "number";
    try {
      this.db.transaction(() => {
        const { changeId } = recordChange(
          this.db,
          { origin: this.origin, capability: "import.file", summary: `Import ${entry.path}`, input: { batch_id: batchId, path: entry.path, file_hash: hash, reader: readerName } },
          (journal) => {
            const context = this.writeContext(journal, batchId, { path: entry.path, hash, reader: readerName, key });
            const counts = report.records;
            const inFile = new Map<string, number>();
            for (const item of items) {
              counts.read += 1;
              if ("skip" in item) {
                counts.skipped += 1;
                if (report.skips.length < KEPT_SKIPS) report.skips.push({ ref: item.ref, skip: item.skip } satisfies ReadSkip);
                continue;
              }
              const identity = canonicalJson(item.identity);
              const n = inFile.get(identity) ?? 0;
              inFile.set(identity, n + 1);
              if (n > 0 && repeats === "duplicate") {
                counts.repeated += 1;
                continue;
              }
              const key = contentHash(item.identity, repeats === "number" ? n : 0);
              if (findEntityByProvenance(this.db, reader.source, key)) {
                counts.duplicate += 1;
                continue;
              }
              const written = reader.write(item.data, context);
              // A record the reader found in the database already, as another entity, gets its provenance and counts as a duplicate.
              const existing = typeof written === "object" && written !== null && written.existing === true;
              const entityId = existing ? written.entity : written;
              if (typeof entityId !== "string" || !getEntity(this.db, entityId)) {
                throw new ImportError("invalid-write", `${reader.id} wrote ${item.ref} without returning the id of an entity it made.`);
              }
              context.insert("provenance", {
                id: randomUUID(),
                entity_id: entityId,
                source: reader.source,
                source_ref: `${entry.path}#${item.ref}`,
                content_hash: key,
                batch_id: batchId,
                file_hash: hash,
                reader: readerName,
              });
              if (existing) {
                counts.duplicate += 1;
                continue;
              }
              counts.new += 1;
              if (report.sample.length < SAMPLE_RECORDS) report.sample.push(describe(reader, item.data));
            }
          },
        );
        report.changeId = changeId;
        if (changeId) report.tables = JSON.parse(getChange(this.db, changeId)!.counts_json) as ChangeCounts;
        this.insertFile(batchId, seq, report);
      });
      return report;
    } catch (error) {
      if (error instanceof Rollback) throw error;
      const failed = fileReport(entry.path, p.size, "failed", {
        hash,
        reader: readerName,
        source: reader.source,
        ...keyed,
        reason: `Writing it failed, so nothing from it was written: ${message(error)}`,
      });
      this.db.transaction(() => this.insertFile(batchId, seq, failed));
      return failed;
    }
  }

  private writeContext(journal: ChangeJournal, batchId: string, file: WriteContext["file"]): WriteContext {
    const db = this.db;
    return {
      db,
      journal,
      batchId,
      file,
      createEntity(type, id = randomUUID()) {
        journal.track("entity", id);
        return createEntity(db, type, id);
      },
      insert(table, row) {
        const info = tableInfo(db, table);
        const columns = Object.keys(row);
        for (const c of columns) if (!info.columns.has(c)) throw new ImportError("invalid-write", `${table} has no column ${c}.`);
        if (!info.pk.length) throw new ImportError("invalid-write", `${table} has no primary key, so its rows cannot be undone.`);
        const q = (name: string) => `"${name.replace(/"/g, '""')}"`;
        const sql = `INSERT INTO ${q(table)} (${columns.map(q).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`;
        const values = columns.map((c) => row[c] ?? null) as SqlValue[];
        const hasKey = info.pk.every((c) => row[c] !== undefined && row[c] !== null);
        if (hasKey) {
          const key: Key = info.pk.length === 1 ? (row[info.pk[0]!] as Key) : Object.fromEntries(info.pk.map((c) => [c, row[c]]));
          journal.track(table, key);
          db.run(sql, ...values);
          return info.pk.length === 1 ? row[info.pk[0]!]! : null;
        }
        if (info.pk.length !== 1) throw new ImportError("invalid-write", `Give every key column of ${table}.`);
        const { lastInsertRowid } = db.run(sql, ...values);
        const key = typeof lastInsertRowid === "bigint" && lastInsertRowid <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(lastInsertRowid) : lastInsertRowid;
        journal.trackBefore(table, key as Key, []);
        return key;
      },
      link(fromId, toId, type) {
        journal.track("relationship", { from_id: fromId, to_id: toId, type });
        link(db, fromId, toId, type);
      },
    };
  }

  private finish(
    mode: "preview" | "commit",
    batchId: string,
    roots: string[],
    startedAt: string,
    files: FileReport[],
    warnings: string[],
    onlineOnly: { files: number; bytes: number } | null,
  ): ImportReport {
    const totals = totalsOf(files);
    return {
      mode,
      batchId,
      roots: roots.map((r) => path.resolve(r)),
      startedAt,
      finishedAt: now(),
      files,
      totals,
      onlineOnly,
      warnings,
      accounted: isAccounted(files, totals),
    };
  }
}

function batchRow(row: Record<string, string | null>): BatchRow {
  return {
    id: String(row.id),
    mode: "commit",
    origin: String(row.origin),
    state: row.state as BatchRow["state"],
    roots: JSON.parse(String(row.roots_json)) as string[],
    started_at: String(row.started_at),
    finished_at: row.finished_at ?? null,
    undone_at: row.undone_at ?? null,
    totals: row.totals_json ? (JSON.parse(row.totals_json) as ImportTotals) : null,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function describe(reader: Reader<any>, data: unknown): string {
  try {
    if (reader.describe) return reader.describe(data);
  } catch {
    // Fall back on the record itself.
  }
  const text = JSON.stringify(data) ?? String(data);
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

function fileReason(report: FileReport): string | null {
  if (report.reason) return report.reason;
  if (report.copyOf) return `a copy of ${report.copyOf}`;
  if (report.importedIn) return `imported in batch ${report.importedIn}`;
  if (report.entries !== undefined) return `${report.entries} ${report.entries === 1 ? "entry" : "entries"}`;
  return null;
}

function describeUnknown(entry: ImportEntry, head: Buffer): string {
  if (entry.size === 0) return "an empty file";
  if (head.subarray(0, 16).toString("latin1").startsWith("SQLite format 3")) return "a SQLite database that no reader knows";
  return "no reader recognised it";
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Refuses roots that are not there, before a batch is written. */
async function checkRoots(roots: string[]): Promise<void> {
  if (!roots.length) throw new ImportError("not-found", "Name at least one folder or file.");
  for (const root of roots) {
    const absolute = path.resolve(root);
    if (!(await fs.lstat(absolute).catch(() => null))) throw new ImportError("not-found", `${absolute} was not found.`);
  }
}

/** Creates an importer over a database that setupImport() has prepared. */
export function createImporter(db: SqliteDatabase, options: ImporterOptions): Importer {
  return new Importer(db, options);
}
