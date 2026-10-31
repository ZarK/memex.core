import type { Readable } from "node:stream";
import fs from "node:fs/promises";
import path from "node:path";
import { copyFileClosed } from "./closed.js";
import { ArchiveError, PACKS_DIR, runYear, type SourceRef } from "./layout.js";
import type { JsonValue } from "./status.js";
import { ZipWriter, openZipEntry, readZipDirectory, readZipEntry, type ZipEntry, type ZipEntryInfo } from "./zip.js";

export const PACK_FORMAT = "memex.archive.pack/1";
export const MANIFEST_ENTRY = "manifest.json";
/**
 * A pack starts a new part before an entry when the part holds this much compressed data. An entry
 * larger than this (uncompressed) gets a part of its own.
 */
export const DEFAULT_PART_BYTES = 1024 ** 3;
/**
 * Entries per part: below the 65,535 at which a zip needs the ZIP64 end records, with room for
 * manifest.json, so that a part of small entries stays a plain zip.
 */
export const MAX_PART_ENTRIES = 65_000;
/** The largest entry a pack takes, uncompressed: 64 GiB. A larger file fails as too large for a pack. */
export const MAX_ENTRY_BYTES = 64 * 1024 ** 3;
/** Room kept below the part limit for the next entry's headers and manifest line, and for deflate overhead. */
const ENTRY_SLACK = 64 * 1024;

/** Throws "too large for a pack" for an entry above MAX_ENTRY_BYTES. */
export function checkEntrySize(size: number): void {
  if (size > MAX_ENTRY_BYTES) {
    throw new ArchiveError("too-large", `too large for a pack: ${size} bytes; the limit is 64 GiB (${MAX_ENTRY_BYTES} bytes)`);
  }
}

const PACK_NAME = /^(\d{8}T\d{6}Z-[0-9a-f]{8})(?:\.([1-9]\d*))?\.zip$/;

export type JsonObject = { [key: string]: JsonValue };

export interface FullEntry {
  entry: string;
  kind: "full";
  id: string;
  size: number;
  sha256: string;
  mtime?: string;
  meta?: JsonObject;
}

export interface AppendEntry {
  entry: string;
  kind: "append";
  id: string;
  /** The size of the file at its previous revision. */
  offset: number;
  /** The number of new bytes. */
  size: number;
  /** SHA-256 of the whole file at its previous revision. */
  base: string;
  /** SHA-256 of the whole file after this append. */
  sha256: string;
  mtime?: string;
  meta?: JsonObject;
}

export interface AttachmentEntry {
  entry: string;
  kind: "attachment";
  size: number;
  sha256: string;
}

export interface RecordsEntry {
  entry: string;
  kind: "records";
  stream: string;
  count: number;
  size: number;
  sha256: string;
}

/** An index item that is not a file (note()). It has no zip entry. */
export interface ItemEntry {
  kind: "item";
  id: string;
  meta?: JsonObject;
}

export type ManifestEntry = FullEntry | AppendEntry | AttachmentEntry | RecordsEntry | ItemEntry;

export interface PackManifest extends SourceRef {
  format: typeof PACK_FORMAT;
  runId: string;
  part: number;
  createdAt: string;
  entries: ManifestEntry[];
}

/** <run-id>.zip for part 1, <run-id>.<n>.zip for the later parts. */
export function packFileName(runId: string, part: number): string {
  return part === 1 ? `${runId}.zip` : `${runId}.${part}.zip`;
}

export function parsePackName(name: string): { runId: string; part: number } | null {
  const match = PACK_NAME.exec(name);
  if (match === null) return null;
  return { runId: match[1]!, part: match[2] === undefined ? 1 : Number(match[2]) };
}

export interface StagedPart {
  /** The part file in the staging folder. */
  file: string;
  part: number;
  manifest: PackManifest;
}

export interface AddEntryOptions<T extends ManifestEntry> {
  /** The uncompressed size, when known before the write. Used to decide when a part is full. */
  size: number;
  mtime?: Date;
  /** Describes the entry once its bytes are written. When it throws, the entry is dropped. */
  describe: (info: ZipEntryInfo) => T | Promise<T>;
}

interface OpenPart {
  writer: ZipWriter;
  part: number;
  entries: ManifestEntry[];
  /** Bytes the entries will take in the central directory and in manifest.json. */
  tail: number;
  /** The part holds an entry larger than the part size, and takes no other entry. */
  alone: boolean;
}

/** The bytes an entry takes in manifest.json, where it is indented two levels deep. */
function manifestBytes(entry: ManifestEntry): number {
  const text = JSON.stringify(entry, null, 2);
  return Buffer.byteLength(text, "utf8") + 4 * text.split("\n").length + 2;
}

