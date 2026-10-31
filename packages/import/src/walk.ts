// Walking what the user chose: folders through @tjalve/memex-folders (online-only
// files are found without reading them, links are not followed), zip entries
// through the @tjalve/memex-archive zip reader (CRC-checked), and gzip content.
// From Health's import (archive.mjs).
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createGunzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { openZipEntry, readZipDirectory } from "@tjalve/memex-archive";
import { defaultBackend, isOnlineOnly, listFolder, type ListFolderOptions, type RawEntry } from "@tjalve/memex-folders";
import { decodeText } from "./text.js";
import type { FileSample, ImportEntry } from "./types.js";

/** The largest content an entry keeps in memory after reading it. */
export const KEEP_BYTES = 64 * 1024 * 1024;
/** The bytes detect() sees. */
export const SAMPLE_BYTES = 64 * 1024;

export class Entry implements ImportEntry {
  private kept: Buffer | null = null;
  private headBytes: Buffer | null = null;

  constructor(
    readonly path: string,
    readonly name: string,
    readonly size: number | null,
    readonly modifiedMs: number,
    readonly diskPath: string | null,
    private readonly open: () => AsyncIterable<Buffer> | Promise<AsyncIterable<Buffer>>,
  ) {}

  get ext(): string {
    const lower = this.name.toLowerCase();
    return lower.endsWith(".gz") ? path.extname(lower.slice(0, -3)) + ".gz" : path.extname(lower);
  }

  async *chunks(): AsyncIterable<Buffer> {
    if (this.kept) {
      yield this.kept;
      return;
    }
    for await (const chunk of await this.open()) yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  }

  async buffer(): Promise<Buffer> {
    if (this.kept) return this.kept;
    const parts: Buffer[] = [];
    for await (const chunk of this.chunks()) parts.push(chunk);
    const data = Buffer.concat(parts);
    if (data.length <= KEEP_BYTES) this.kept = data;
    return data;
  }

  async text(): Promise<string> {
    return decodeText(await this.buffer());
  }

  async head(bytes = SAMPLE_BYTES): Promise<Buffer> {
    if (this.kept) return this.kept.subarray(0, bytes);
    if (this.headBytes && (this.headBytes.length >= bytes || (this.size !== null && this.headBytes.length >= this.size))) {
      return this.headBytes.subarray(0, bytes);
    }
    const parts: Buffer[] = [];
    let length = 0;
    for await (const chunk of this.chunks()) {
      parts.push(chunk);
      length += chunk.length;
      if (length >= bytes) break;
    }
    this.headBytes = Buffer.concat(parts);
    return this.headBytes.subarray(0, bytes);
  }
}

/** What detect() sees of an entry. */
export async function sampleOf(entry: ImportEntry): Promise<FileSample> {
  const bytes = await entry.head(SAMPLE_BYTES);
  return { path: entry.path, name: entry.name, ext: entry.ext, size: entry.size, bytes, head: decodeText(bytes) };
}

export const isZip = (head: Buffer) => head.length >= 4 && head.readUInt32LE(0) === 0x04034b50;
export const isGzip = (head: Buffer) => head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b;

/** System files that are never data. */
const SYSTEM = /(^|\/| › )(__MACOSX(\/|$)|\.DS_Store$|Thumbs\.db$|desktop\.ini$|\._)/i;
export function isSystemFile(entryPath: string): boolean {
  return SYSTEM.test(entryPath.replaceAll("\\", "/"));
}

export interface RootItem {
  entry?: Entry;
  /** A file that is found but not read. */
  skipped?: { path: string; size: number | null; outcome: "online-only" | "ignored"; reason: string };
}

export interface RootListing {
  items: RootItem[];
  warnings: string[];
}

function diskEntry(file: string, display: string, size: number, modifiedMs: number): Entry {
  return new Entry(display, path.basename(file), size, modifiedMs, file, () => createReadStream(file, { highWaterMark: 1 << 20 }));
}

/** The reason a root cannot be listed: it is missing or cannot be seen. */
export class RootError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RootError";
  }
}

const ONLINE_ONLY_REASON = "its bytes are not on this device; reading it would download it";

/**
 * A root's own entry, from a listing of its parent folder, so that a single file is checked like a file in a
 * folder: online-only bytes are not read and a link is not followed. Null for the root of a drive.
 */
async function rootEntry(absolute: string, listing: ListFolderOptions): Promise<RawEntry | null> {
  const parent = path.dirname(absolute);
  if (parent === absolute) return null;
  const backend = listing.backend ?? defaultBackend();
  try {
    const folder = await backend.readFolder(parent);
    if (!folder.complete) {
      throw new RootError(folder.code === "missing" ? `${absolute} was not found.` : `${absolute} could not be checked: the folder ${parent} could not be listed (${folder.error}).`);
    }
    const name = path.basename(absolute);
    const found =
      folder.entries.find((e) => e.name === name) ??
      (backend.platform === "win32" || backend.platform === "darwin" ? folder.entries.find((e) => e.name.toLowerCase() === name.toLowerCase()) : undefined);
    if (!found) throw new RootError(`${absolute} was not found.`);
    return found;
  } finally {
    if (!listing.backend) await backend.close();
  }
}

