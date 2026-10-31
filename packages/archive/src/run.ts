import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";
import { SourceChangedError, copyFileClosed, sha256Bytes, sha256File } from "./closed.js";
import {
  buildIndex,
  knownSnapshots,
  readIndex,
  rebuildIndex,
  scanDatabases,
  snapshotRun,
  writeIndex,
  type ArchiveIndex,
  type IndexSnapshot,
} from "./index-file.js";
import {
  ArchiveError,
  DATABASES_DIR,
  DEFAULT_STREAM,
  assertRelativePath,
  assertSegment,
  newRunId,
  normalizeExtension,
  sourceDir,
  type SourceRef,
} from "./layout.js";
import { acquireRunLock, type LockOptions, type RunLock } from "./lock.js";
import { PackBuilder, checkEntrySize, listPacks, publishParts, type JsonObject, type StagedPart } from "./pack.js";
import { archiveCacheDir } from "./paths.js";
import { writeArchiveReadme } from "./readme.js";
import { readStatus, recordRun, statusPath, type ArchiveStatus, type FilteredRecord, type JsonValue, type RunCounts } from "./status.js";

/** The largest meta object, as UTF-8 JSON. */
export const MAX_META_BYTES = 4096;
export const DEFAULT_DATABASE_KEEP = 3;