/**
 * Builds the parts of one run's pack in a staging folder. Entries are added one at a time, in the
 * order the calls arrive. close() writes manifest.json as the last entry of every part.
 * When a part cannot be finished (its manifest.json or central directory fails to write), the
 * builder is broken: the part keeps its file and number, and every later add() and close() rejects.
 */
export class PackBuilder {
  private current: OpenPart | null = null;
  private readonly staged: StagedPart[] = [];
  private readonly items = new Map<string, ItemEntry>();
  private itemBytes = 0;
  private readonly names = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();
  private closing: Promise<StagedPart[]> | null = null;
  private broken: Error | null = null;
  readonly partBytes: number;
  /**
   * The largest part file. Only tests set it; parts are bounded by partBytes and use ZIP64 only for
   * an entry that needs it.
   */
  readonly limit: number;

  constructor(
    readonly dir: string,
    readonly ref: SourceRef & { runId: string },
    options: { partBytes?: number; limit?: number } = {},
  ) {
    this.partBytes = options.partBytes ?? DEFAULT_PART_BYTES;
    this.limit = options.limit ?? Number.MAX_SAFE_INTEGER;
  }

  /** The parts finished so far. After a failed close(), these are the parts to publish. */
  get parts(): StagedPart[] {
    return [...this.staged];
  }

  /** Runs one step after the steps before it, whether they failed or not. */
  private serial<T>(step: () => Promise<T>): Promise<T> {
    const next = this.queue.then(step, step);
    this.queue = next.catch(() => {});
    return next;
  }

  /** Reserves an entry name. Every name appears once in a pack, across its parts. */
  reserve(name: string): void {
    if (this.closing !== null) throw new ArchiveError("pack-closed", "The pack is closed");
    if (this.names.has(name) || name === MANIFEST_ENTRY) throw new ArchiveError("entry-exists", `The run already added ${name}`);
    this.names.add(name);
  }

  /** Gives a reserved name back, after its entry failed. */
  release(name: string): void {
    this.names.delete(name);
  }

  /** Adds an entry whose name was reserved. */
  add<T extends ManifestEntry>(name: string, data: Uint8Array | AsyncIterable<Uint8Array>, options: AddEntryOptions<T>): Promise<T> {
    return this.serial(async () => {
      if (this.broken !== null) throw new ArchiveError("pack-broken", `A part of the pack could not be finished: ${this.broken.message}`);
      checkEntrySize(options.size);
      const part = await this.partFor(options.size);
      let described: T | undefined;
      await part.writer.add(name, data, {
        mtime: options.mtime,
        size: options.size,
        check: async (info) => {
          described = await options.describe(info);
        },
      });
      part.entries.push(described!);
      if (options.size > this.partBytes) part.alone = true;
      part.tail += 46 + Buffer.byteLength(name, "utf8") + manifestBytes(described!);
      return described!;
    });
  }

  /** Sets an item for the manifest. A later call for the same id replaces it. */
  note(item: ItemEntry): void {
    if (this.closing !== null) throw new ArchiveError("pack-closed", "The pack is closed");
    const old = this.items.get(item.id);
    if (old !== undefined) this.itemBytes -= manifestBytes(old);
    this.items.set(item.id, item);
    this.itemBytes += manifestBytes(item);
  }

  /**
   * Whether a part has room below the zip limit for an entry of this size, its manifest.json (with
   * the items, which go into the last part) and its central directory.
   */
  private fits(c: OpenPart, size: number): boolean {
    if (c.writer.count === 0) return true;
    return c.writer.bytes + size + Math.ceil(size / 1024) + c.tail + this.itemBytes + ENTRY_SLACK <= this.limit;
  }

  private async partFor(size: number): Promise<OpenPart> {
    const c = this.current;
    if (c !== null) {
      // An entry larger than the part size goes into a part of its own, which then takes no other.
      const alone = size > this.partBytes && c.writer.count > 0;
      const full = c.alone || alone || c.writer.compressedBytes >= this.partBytes || c.writer.count >= MAX_PART_ENTRIES || !this.fits(c, size);
      if (!full) return c;
      await this.closePart(false);
    }
    return this.openPart();
  }

  private async openPart(): Promise<OpenPart> {
    const part = this.staged.length + 1;
    await fs.mkdir(this.dir, { recursive: true });
    const file = path.join(this.dir, packFileName(this.ref.runId, part));
    await fs.rm(file, { force: true });
    this.current = { writer: await ZipWriter.create(file), part, entries: [], tail: 0, alone: false };
    return this.current;
  }