/**
 * The files of one root, a folder or a single file. Online-only files are reported, not read, unless
 * `allowOnlineOnly` (the user confirmed the download). A root that is a link is not followed. Files the listing
 * left out (hidden, ignored, a name collision) are reported as ignored. Throws RootError when the root is missing.
 */
export async function listRoot(root: string, options: { allowOnlineOnly?: boolean; listing?: ListFolderOptions } = {}): Promise<RootListing> {
  const absolute = path.resolve(root);
  const display = path.basename(absolute);
  const ignored = (reason: string): RootListing => ({ items: [{ skipped: { path: display, size: null, outcome: "ignored", reason } }], warnings: [] });
  // lstat reads no file data, so it downloads nothing; it sees a link as a link.
  const stat = await fs.lstat(absolute).catch(() => null);
  if (!stat) throw new RootError(`${absolute} was not found.`);
  if (stat.isSymbolicLink()) return ignored("a link; links are not followed");
  if (!stat.isDirectory()) {
    if (!stat.isFile()) return ignored("not a file or a folder");
    // A single file is checked as a file in a folder is: its attributes come from a listing of its parent.
    const own = await rootEntry(absolute, options.listing ?? {});
    if (!own || own.type === "link") return ignored("a link; links are not followed");
    if (own.type !== "file") return ignored("not a file or a folder");
    if (isOnlineOnly(own) && !options.allowOnlineOnly) {
      return { items: [{ skipped: { path: display, size: own.size, outcome: "online-only", reason: ONLINE_ONLY_REASON } }], warnings: [] };
    }
    return { items: [{ entry: diskEntry(absolute, display, own.size, Math.round(own.modifiedMs)) }], warnings: [] };
  }
  const listing = await listFolder(absolute, options.listing ?? {});
  const items: RootItem[] = [];
  for (const file of listing.files) {
    if (file.onlineOnly && !options.allowOnlineOnly) {
      items.push({
        skipped: {
          path: file.path,
          size: file.sizeKnown ? file.size : null,
          outcome: "online-only",
          reason: ONLINE_ONLY_REASON,
        },
      });
      continue;
    }
    items.push({ entry: diskEntry(path.join(absolute, ...file.path.split("/")), file.path, file.size, Math.round(file.modifiedMs)) });
  }
  for (const skipped of listing.skippedFiles) {
    items.push({ skipped: { path: skipped, size: null, outcome: "ignored", reason: "hidden, or left out by the listing" } });
  }
  const warnings = [
    ...listing.unlistedFolders.map((f) => `The folder ${f.path || "."} could not be listed (${f.error}); nothing below it was read.`),
    ...listing.warnings.filter((w) => w.code === "folder-not-listed" || w.code === "folder-gone").map((w) => w.message),
  ];
  return { items, warnings };
}

/**
 * The entries of a zip or gzip entry. A zip that is not a file on disk (a zip in a zip) is copied to a scratch
 * folder first, because a zip is read from its end; the copy is removed when the walk leaves it.
 */
export async function* expandArchive(entry: ImportEntry, kind: "zip" | "gzip"): AsyncGenerator<Entry> {
  if (kind === "gzip") {
    const inner = entry.name.replace(/\.gz$/i, "") || "content";
    yield new Entry(`${entry.path} › ${inner}`, inner, null, entry.modifiedMs, null, () => gunzip(entry));
    return;
  }
  let file = entry.diskPath;
  let scratch: string | null = null;
  try {
    if (!file) {
      scratch = await fs.mkdtemp(path.join(os.tmpdir(), "memex-import-"));
      file = path.join(scratch, "archive.zip");
      await pipeline(Readable.from(entry.chunks()), createWriteStream(file));
    }
    const zipFile = file;
    const members = await readZipDirectory(zipFile);
    for (const member of members) {
      if (member.name.endsWith("/")) continue;
      const name = member.name.split("/").pop() ?? member.name;
      yield new Entry(`${entry.path} › ${member.name}`, name, member.size, member.mtime.getTime(), null, () => openZipEntry(zipFile, member));
    }
  } finally {
    if (scratch) await fs.rm(scratch, { recursive: true, force: true });
  }
}

async function* gunzip(entry: ImportEntry): AsyncIterable<Buffer> {
  const source = Readable.from(entry.chunks());
  const inflate = createGunzip({ chunkSize: 1 << 20 });
  source.on("error", (error) => inflate.destroy(error));
  for await (const chunk of source.pipe(inflate)) yield chunk as Buffer;
}