/** Creates the archive root folder and its README.md. Returns whether the folder was created. */
export async function initArchive(root: string): Promise<{ root: string; created: boolean }> {
  let created = false;
  try {
    const stat = await fs.stat(root);
    if (!stat.isDirectory()) throw new Error(`The archive root is not a folder: ${root}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await fs.mkdir(root, { recursive: true });
    created = true;
  }
  await writeArchiveReadme(root);
  return { root, created };
}

export interface FinishOptions {
  counts: RunCounts;
  filtered?: FilteredRecord[];
  highWater?: JsonValue;
  error?: string | null;
  missingPermissions?: string[];
}

export interface ChunkResult {
  /** records/<stream>.jsonl, or null when there were no records (nothing is stored). */
  entry: string | null;
  count: number;
  size: number;
  sha256: string | null;
}

export interface AttachmentResult {
  sha256: string;
  size: number;
  /** The normalized extension, "" when none. */
  ext: string;
  /** false when the index or this run already has these bytes. */
  stored: boolean;
  /** attachments/<aa>/<sha256>.<ext> of the stored copy. */
  entry: string;
}

export interface CaptureResult {
  id: string;
  entry: string;
  size: number;
  sha256: string;
  mtime: string;
}

export interface AppendResult {
  id: string;
  entry: string;
  offset: number;
  /** The number of new bytes stored. */
  size: number;
  base: string;
  /** SHA-256 of the whole file after the append. */
  sha256: string;
  /** The size of the whole file after the append. */
  fileSize: number;
  mtime: string;
}

export interface DatabaseResult {
  name: string;
  /** Relative to the source folder: databases/<name>/<run-id>.<ext>.gz, or the earlier snapshot when not stored. */
  file: string;
  /** Compressed size. */
  size: number;
  /** SHA-256 of the database before compression. */
  sha256: string;
  sourceSize: number;
  /**
   * false when the newest snapshot already has these bytes, or (with oncePerDay) is from the same
   * UTC day. The other fields then describe that snapshot.
   */
  stored: boolean;
}

export interface ArchiveRun {
  readonly runId: string;
  readonly startedAt: string;
  /** The source folder: <root>/<domain>/<source>/<device>. */
  readonly dir: string;
  /** The status before this run, or null for a new source. Collectors resume from previous.highWater. */
  readonly previous: ArchiveStatus | null;
  /** The index before this run, or null for a new source. */
  readonly previousIndex: ArchiveIndex | null;
  /** Adds the run's records for a stream as records/<stream>.jsonl. One call per stream. */
  writeChunk(records: Iterable<unknown> | AsyncIterable<unknown>, options?: { stream?: string }): Promise<ChunkResult>;
  /** Adds an attachment by hash, unless the index or this run already has it. */
  putAttachment(input: Uint8Array | { path: string }, options?: { ext?: string }): Promise<AttachmentResult>;
  /** Adds a whole file as files/<path>. */
  captureFile(sourcePath: string, path: string, options?: { meta?: JsonObject; expectedSha256?: string }): Promise<CaptureResult>;
  /** Adds the bytes of a file from offset to its end as appends/<path>. */
  appendFile(sourcePath: string, path: string, options: { offset: number; base: string; meta?: JsonObject }): Promise<AppendResult>;
  /**
   * Stores a gzip copy of a database as databases/<name>/<run-id>.<ext>.gz and keeps the latest
   * `keep` (default 3). Skips it when the newest snapshot has the same bytes, and, unless
   * oncePerDay is false, when the newest snapshot is from the same UTC day as this run.
   */
  putDatabase(sourcePath: string, name: string, options?: { keep?: number; oncePerDay?: boolean }): Promise<DatabaseResult>;
  /** Sets an index item that is not a file. A later call for the same id replaces its meta. */
  note(id: string, meta?: JsonObject): void;
  /**
   * Publishes the pack parts, writes index.jsonl and status.json, and releases the lock. A run
   * whose counts do not add up is recorded as failed. When status.json cannot be written, the lock
   * is still released and the error is thrown; a later finish() or fail() tries again and throws
   * that first error if it fails too.
   */
  finish(options: FinishOptions): Promise<ArchiveStatus>;
  /** Publishes what the run staged, records a failed run with this error, and releases the lock. */
  fail(error: unknown, counts?: Partial<RunCounts>): Promise<ArchiveStatus>;
}

export interface StartRunOptions extends SourceRef, LockOptions {
  root: string;
  now?: Date;
  /** The local cache folder where packs are built. Defaults to the OS cache folder of the app id archive. */
  cacheDir?: string;
  /** A new pack part starts before an entry when the part holds this much compressed data. */
  partBytes?: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Checks a meta object: a JSON object of at most MAX_META_BYTES. Returns a copy. */
function checkMeta(meta: JsonObject | undefined, what: string): JsonObject | undefined {
  if (meta === undefined) return undefined;
  if (!isPlainObject(meta)) throw new ArchiveError("invalid-meta", `The meta of ${what} is not a JSON object`);
  const text = JSON.stringify(meta);
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_META_BYTES) {
    throw new ArchiveError("meta-too-large", `The meta of ${what} is ${bytes} bytes; the limit is ${MAX_META_BYTES}. Shorten its text fields.`);
  }
  return JSON.parse(text) as JsonObject;
}

/** Wraps a stream of chunks so that their SHA-256 is known at the end. */
function hashing(source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>): { data: AsyncIterable<Uint8Array>; digest: () => string } {
  const hash = createHash("sha256");
  let digest = "";
  return {
    data: (async function* () {
      for await (const chunk of source) {
        hash.update(chunk);
        yield chunk;
      }
      digest = hash.digest("hex");
    })(),
    digest: () => digest,
  };
}

/** Reads every record into a JSONL file. Returns the count, size and SHA-256 of the file. */
async function stageRecords(
  file: string,
  records: Iterable<unknown> | AsyncIterable<unknown>,
): Promise<{ count: number; size: number; sha256: string }> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const hash = createHash("sha256");
  let count = 0;
  let size = 0;
  const handle = await fs.open(file, "w");
  try {
    let buffer = "";
    const flush = async () => {
      const bytes = Buffer.from(buffer, "utf8");
      hash.update(bytes);
      size += bytes.length;
      await handle.writeFile(bytes);
      buffer = "";
    };
    for await (const record of records as AsyncIterable<unknown>) {
      if (!isPlainObject(record)) throw new ArchiveError("invalid-record", `Record ${count + 1} is not a JSON object`);
      buffer += JSON.stringify(record) + "\n";
      count++;
      if (buffer.length >= 1 << 20) await flush();
    }
    if (buffer.length > 0) await flush();
  } finally {
    await handle.close();
  }
  return { count, size, sha256: hash.digest("hex") };
}

/**
 * Starts a run for one source: takes the run lock, reads the earlier status and index, writes the
 * archive README.md when it is missing or old, and picks a run id. Everything the run adds is staged
 * in the local cache folder and published into the archive by finish() or fail().
 * Throws ArchiveError "status-mismatch" when status.json in the folder belongs to another source.
 * Always end the run with finish() or fail(), so that the lock is released.
 */
export async function startRun(options: StartRunOptions): Promise<ArchiveRun> {
  const { root, domain, source, device } = options;
  const dir = sourceDir(root, { domain, source, device });
  await fs.mkdir(dir, { recursive: true });
  return openRun(dir, options);
}

/**
 * Starts a run in a folder that exists: a source folder, or an import folder (importFolder), whose
 * manifests and status name domain "imports". The folder's segments are not checked here.
 */
export async function openRun(dir: string, options: StartRunOptions): Promise<ArchiveRun> {
  const { root, domain, source, device } = options;
  const lock: RunLock = await acquireRunLock(dir, options);
  let previous: ArchiveStatus | null;
  let previousIndex: ArchiveIndex | null;
  try {
    previous = await readStatus(dir);
    if (previous !== null && (previous.domain !== domain || previous.source !== source || previous.device !== device)) {
      throw new ArchiveError(
        "status-mismatch",
        `${statusPath(dir)} belongs to ${previous.domain}/${previous.source}/${previous.device}, not ${domain}/${source}/${device}`,
      );
    }
    previousIndex = await readIndex(dir).catch(() => null);
    // An index that is missing, unreadable, or behind the packs (a run stopped before it wrote
    // the index) is made again, so that the run knows what is already stored.
    const listed = new Set(previousIndex?.source.packs.map((p) => p.file) ?? []);
    if ((await listPacks(dir)).some((p) => !listed.has(p.file))) previousIndex = await rebuildIndex(dir);
    await writeArchiveReadme(root);
  } catch (error) {
    await lock.release();
    throw error;
  }
  const now = options.now ?? new Date();
  const latest = [previous?.lastRun.runId, previousIndex?.source.packs.at(-1)?.runId].filter((r) => r !== undefined).sort().at(-1);
  const runId = newRunId(now, latest);
  const startedAt = now.toISOString();
  const ref = { domain, source, device };
  const staging = path.join(options.cacheDir ?? archiveCacheDir(options), "staging", domain, source, device, runId);
  const pack = new PackBuilder(staging, { ...ref, runId }, { partBytes: options.partBytes });

  // What is stored already, by the earlier runs or this one. An attachment of this run maps to its
  // copy, which settles once the bytes are in the pack.
  const attachments = new Map((previousIndex?.attachments ?? []).map((a) => [a.sha256, Promise.resolve(a.entry)]));
  const files = new Map((previousIndex?.files ?? []).map((f) => [f.id, { size: f.size, sha256: f.sha256 }]));
  const snapshots: Map<string, IndexSnapshot> = knownSnapshots(previousIndex);
  const latestSnapshot = new Map((previousIndex?.databases ?? []).map((d) => [d.name, d.snapshots[0]]));
  const databases = new Set<string>();
  const pending = new Set<Promise<unknown>>();

  // open: accepts writes. recording: finish() or fail() is writing status.json.
  // unrecorded: writing status.json failed; finish() or fail() may try again. recorded: done.
  let state: "open" | "recording" | "unrecorded" | "recorded" = "open";
  let recordError: unknown = null;
  let held: RunLock | null = lock;
  const ensureOpen = () => {
    if (state !== "open") throw new Error(`Run ${runId} is finished`);
  };
  /** Runs a call of the run API, so that finish() waits for the calls still in flight. */
  const track = <T>(work: () => Promise<T>): Promise<T> => {
    if (state !== "open") return Promise.reject(new Error(`Run ${runId} is finished`));
    const promise = work();
    pending.add(promise);
    const done = () => pending.delete(promise);
    promise.then(done, done);
    return promise;
  };

  /** Publishes the staged parts and writes the index. Runs once; the result says what was published. */
  let publishing: Promise<{ packs: string[]; error: string | null }> | null = null;
  const publish = async (): Promise<{ packs: string[]; error: string | null }> => {
    await Promise.allSettled([...pending]);
    const packs: string[] = [];
    // A part that could not be finished fails the run. The parts that did close are still
    // published, and the staging folder is kept with the unfinished part.
    let failure: string | null = null;
    let parts: StagedPart[];
    try {
      parts = await pack.close();
    } catch (error) {
      parts = pack.parts;
      failure = `a pack part could not be finished: ${(error as Error).message}`;
    }
    try {
      const published = await publishParts(parts, dir, runId);
      packs.push(...published.map((p) => p.file));
      const manifests = published.map((info) => ({ info, manifest: parts.find((p) => p.part === info.part)!.manifest }));
      const index = buildIndex(previousIndex, ref, manifests, await scanDatabases(dir, snapshots), new Date().toISOString());
      await writeIndex(dir, index);
      if (failure === null) await fs.rm(staging, { recursive: true, force: true });
      return { packs, error: failure };
    } catch (error) {
      return { packs, error: `could not publish the run: ${(error as Error).message}` };
    }
  };

  const finish = async (o: FinishOptions): Promise<ArchiveStatus> => {
    if (state === "recorded" || state === "recording") throw new Error(`Run ${runId} is finished`);
    const retry = state === "unrecorded";
    state = "recording";
    const published = await (publishing ??= publish());
    let current: RunLock;
    try {
      // A failed earlier attempt released the lock; take it again before writing status.json.
      current = held ?? (await acquireRunLock(dir, options));
    } catch {
      state = "unrecorded";
      throw recordError;
    }
    held = null;
    let status: ArchiveStatus;
    try {
      const errors = [o.error ?? null, published.error].filter((e) => e !== null);
      status = await recordRun(dir, {
        domain,
        source,
        device,
        runId,
        startedAt,
        counts: o.counts,
        filtered: o.filtered,
        highWater: o.highWater,
        error: errors.length > 0 ? errors.join("; ") : null,
        missingPermissions: o.missingPermissions,
        packs: published.packs,
      });
    } catch (error) {
      state = "unrecorded";
      if (!retry) recordError = error;
      // The lock is released even when status.json could not be written, and the first error is
      // the one reported: a later fail() must not hide why the run was not recorded.
      await current.release().catch(() => {});
      throw recordError;
    }
    state = "recorded";
    await current.release();
    return status;
  };

  const writeChunk = async (records: Iterable<unknown> | AsyncIterable<unknown>, o: { stream?: string } = {}): Promise<ChunkResult> => {
    const stream = o.stream ?? DEFAULT_STREAM;
    assertSegment("stream", stream);
    const entry = `records/${stream}.jsonl`;
    try {
      pack.reserve(entry);
    } catch (error) {
      if ((error as ArchiveError).code !== "entry-exists") throw error;
      throw new ArchiveError("chunk-exists", `The run already wrote the records of stream ${stream}`);
    }
    const tmp = path.join(staging, "tmp", `records-${stream}.jsonl`);
    try {
      const staged = await stageRecords(tmp, records);
      if (staged.count === 0) {
        pack.release(entry);
        return { entry: null, count: 0, size: 0, sha256: null };
      }
      checkEntrySize(staged.size);
      await pack.add(entry, createReadStream(tmp), {
        size: staged.size,
        describe: () => ({ entry, kind: "records", stream, count: staged.count, size: staged.size, sha256: staged.sha256 }),
      });
      return { entry, ...staged };
    } catch (error) {
      pack.release(entry);
      throw error;
    } finally {
      await fs.rm(tmp, { force: true });
    }
  };

  const putAttachment = async (input: Uint8Array | { path: string }, o: { ext?: string } = {}): Promise<AttachmentResult> => {
    const bytes = input instanceof Uint8Array ? input : null;
    const ext = normalizeExtension(bytes !== null ? o.ext : (o.ext ?? path.extname((input as { path: string }).path)));
    const { sha256, size } = bytes !== null ? { sha256: sha256Bytes(bytes), size: bytes.length } : await sha256File((input as { path: string }).path);
    // Wait for a copy of the same bytes still in flight. When it fails, this call stores the bytes.
    for (let have = attachments.get(sha256); have !== undefined; have = attachments.get(sha256)) {
      try {
        return { sha256, size, ext, stored: false, entry: await have };
      } catch {
        // The failed call removed its copy from the map before its promise settled.
      }
    }
    checkEntrySize(size);
    const entry = `attachments/${sha256.slice(0, 2)}/${sha256}${ext === "" ? "" : "." + ext}`;
    pack.reserve(entry);
    const sourcePath = bytes === null ? (input as { path: string }).path : null;
    const h = hashing(sourcePath === null ? [bytes!] : createReadStream(sourcePath));
    const copy = pack
      .add(entry, h.data, {
        size,
        describe: () => {
          if (h.digest() !== sha256) throw new SourceChangedError(sourcePath ?? "attachment bytes");
          return { entry, kind: "attachment", size, sha256 };
        },
      })
      .then(() => entry);
    attachments.set(sha256, copy);
    try {
      await copy;
    } catch (error) {
      attachments.delete(sha256);
      pack.release(entry);
      throw error;
    }
    return { sha256, size, ext, stored: true, entry };
  };

  const captureFile = async (
    sourcePath: string,
    id: string,
    o: { meta?: JsonObject; expectedSha256?: string } = {},
  ): Promise<CaptureResult> => {
    assertRelativePath(id);
    const meta = checkMeta(o.meta, id);
    const entry = `files/${id}`;
    const stat = await fs.stat(sourcePath);
    checkEntrySize(stat.size);
    const mtime = stat.mtime.toISOString();
    pack.reserve(entry);
    try {
      const h = hashing(createReadStream(sourcePath));
      const described = await pack.add(entry, h.data, {
        size: stat.size,
        mtime: stat.mtime,
        describe: (info) => {
          const sha256 = h.digest();
          if (o.expectedSha256 !== undefined && sha256 !== o.expectedSha256) throw new SourceChangedError(sourcePath);
          return { entry, kind: "full" as const, id, size: info.size, sha256, mtime, ...(meta === undefined ? {} : { meta }) };
        },
      });
      files.set(id, { size: described.size, sha256: described.sha256 });
      return { id, entry, size: described.size, sha256: described.sha256, mtime };
    } catch (error) {
      pack.release(entry);
      throw error;
    }
  };

  const appendFile = async (
    sourcePath: string,
    id: string,
    o: { offset: number; base: string; meta?: JsonObject },
  ): Promise<AppendResult> => {
    assertRelativePath(id);
    const meta = checkMeta(o.meta, id);
    const { offset, base } = o;
    const entry = `appends/${id}`;
    const known = files.get(id);
    if (known === undefined) throw new ArchiveError("append-unknown", `${id} has no earlier revision; capture it whole`);
    if (known.size !== offset || known.sha256 !== base) {
      throw new ArchiveError("append-mismatch", `${id}: offset and base do not match its latest revision (${known.size} bytes, ${known.sha256})`);
    }
    const stat = await fs.stat(sourcePath);
    if (stat.size <= offset) throw new ArchiveError("append-empty", `${sourcePath} did not grow past ${offset} bytes`);
    checkEntrySize(stat.size - offset);
    const mtime = stat.mtime.toISOString();
    pack.reserve(entry);
    try {
      // Hash the whole file while copying only the tail: the hash at offset must be the base.
      const hash = createHash("sha256");
      let prefix: string | null = offset === 0 ? hash.copy().digest("hex") : null;
      let whole = "";
      const tail = async function* () {
        let position = 0;
        for await (const c of createReadStream(sourcePath)) {
          let chunk = c as Buffer;
          if (position < offset) {
            const head = chunk.subarray(0, Math.min(chunk.length, offset - position));
            hash.update(head);
            position += head.length;
            chunk = chunk.subarray(head.length);
            if (position === offset) prefix = hash.copy().digest("hex");
          }
          if (chunk.length > 0) {
            hash.update(chunk);
            position += chunk.length;
            yield chunk;
          }
        }
        whole = hash.digest("hex");
      };
      const described = await pack.add(entry, tail(), {
        size: stat.size - offset,
        mtime: stat.mtime,
        describe: (info) => {
          if (prefix !== base) throw new ArchiveError("append-base-mismatch", `${sourcePath} did not only grow since its last revision; capture it whole`);
          return { entry, kind: "append" as const, id, offset, size: info.size, base, sha256: whole, mtime, ...(meta === undefined ? {} : { meta }) };
        },
      });
      const fileSize = offset + described.size;
      files.set(id, { size: fileSize, sha256: described.sha256 });
      return { id, entry, offset, size: described.size, base, sha256: described.sha256, fileSize, mtime };
    } catch (error) {
      pack.release(entry);
      throw error;
    }
  };

  const putDatabase = async (sourcePath: string, name: string, o: { keep?: number; oncePerDay?: boolean } = {}): Promise<DatabaseResult> => {
    assertSegment("name", name);
    const keep = o.keep ?? DEFAULT_DATABASE_KEEP;
    if (!Number.isInteger(keep) || keep < 1) throw new ArchiveError("invalid-keep", `keep must be a whole number of 1 or more: ${keep}`);
    if (databases.has(name)) throw new ArchiveError("database-exists", `The run already stored database ${name}`);
    databases.add(name);
    const latest = latestSnapshot.get(name);
    if (latest !== undefined && o.oncePerDay !== false && latest.run.slice(0, 8) === runId.slice(0, 8)) {
      return { name, file: latest.file, size: latest.size, sha256: latest.sha256, sourceSize: latest.sourceSize, stored: false };
    }
    const ext = normalizeExtension(path.extname(sourcePath));
    const fileName = `${runId}${ext === "" ? "" : "." + ext}.gz`;
    const file = `${DATABASES_DIR}/${name}/${fileName}`;
    const staged = path.join(staging, DATABASES_DIR, name, fileName);
    await fs.mkdir(path.dirname(staged), { recursive: true });
    try {
      const hash = createHash("sha256");
      let sourceSize = 0;
      await pipeline(
        createReadStream(sourcePath),
        async function* (source: AsyncIterable<Buffer>) {
          for await (const chunk of source) {
            hash.update(chunk);
            sourceSize += chunk.length;
            yield chunk;
          }
        },
        zlib.createGzip(),
        createWriteStream(staged),
      );
      const sha256 = hash.digest("hex");
      if (latest !== undefined && latest.sha256 === sha256) {
        return { name, file: latest.file, size: latest.size, sha256, sourceSize, stored: false };
      }
      const folder = path.join(dir, DATABASES_DIR, name);
      const { size } = await fs.stat(staged);
      await copyFileClosed(staged, path.join(folder, fileName), undefined, { replace: false });
      snapshots.set(file, { run: runId, file, size, sha256, sourceSize });
      // The only deletion in the archive: older snapshots beyond `keep`, newest kept.
      const names = (await fs.readdir(folder)).filter((n) => snapshotRun(n) !== null);
      names.sort((a, b) => (snapshotRun(b)! < snapshotRun(a)! ? -1 : 1));
      for (const old of names.slice(keep)) await fs.rm(path.join(folder, old), { force: true });
      return { name, file, size, sha256, sourceSize, stored: true };
    } finally {
      await fs.rm(staged, { force: true });
    }
  };

  return {
    runId,
    startedAt,
    dir,
    previous,
    previousIndex,
    writeChunk: (records, o) => track(() => writeChunk(records, o)),
    putAttachment: (input, o) => track(() => putAttachment(input, o)),
    captureFile: (sourcePath, id, o) => track(() => captureFile(sourcePath, id, o)),
    appendFile: (sourcePath, id, o) => track(() => appendFile(sourcePath, id, o)),
    putDatabase: (sourcePath, name, o) => track(() => putDatabase(sourcePath, name, o)),
    note(id, meta) {
      ensureOpen();
      if (typeof id !== "string" || id === "") throw new ArchiveError("invalid-id", "An item id must be a non-empty string");
      const checked = checkMeta(meta, id);
      pack.note({ kind: "item", id, ...(checked === undefined ? {} : { meta: checked }) });
    },
    finish,
    async fail(error, counts) {
      const message = error instanceof Error ? error.message : String(error);
      return finish({
        counts: { read: 0, written: 0, unchanged: 0, filtered: 0, failed: 0, ...counts },
        error: message === "" ? "failed" : message,
      });
    },
  };
}