  private async closePart(last: boolean): Promise<void> {
    const c = this.current;
    if (c === null) return;
    const entries = last ? [...c.entries, ...this.items.values()] : c.entries;
    if (entries.length === 0) {
      // Only failed entries: the run found nothing to keep in this part.
      this.current = null;
      await c.writer.abort();
      await fs.rm(c.writer.file, { force: true });
      return;
    }
    const manifest: PackManifest = {
      format: PACK_FORMAT,
      domain: this.ref.domain,
      source: this.ref.source,
      device: this.ref.device,
      runId: this.ref.runId,
      part: c.part,
      createdAt: new Date().toISOString(),
      entries,
    };
    try {
      await c.writer.add(MANIFEST_ENTRY, Buffer.from(JSON.stringify(manifest, null, 2) + "\n"));
      await c.writer.close();
    } catch (error) {
      // The part's entries were already acknowledged. It stays current, so that its number and file
      // are never reused, and every later entry is refused, so that nothing builds on them.
      this.broken = error as Error;
      await c.writer.abort().catch(() => {});
      throw error;
    }
    this.current = null;
    this.staged.push({ file: c.writer.file, part: c.part, manifest });
  }

  /**
   * Finishes the last part. Returns the staged parts; none when the run added nothing. Rejects when
   * a part could not be finished; `parts` then holds the parts that were.
   */
  close(): Promise<StagedPart[]> {
    this.closing ??= this.serial(async () => {
      if (this.broken !== null) throw this.broken;
      // The items go into the last part: start one for them when the current part has no room.
      if (this.items.size > 0 && (this.current === null || !this.fits(this.current, 0))) {
        await this.closePart(false);
        await this.openPart();
      }
      await this.closePart(true);
      return [...this.staged];
    });
    return this.closing;
  }
}

export interface PackInfo {
  /** Relative to the source folder, with forward slashes: packs/2026/<run-id>.zip. */
  file: string;
  /** The absolute path. */
  path: string;
  runId: string;
  part: number;
  bytes: number;
}

function comparePacks(a: { runId: string; part: number }, b: { runId: string; part: number }): number {
  if (a.runId !== b.runId) return a.runId < b.runId ? -1 : 1;
  return a.part - b.part;
}

/**
 * Copies staged parts into <dir>/packs/<yyyy>/ with no-replace closed writes, in part order.
 * Returns the published packs.
 */
export async function publishParts(parts: readonly StagedPart[], dir: string, runId: string): Promise<PackInfo[]> {
  const out: PackInfo[] = [];
  for (const p of [...parts].sort((a, b) => a.part - b.part)) {
    const name = packFileName(runId, p.part);
    const file = `${PACKS_DIR}/${runYear(runId)}/${name}`;
    const target = path.join(dir, PACKS_DIR, runYear(runId), name);
    await copyFileClosed(p.file, target, undefined, { replace: false });
    out.push({ file, path: target, runId, part: p.part, bytes: (await fs.stat(target)).size });
  }
  return out;
}

/** The packs of a source folder, sorted by run id and part. *.partial files are ignored. */
export async function listPacks(dir: string): Promise<PackInfo[]> {
  const out: PackInfo[] = [];
  let years: string[];
  try {
    years = await fs.readdir(path.join(dir, PACKS_DIR));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  for (const year of years.filter((y) => /^\d{4}$/.test(y))) {
    for (const e of await fs.readdir(path.join(dir, PACKS_DIR, year), { withFileTypes: true })) {
      const parsed = e.isFile() ? parsePackName(e.name) : null;
      if (parsed === null) continue;
      const full = path.join(dir, PACKS_DIR, year, e.name);
      out.push({ file: `${PACKS_DIR}/${year}/${e.name}`, path: full, ...parsed, bytes: (await fs.stat(full)).size });
    }
  }
  return out.sort(comparePacks);
}

export interface Pack {
  file: string;
  manifest: PackManifest;
  /** The zip entries, from the central directory. */
  entries: ZipEntry[];
  /** A stream of one entry's bytes; it fails at the end when the CRC-32 does not match. */
  open(name: string): Promise<Readable>;
  read(name: string): Promise<Buffer>;
}

/** Opens a pack for reading: its central directory and its manifest. */
export async function openPack(file: string): Promise<Pack> {
  const entries = await readZipDirectory(file);
  const byName = new Map(entries.map((e) => [e.name, e]));
  const find = (name: string): ZipEntry => {
    const e = byName.get(name);
    if (e === undefined) throw new ArchiveError("not-found", `${file} has no entry ${name}`);
    return e;
  };
  let manifest: PackManifest;
  try {
    manifest = JSON.parse((await readZipEntry(file, find(MANIFEST_ENTRY))).toString("utf8")) as PackManifest;
  } catch (error) {
    throw new ArchiveError("invalid-pack", `${file}: no readable ${MANIFEST_ENTRY}: ${(error as Error).message}`);
  }
  if (manifest?.format !== PACK_FORMAT || !Array.isArray(manifest.entries)) {
    throw new ArchiveError("invalid-pack", `${file}: ${MANIFEST_ENTRY} is not ${PACK_FORMAT}`);
  }
  return {
    file,
    manifest,
    entries,
    open: (name) => openZipEntry(file, find(name)),
    read: (name) => readZipEntry(file, find(name)),
  };
}
