import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";
import { writeFileClosed } from "./closed.js";
import { ArchiveError, DATABASES_DIR, INDEX_FILE, isRunId, type SourceRef } from "./layout.js";
import { listPacks, openPack, type JsonObject, type PackInfo, type PackManifest } from "./pack.js";
import { readStatus } from "./status.js";

export const INDEX_FORMAT = "memex.archive.index/1";

export interface IndexPack {
  file: string;
  runId: string;
  part: number;
  bytes: number;
}

export interface IndexSource extends SourceRef {
  type: "source";
  format: typeof INDEX_FORMAT;
  updatedAt: string;
  /** The number of runs that published a pack. */
  runs: number;
  packs: IndexPack[];
  /**
   * files: the number of file items. bytes: the size of the packs and snapshots on disk.
   * sourceBytes: the size of the latest version of every file, every attachment and every snapshot
   * before compression.
   */
  totals: { files: number; bytes: number; sourceBytes: number };
}

export interface IndexRevision {
  run: string;
  file: string;
  entry: string;
  kind: "full" | "append";
  /** Appends only. */
  offset?: number;
  /** The bytes in the entry: the whole file for a full revision, the new bytes for an append. */
  size: number;
  /** SHA-256 of the whole file after this revision. */
  sha256: string;
}

export interface IndexFile {
  type: "file";
  id: string;
  /** The entry of the latest revision. */
  path: string;
  size: number;
  sha256: string;
  mtime: string | null;
  firstRun: string;
  lastRun: string;
  revisions: IndexRevision[];
  meta: JsonObject | null;
}

export interface IndexAttachment {
  type: "attachment";
  sha256: string;
  ext: string;
  size: number;
  file: string;
  entry: string;
  firstRun: string;
}

export interface IndexRecords {
  type: "records";
  run: string;
  file: string;
  entry: string;
  stream: string;
  count: number;
}

export interface IndexSnapshot {
  run: string;
  /** Relative to the source folder: databases/<name>/<run-id>.<ext>.gz. */
  file: string;
  /** Compressed size. */
  size: number;
  /** SHA-256 of the database before compression. */
  sha256: string;
  sourceSize: number;
}

export interface IndexDatabase {
  type: "database";
  name: string;
  /** Newest first. */
  snapshots: IndexSnapshot[];
}

export interface IndexItem {
  type: "item";
  id: string;
  meta: JsonObject | null;
  firstRun: string;
  lastRun: string;
}

/** index.jsonl, parsed: the source line and the items by type. */
export interface ArchiveIndex {
  source: IndexSource;
  files: IndexFile[];
  attachments: IndexAttachment[];
  records: IndexRecords[];
  databases: IndexDatabase[];
  items: IndexItem[];
}

