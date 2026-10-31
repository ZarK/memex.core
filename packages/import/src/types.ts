import type { ChangeCounts, ChangeJournal, SqlValue, SqliteDatabase } from "@tjalve/memex-sqlite";

/** One file the import found: on disk, in a zip, or inside a gzip. */
export interface ImportEntry {
  /** Relative to the root with "/" separators; archive members follow " › ": "drop/2025.zip › march/quakes.csv". */
  readonly path: string;
  /** The file name without folders. */
  readonly name: string;
  /** The lowercase extension with its dot, ".csv"; ".csv.gz" for a gzip file. */
  readonly ext: string;
  /** Bytes, or null when not known before reading (the inside of a gzip). */
  readonly size: number | null;
  readonly modifiedMs: number;
  /** The absolute path when the entry is a file on disk, else null. */
  readonly diskPath: string | null;
  /** The bytes as a stream of chunks. Each call reads from the start. */
  chunks(): AsyncIterable<Buffer>;
  /** The whole content. Kept after the first read when it is at most 64 MiB. */
  buffer(): Promise<Buffer>;
  /** The content decoded as text (UTF-8, UTF-16 with a byte order mark, or Windows-1252). */
  text(): Promise<string>;
  /** The first bytes, for detection. */
  head(bytes?: number): Promise<Buffer>;
}

/** What a reader decides from in detect(): the name and the first 64 KiB. */
export interface FileSample {
  readonly path: string;
  readonly name: string;
  readonly ext: string;
  readonly size: number | null;
  /** The first 64 KiB. */
  readonly bytes: Buffer;
  /** The first 64 KiB decoded as text. */
  readonly head: string;
}

/** A record a reader read, with the fields that identify it in its source. */
export interface ReadRecord<T> {
  /** Where the record is in its file, for reports: "row 12", "feature 3", an external id. */
  ref: string;
  /**
   * The fields that identify the record in its source. Its canonical JSON is hashed into the provenance
   * content hash, so the same record gives the same hash in every file and every run.
   */
  identity: unknown;
  /** The normalized record, handed to the reader's write(). */
  data: T;
}

/** A record a reader saw and could not use: it is counted as skipped with its reason. */
export interface ReadSkip {
  ref: string;
  skip: string;
}

export type ReadItem<T> = ReadRecord<T> | ReadSkip;

export interface ReadContext {
  /** The root the file was found under. */
  root: string;
  /** The file's SHA-256, as the import hashed it. */
  hash: string;
  /** The reader's fileKey for the file, or null. */
  key: string | null;
  signal?: AbortSignal;
}

export interface WriteContext {
  readonly db: SqliteDatabase;
  /** The change journal of this file's commit. Rows written through the helpers below are tracked already. */
  readonly journal: ChangeJournal;
  readonly batchId: string;
  readonly file: { path: string; hash: string; reader: string; key: string | null };
  /** Creates an entity of a type (tracked for undo) and returns its id. */
  createEntity(type: string, id?: string): string;
  /** Inserts a row (tracked for undo). A table with an integer key may leave the key out. Returns the row's key. */
  insert(table: string, row: Record<string, SqlValue>): SqlValue;
  /** Links two entities (tracked for undo). An existing link is left as it is. */
  link(fromId: string, toId: string, type: string): void;
}

/**
 * A reader of one kind of file. Readers are domain code and live in the apps; this package walks, detects,
 * hashes, dedupes, writes provenance, previews, commits, and undoes.
 */
export interface Reader<T = unknown> {
  /** A short id: lowercase letters, digits, ".", and "-". With the version it is the provenance `reader`. */
  id: string;
  /** Raise it when the reader reads the same file differently; files read by an older version are read again. */
  version: number;
  /** For people: "USGS earthquakes (CSV)". */
  label?: string;
  /** The provenance `source`: the pipeline, not the file, for example "import:usgs:earthquakes". Readers of one kind of record in two formats share it, so a record imported from either is a duplicate in the other. */
  source: string;
  /**
   * Records in one file with the same identity: "number" keeps each (the second gets ordinal 1), for rows
   * without an id of their own; "duplicate" keeps the first, for records with an id of their own. Default "number".
   */
  repeats?: "number" | "duplicate";
  /** 0 to 100: how sure the reader is that the file is its kind. 0 means "not mine". Answer from the name and the head. */
  detect(sample: FileSample): number;
  /**
   * What the reader takes from a file besides its bytes, for a reader whose records depend on the file's name or
   * folder: a daily file whose name holds its date, a file whose folder names its measure. Two files with the same
   * bytes and different keys are not copies, and a file is unchanged only when the same bytes with the same key were
   * imported before. Null or leaving it out: the bytes alone decide.
   */
  fileKey?(sample: FileSample): string | null;
  /** Reads every record of a file. A reader never throws for one bad record: it yields a skip with the reason. */
  read(entry: ImportEntry, context: ReadContext): AsyncIterable<ReadItem<T>> | Iterable<ReadItem<T>> | Promise<Iterable<ReadItem<T>>>;
  /**
   * Writes one new record and returns the id of its entity, which gets the provenance row. Synchronous: it runs in the
   * file's transaction. A record that is in the database already under another key (the reader matched it to an
   * existing entity) returns { entity, existing: true }: its provenance row is written for that entity, and it counts
   * as a duplicate, not as new.
   */
  write(data: T, context: WriteContext): string | ExistingRecord;
  /** A short line about a record, for previews. */
  describe?(data: T): string;
}