export function indexPath(dir: string): string {
  return path.join(dir, INDEX_FILE);
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The index after some packs: the previous index (or none) with the manifests applied in run and
 * part order, and the database lines replaced. Shared by the end of a run and by rebuildIndex.
 */
export function buildIndex(
  previous: ArchiveIndex | null,
  ref: SourceRef,
  packs: ReadonlyArray<{ info: IndexPack; manifest: PackManifest }>,
  databases: IndexDatabase[],
  updatedAt: string,
): ArchiveIndex {
  const clone = <T>(value: T): T => structuredClone(value);
  const files = new Map((previous?.files ?? []).map((f) => [f.id, clone(f)]));
  const attachments = new Map((previous?.attachments ?? []).map((a) => [a.sha256, clone(a)]));
  const items = new Map((previous?.items ?? []).map((i) => [i.id, clone(i)]));
  const records = (previous?.records ?? []).map(clone);
  const packList = new Map((previous?.source.packs ?? []).map((p) => [p.file, { ...p }]));

  const sorted = [...packs].sort((a, b) => compare(a.info.runId, b.info.runId) || a.info.part - b.info.part);
  for (const { info, manifest } of sorted) {
    packList.set(info.file, { file: info.file, runId: info.runId, part: info.part, bytes: info.bytes });
    const run = manifest.runId;
    for (const e of manifest.entries) {
      switch (e.kind) {
        case "full":
        case "append": {
          const size = e.kind === "full" ? e.size : e.offset + e.size;
          const revision: IndexRevision =
            e.kind === "full"
              ? { run, file: info.file, entry: e.entry, kind: "full", size: e.size, sha256: e.sha256 }
              : { run, file: info.file, entry: e.entry, kind: "append", offset: e.offset, size: e.size, sha256: e.sha256 };
          const f = files.get(e.id);
          if (f === undefined) {
            files.set(e.id, {
              type: "file",
              id: e.id,
              path: e.entry,
              size,
              sha256: e.sha256,
              mtime: e.mtime ?? null,
              firstRun: run,
              lastRun: run,
              revisions: [revision],
              meta: e.meta ?? null,
            });
          } else {
            f.revisions.push(revision);
            f.path = e.entry;
            f.size = size;
            f.sha256 = e.sha256;
            f.mtime = e.mtime ?? f.mtime;
            f.lastRun = run;
            if (e.meta !== undefined) f.meta = e.meta;
          }
          break;
        }
        case "attachment": {
          if (attachments.has(e.sha256)) break;
          const name = e.entry.slice(e.entry.lastIndexOf("/") + 1);
          const dot = name.indexOf(".");
          attachments.set(e.sha256, {
            type: "attachment",
            sha256: e.sha256,
            ext: dot < 0 ? "" : name.slice(dot + 1),
            size: e.size,
            file: info.file,
            entry: e.entry,
            firstRun: run,
          });
          break;
        }
        case "records":
          records.push({ type: "records", run, file: info.file, entry: e.entry, stream: e.stream, count: e.count });
          break;
        case "item": {
          const i = items.get(e.id);
          if (i === undefined) items.set(e.id, { type: "item", id: e.id, meta: e.meta ?? null, firstRun: run, lastRun: run });
          else {
            i.lastRun = run;
            if (e.meta !== undefined) i.meta = e.meta;
          }
          break;
        }
      }
    }
  }

  const packLines = [...packList.values()].sort(comparePack);
  const fileLines = [...files.values()].sort((a, b) => compare(a.id, b.id));
  const attachmentLines = [...attachments.values()].sort((a, b) => compare(a.sha256, b.sha256));
  const databaseLines = [...databases].sort((a, b) => compare(a.name, b.name));
  const snapshots = databaseLines.flatMap((d) => d.snapshots);
  return {
    source: {
      type: "source",
      format: INDEX_FORMAT,
      domain: ref.domain,
      source: ref.source,
      device: ref.device,
      updatedAt,
      runs: new Set(packLines.map((p) => p.runId)).size,
      packs: packLines,
      totals: {
        files: fileLines.length,
        bytes: sum(packLines.map((p) => p.bytes)) + sum(snapshots.map((s) => s.size)),
        sourceBytes: sum(fileLines.map((f) => f.size)) + sum(attachmentLines.map((a) => a.size)) + sum(snapshots.map((s) => s.sourceSize)),
      },
    },
    files: fileLines,
    attachments: attachmentLines,
    records: records.sort((a, b) => compare(a.run, b.run) || compare(a.entry, b.entry)),
    databases: databaseLines,
    items: [...items.values()].sort((a, b) => compare(a.id, b.id)),
  };
}

function comparePack(a: IndexPack, b: IndexPack): number {
  return compare(a.runId, b.runId) || a.part - b.part;
}

function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

/** The lines of index.jsonl: the source first, then the items sorted by type and key. */
export function indexLines(index: ArchiveIndex): unknown[] {
  return [index.source, ...index.attachments, ...index.databases, ...index.files, ...index.items, ...index.records];
}

/** Writes index.jsonl with a closed write that replaces the earlier one. */
export async function writeIndex(dir: string, index: ArchiveIndex): Promise<void> {
  await writeFileClosed(indexPath(dir), indexLines(index).map((l) => JSON.stringify(l)).join("\n") + "\n");
}

/** Reads index.jsonl of a source folder. Returns null when there is none. Throws on an invalid file. */
export async function readIndex(dir: string): Promise<ArchiveIndex | null> {
  const file = indexPath(dir);
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const lines = text.split("\n").filter((l) => l !== "");
  const parsed = lines.map((l, i) => {
    try {
      return JSON.parse(l) as { type?: unknown };
    } catch {
      throw new ArchiveError("invalid-index", `${file}:${i + 1} is not valid JSON`);
    }
  });
  const source = parsed[0] as IndexSource | undefined;
  if (source?.type !== "source" || source.format !== INDEX_FORMAT || !Array.isArray(source.packs)) {
    throw new ArchiveError("invalid-index", `${file}: the first line is not a ${INDEX_FORMAT} source line`);
  }
  const index: ArchiveIndex = { source, files: [], attachments: [], records: [], databases: [], items: [] };
  for (const line of parsed.slice(1)) {
    // Unknown types are skipped, so that a later version can add some.
    if (line.type === "file") index.files.push(line as IndexFile);
    else if (line.type === "attachment") index.attachments.push(line as IndexAttachment);
    else if (line.type === "records") index.records.push(line as IndexRecords);
    else if (line.type === "database") index.databases.push(line as IndexDatabase);
    else if (line.type === "item") index.items.push(line as IndexItem);
  }
  return index;
}

const SNAPSHOT_NAME = /^(\d{8}T\d{6}Z-[0-9a-f]{8})(?:\.[a-z0-9]{1,16})?\.gz$/;

/** The run id of a snapshot file name, or null when the name is not a snapshot. */
export function snapshotRun(name: string): string | null {
  const match = SNAPSHOT_NAME.exec(name);
  return match !== null && isRunId(match[1]!) ? match[1]! : null;
}

async function readDirNames(dir: string): Promise<string[]> {
  try {
    return (await fs.readdir(dir, { withFileTypes: true })).filter((e) => !e.name.startsWith(".")).map((e) => e.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/** SHA-256 and size of a gzip file's content. */
async function gunzipHash(file: string): Promise<{ sha256: string; size: number }> {
  const hash = createHash("sha256");
  let size = 0;
  await pipeline(createReadStream(file), zlib.createGunzip(), async (source: AsyncIterable<Buffer>) => {
    for await (const chunk of source) {
      hash.update(chunk);
      size += chunk.length;
    }
  });
  return { sha256: hash.digest("hex"), size };
}

/**
 * The database lines from the databases/ folder. A snapshot found in known keeps its hash and
 * size; any other one is decompressed to compute them.
 */
export async function scanDatabases(dir: string, known: ReadonlyMap<string, IndexSnapshot> = new Map()): Promise<IndexDatabase[]> {
  const out: IndexDatabase[] = [];
  for (const name of await readDirNames(path.join(dir, DATABASES_DIR))) {
    const snapshots: IndexSnapshot[] = [];
    for (const fileName of await readDirNames(path.join(dir, DATABASES_DIR, name))) {
      const run = snapshotRun(fileName);
      if (run === null) continue;
      const file = `${DATABASES_DIR}/${name}/${fileName}`;
      const full = path.join(dir, DATABASES_DIR, name, fileName);
      const size = (await fs.stat(full)).size;
      const k = known.get(file);
      const { sha256, size: sourceSize } = k !== undefined && k.size === size ? { sha256: k.sha256, size: k.sourceSize } : await gunzipHash(full);
      snapshots.push({ run, file, size, sha256, sourceSize });
    }
    if (snapshots.length === 0) continue;
    snapshots.sort((a, b) => compare(b.run, a.run));
    out.push({ type: "database", name, snapshots });
  }
  return out;
}

/** The snapshots an index lists, by file. */
export function knownSnapshots(index: ArchiveIndex | null): Map<string, IndexSnapshot> {
  return new Map((index?.databases ?? []).flatMap((d) => d.snapshots.map((s) => [s.file, s] as const)));
}

/**
 * Makes the index again from the pack manifests and the databases/ folder. Does not write it.
 * The source comes from the manifests, then status.json, then the folder's own path.
 */
export async function rebuildIndex(dir: string, now: Date = new Date()): Promise<ArchiveIndex> {
  const packs: Array<{ info: PackInfo; manifest: PackManifest }> = [];
  for (const info of await listPacks(dir)) {
    packs.push({ info, manifest: (await openPack(info.path)).manifest });
  }
  let ref: SourceRef | null = packs[0]?.manifest ?? null;
  if (ref === null) {
    const status = await readStatus(dir).catch(() => null);
    const parts = path.resolve(dir).split(path.sep);
    ref = status ?? { domain: parts.at(-3) ?? "", source: parts.at(-2) ?? "", device: parts.at(-1) ?? "" };
  }
  const refOnly = { domain: ref.domain, source: ref.source, device: ref.device };
  const info = (p: PackInfo): IndexPack => ({ file: p.file, runId: p.runId, part: p.part, bytes: p.bytes });
  return buildIndex(null, refOnly, packs.map((p) => ({ info: info(p.info), manifest: p.manifest })), await scanDatabases(dir), now.toISOString());
}