export type FileOutcome =
  /** Read and committed (or, in a preview, would be). Its records are new, duplicates, repeats, or skipped. */
  | "imported"
  /** The same bytes were imported by the same reader version in an earlier batch that is not undone: not read again. */
  | "unchanged"
  /** The same bytes as another file in this run: not read again. */
  | "copy"
  /** A zip or gzip that no reader reads whole: its entries were read. */
  | "archive"
  /** No reader recognised it. */
  | "unrecognised"
  /** Its bytes are not on this device; reading it would download it. */
  | "online-only"
  /** Left out on purpose: hidden, or a system file such as .DS_Store. */
  | "ignored"
  /** It could not be read, or its reader failed: nothing from it was written. */
  | "failed";

export interface RecordCounts {
  /** Records the reader gave, skips included. */
  read: number;
  /** Records written. */
  new: number;
  /** Records whose content hash was in the database already: from an earlier batch or an earlier file of this run. */
  duplicate: number;
  /** Records repeated in the same file with the reader's repeats "duplicate". */
  repeated: number;
  /** Records the reader could not use. */
  skipped: number;
}

export interface FileReport {
  path: string;
  size: number | null;
  outcome: FileOutcome;
  reason?: string;
  /** SHA-256 of the file's bytes, when it was read. */
  hash?: string;
  /** The reader as `<id>/<version>`. */
  reader?: string;
  source?: string;
  /** The reader's fileKey for the file, when it gave one. */
  key?: string;
  /** For a copy: the file it is a copy of. */
  copyOf?: string;
  /** For an unchanged file: the batch that imported it. */
  importedIn?: string;
  /** For an archive: how many entries it held. */
  entries?: number;
  records: RecordCounts;
  /** The first skips, with their reasons. */
  skips: ReadSkip[];
  /** The first new records, as the reader describes them. */
  sample: string[];
  /** Rows written per table. */
  tables: ChangeCounts;
  /** The journal change of this file's commit, for undo. Null when nothing was written. */
  changeId: string | null;
}

export interface ImportTotals {
  files: Record<FileOutcome, number> & { all: number };
  records: RecordCounts;
  tables: ChangeCounts;
}

export interface ImportReport {
  mode: "preview" | "commit";
  /** In a preview, the id the batch had inside the rolled-back transaction. */
  batchId: string;
  roots: string[];
  startedAt: string;
  finishedAt: string;
  files: FileReport[];
  totals: ImportTotals;
  /** Online-only files that were not read, with their bytes, or null. */
  onlineOnly: { files: number; bytes: number } | null;
  /** Listing problems: folders that could not be listed. */
  warnings: string[];
  /**
   * True when every file has an outcome and, for every file read, read = new + duplicate + repeated + skipped,
   * and the totals add up.
   */
  accounted: boolean;
}

export interface BatchRow {
  id: string;
  mode: string;
  origin: string;
  state: "running" | "committed" | "stopped" | "undone";
  roots: string[];
  started_at: string;
  finished_at: string | null;
  undone_at: string | null;
  totals: ImportTotals | null;
}

export interface UndoResult {
  batchId: string;
  /** The journal changes that were undone, newest first. */
  undone: string[];
  /** The undo changes, one per file. */
  undoChanges: string[];
  /** Rows put back per table (inserted rows of the batch are deleted). */
  tables: ChangeCounts;
}

/** What write() returns for a record that was in the database already as another entity: it counts as a duplicate. */
export interface ExistingRecord {
  entity: string;
  existing: true;
}
