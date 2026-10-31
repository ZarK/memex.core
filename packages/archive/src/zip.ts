import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import { Readable, pipeline as streamPipeline } from "node:stream";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";

/**
 * A size or offset at or above this value does not fit a 32-bit zip field (0xFFFFFFFF itself means
 * "see the ZIP64 field").
 */
export const ZIP32_LIMIT = 0xffffffff;
/** An entry count at or above this value needs the ZIP64 end records. */
export const ZIP32_MAX_ENTRIES = 0xffff;

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_RECORD = 0x06054b50;
const ZIP64_END_RECORD = 0x06064b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_EXTRA = 0x0001;
const UTF8_FLAG = 0x0800;
const DATA_DESCRIPTOR_FLAG = 0x0008;
const DEFLATE = 8;
const VERSION = 20;
/** The version needed to extract an entry or a zip that uses ZIP64 (APPNOTE 4.4.3.2). */
const VERSION_ZIP64 = 45;

export class ZipError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ZipError";
    this.code = code;
  }
}

/**
 * The most bytes raw deflate can make of n input bytes: zlib's deflateBound(), with room to spare.
 * Incompressible data grows a little, so an entry just below 4 GiB can deflate to 4 GiB or more.
 */
export function deflateBound(n: number): number {
  return n + Math.floor(n / 4096) + Math.floor(n / 16384) + Math.floor(n / 33554432) + 64;
}

/** True when an entry of this uncompressed size may need ZIP64 sizes. */
export function needsZip64Sizes(size: number): boolean {
  return deflateBound(size) >= ZIP32_LIMIT;
}

function readU64(buffer: Buffer, at: number): number {
  const value = buffer.readBigUInt64LE(at);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new ZipError("not-a-zip", "A ZIP64 value is too large");
  return Number(value);
}

/** The data of the extra field with this tag, or null. */
function findExtra(extra: Buffer, tag: number): Buffer | null {
  let at = 0;
  while (at + 4 <= extra.length) {
    const id = extra.readUInt16LE(at);
    const length = extra.readUInt16LE(at + 2);
    if (at + 4 + length > extra.length) break;
    if (id === tag) return extra.subarray(at + 4, at + 4 + length);
    at += 4 + length;
  }
  return null;
}

/** Reads the 8-byte values of a ZIP64 extra field in order. */
function zip64Values(field: Buffer | null, what: string): () => number {
  let next = 0;
  return () => {
    if (field === null || next + 8 > field.length) throw new ZipError("not-a-zip", `${what} has no ZIP64 field for a 0xFFFFFFFF value`);
    const v = readU64(field, next);
    next += 8;
    return v;
  };
}

/** MS-DOS date and time (local time, two-second steps), as zip headers store them. */
function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.min(Math.max(date.getFullYear(), 1980), 2107);
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

function fromDosDateTime(time: number, date: number): Date {
  return new Date(1980 + (date >> 9), ((date >> 5) & 0xf) - 1, date & 0x1f, time >> 11, (time >> 5) & 0x3f, (time & 0x1f) * 2);
}

export interface ZipEntryInfo {
  name: string;
  /** Uncompressed size. */
  size: number;
  compressedSize: number;
  crc32: number;
  /** Offset of the local header in the zip file. */
  offset: number;
  mtime: Date;
}

/** An entry as the writer keeps it for the central directory. */
export interface WrittenEntry extends ZipEntryInfo {
  /** The local header has a ZIP64 extra field with both sizes. */
  localZip64: boolean;
}

export interface AddOptions {
  /** Stored as the entry's DOS time. Defaults to now. */
  mtime?: Date;
  /**
   * The uncompressed size, when known before the write. An entry that may deflate to 4 GiB or
   * more (needsZip64Sizes) gets a ZIP64 extra field in its local header. An entry without one
   * whose data reaches 4 GiB fails with the code "size-changed", and nothing of it is kept.
   */
  size?: number;
  /**
   * Called after the data is written and before the entry is kept. When it throws, the entry is
   * removed from the file again and the error is thrown.
   */
  check?: (info: ZipEntryInfo) => void | Promise<void>;
}

function hasZip64Sizes(e: WrittenEntry): boolean {
  return e.localZip64 || e.size >= ZIP32_LIMIT || e.compressedSize >= ZIP32_LIMIT;
}

function usesZip64(e: WrittenEntry): boolean {
  return hasZip64Sizes(e) || e.offset >= ZIP32_LIMIT;
}

/**
 * The central header of one entry. Its ZIP64 extra field holds, in this order, both sizes (for an
 * entry whose local header has them in ZIP64) and the local header offset (at 4 GiB or more); the
 * matching 32-bit fields are 0xFFFFFFFF and the version needed is 45. Other entries stay plain.
 */
export function centralHeader(e: WrittenEntry): Buffer {
  const nameBytes = Buffer.from(e.name, "utf8");
  const dos = dosDateTime(e.mtime);
  const bigSizes = hasZip64Sizes(e);
  const bigOffset = e.offset >= ZIP32_LIMIT;
  const values: number[] = [];
  if (bigSizes) values.push(e.size, e.compressedSize);
  if (bigOffset) values.push(e.offset);
  const extraLength = values.length === 0 ? 0 : 4 + 8 * values.length;
  const version = values.length === 0 ? VERSION : VERSION_ZIP64;
  const h = Buffer.alloc(46 + nameBytes.length + extraLength);
  h.writeUInt32LE(CENTRAL_HEADER, 0);
  h.writeUInt16LE(version, 4);
  h.writeUInt16LE(version, 6);
  h.writeUInt16LE(UTF8_FLAG, 8);
  h.writeUInt16LE(DEFLATE, 10);
  h.writeUInt16LE(dos.time, 12);
  h.writeUInt16LE(dos.date, 14);
  h.writeUInt32LE(e.crc32, 16);
  h.writeUInt32LE(bigSizes ? ZIP32_LIMIT : e.compressedSize, 20);
  h.writeUInt32LE(bigSizes ? ZIP32_LIMIT : e.size, 24);
  h.writeUInt16LE(nameBytes.length, 28);
  h.writeUInt16LE(extraLength, 30);
  // Comment, disk number, internal and external attributes stay 0.
  h.writeUInt32LE(bigOffset ? ZIP32_LIMIT : e.offset, 42);
  nameBytes.copy(h, 46);
  if (values.length > 0) {
    let at = 46 + nameBytes.length;
    h.writeUInt16LE(ZIP64_EXTRA, at);
    h.writeUInt16LE(8 * values.length, at + 2);
    at += 4;
    for (const v of values) {
      h.writeBigUInt64LE(BigInt(v), at);
      at += 8;
    }
  }
  return h;
}

/**
 * The records after the central directory: the ZIP64 end record and its locator when they are
 * needed, then the end record, in which a value that does not fit is 0xFFFF or 0xFFFFFFFF.
 */
export function endRecords(count: number, directoryOffset: number, directorySize: number, anyZip64: boolean): Buffer {
  const zip64 = anyZip64 || count >= ZIP32_MAX_ENTRIES || directoryOffset >= ZIP32_LIMIT || directorySize >= ZIP32_LIMIT;
  const parts: Buffer[] = [];
  if (zip64) {
    const record = Buffer.alloc(56);
    record.writeUInt32LE(ZIP64_END_RECORD, 0);
    record.writeBigUInt64LE(44n, 4);
    record.writeUInt16LE(VERSION_ZIP64, 12);
    record.writeUInt16LE(VERSION_ZIP64, 14);
    // This disk and the disk of the central directory stay 0.
    record.writeBigUInt64LE(BigInt(count), 24);
    record.writeBigUInt64LE(BigInt(count), 32);
    record.writeBigUInt64LE(BigInt(directorySize), 40);
    record.writeBigUInt64LE(BigInt(directoryOffset), 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(ZIP64_LOCATOR, 0);
    locator.writeBigUInt64LE(BigInt(directoryOffset + directorySize), 8);
    locator.writeUInt32LE(1, 16);
    parts.push(record, locator);
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_RECORD, 0);
  end.writeUInt16LE(Math.min(count, ZIP32_MAX_ENTRIES), 8);
  end.writeUInt16LE(Math.min(count, ZIP32_MAX_ENTRIES), 10);
  end.writeUInt32LE(Math.min(directorySize, ZIP32_LIMIT), 12);
  end.writeUInt32LE(Math.min(directoryOffset, ZIP32_LIMIT), 16);
  parts.push(end);
  return Buffer.concat(parts);
}

/**
 * Writes a zip file entry by entry: a local header, the deflated data, then the CRC-32 and sizes
 * patched into the local header with positional writes. close() writes the central directory.
 * No data descriptors, UTF-8 names. One add() at a time.
 *
 * ZIP64 is used only where it is needed, so a small zip has no ZIP64 structures at all:
 * - A local header gets a ZIP64 extra field (sizes 0xFFFFFFFF, the real sizes patched into the
 *   field after the data) when the size given to add() may deflate to 4 GiB or more. The header is
 *   written before the data, so this is decided from the size known before streaming. A source
 *   that reaches 4 GiB without the field fails rather than leaving a header that cannot hold it.
 * - A central header gets a ZIP64 extra field for the sizes of such an entry and for a local
 *   header offset of 4 GiB or more (centralHeader).
 * - The ZIP64 end record and locator are written when an entry uses ZIP64, when the central
 *   directory starts at 4 GiB or more or is that large, or for 65,535 entries or more (endRecords).
 */
export class ZipWriter {
  private readonly entries: WrittenEntry[] = [];
  private position = 0;
  private compressed = 0;
  private busy = false;
  private closed = false;

  private constructor(
    readonly file: string,
    private readonly handle: fs.FileHandle,
  ) {}

  /** Creates the zip file. Fails when it already exists. */
  static async create(file: string): Promise<ZipWriter> {
    return new ZipWriter(file, await fs.open(file, "wx"));
  }

  /** Bytes written so far. */
  get bytes(): number {
    return this.position;
  }

  /** Compressed data written so far, without headers. */
  get compressedBytes(): number {
    return this.compressed;
  }

  get count(): number {
    return this.entries.length;
  }

  private async writeAt(data: Uint8Array, position: number): Promise<void> {
    let done = 0;
    while (done < data.length) {
      const { bytesWritten } = await this.handle.write(data, done, data.length - done, position + done);
      done += bytesWritten;
    }
  }

  /** Adds one entry. data is the bytes or a stream of chunks. */
  async add(name: string, data: Uint8Array | AsyncIterable<Uint8Array>, options: AddOptions = {}): Promise<ZipEntryInfo> {
    if (this.closed) throw new ZipError("closed", `The zip is closed: ${this.file}`);
    if (this.busy) throw new ZipError("busy", "One add() at a time");
    const nameBytes = Buffer.from(name, "utf8");
    if (nameBytes.length === 0 || nameBytes.length > 0xffff) throw new ZipError("invalid-name", `Not a usable entry name: ${name}`);
    this.busy = true;
    const start = this.position;
    try {
      const mtime = options.mtime ?? new Date();
      const dos = dosDateTime(mtime);
      const zip64 = options.size !== undefined && needsZip64Sizes(options.size);
      const extraLength = zip64 ? 20 : 0;
      const header = Buffer.alloc(30 + nameBytes.length + extraLength);
      header.writeUInt32LE(LOCAL_HEADER, 0);
      header.writeUInt16LE(zip64 ? VERSION_ZIP64 : VERSION, 4);
      header.writeUInt16LE(UTF8_FLAG, 6);
      header.writeUInt16LE(DEFLATE, 8);
      header.writeUInt16LE(dos.time, 10);
      header.writeUInt16LE(dos.date, 12);
      // The CRC-32 (14) and the sizes (18 and 22, or the ZIP64 field) are patched in after the data.
      if (zip64) {
        header.writeUInt32LE(ZIP32_LIMIT, 18);
        header.writeUInt32LE(ZIP32_LIMIT, 22);
      }
      header.writeUInt16LE(nameBytes.length, 26);
      header.writeUInt16LE(extraLength, 28);
      nameBytes.copy(header, 30);
      if (zip64) {
        header.writeUInt16LE(ZIP64_EXTRA, 30 + nameBytes.length);
        header.writeUInt16LE(16, 32 + nameBytes.length);
      }
      await this.writeAt(header, start);

      let crc = 0;
      let size = 0;
      const dataStart = start + header.length;
      let at = dataStart;
      const grew = () =>
        new ZipError("size-changed", `${name} reached 4 GiB, but the size given before the write did not call for ZIP64`);
      const source = data instanceof Uint8Array ? [data] : data;
      await pipeline(
        async function* () {
          for await (const chunk of source) {
            size += chunk.length;
            if (!zip64 && size >= ZIP32_LIMIT) throw grew();
            crc = zlib.crc32(chunk, crc);
            yield chunk;
          }
        },
        zlib.createDeflateRaw(),
        async (deflated: AsyncIterable<Buffer>) => {
          for await (const out of deflated) {
            await this.writeAt(out, at);
            at += out.length;
            if (!zip64 && at - dataStart >= ZIP32_LIMIT) throw grew();
          }
        },
      );
      const compressedSize = at - dataStart;
      const info: ZipEntryInfo = { name, size, compressedSize, crc32: crc, offset: start, mtime };
      if (options.check !== undefined) await options.check(info);

      const crcBytes = Buffer.alloc(4);
      crcBytes.writeUInt32LE(crc, 0);
      await this.writeAt(crcBytes, start + 14);
      const sizes = Buffer.alloc(zip64 ? 16 : 8);
      if (zip64) {
        // The ZIP64 field of a local header holds the uncompressed size, then the compressed size.
        sizes.writeBigUInt64LE(BigInt(size), 0);
        sizes.writeBigUInt64LE(BigInt(compressedSize), 8);
        await this.writeAt(sizes, start + 34 + nameBytes.length);
      } else {
        sizes.writeUInt32LE(compressedSize, 0);
        sizes.writeUInt32LE(size, 4);
        await this.writeAt(sizes, start + 18);
      }
      this.position = at;
      this.compressed += compressedSize;
      this.entries.push({ ...info, localZip64: zip64 });
      return info;
    } catch (error) {
      // Drop what this entry wrote, so the next entry starts where it started.
      await this.handle.truncate(start);
      throw error;
    } finally {
      this.busy = false;
    }
  }

  /** Writes the central directory and the end records, and closes the file. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      const directory = Buffer.concat(this.entries.map(centralHeader));
      const tail = endRecords(this.entries.length, this.position, directory.length, this.entries.some(usesZip64));
      await this.writeAt(Buffer.concat([directory, tail]), this.position);
      this.position += directory.length + tail.length;
    } finally {
      await this.handle.close();
    }
  }

  /** Closes the file without finishing it. */
  async abort(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.handle.close();
  }
}

export interface ZipEntry {
  name: string;
  size: number;
  compressedSize: number;
  crc32: number;
  method: number;
  /** Offset of the local header. */
  offset: number;
  mtime: Date;
}

async function readAt(handle: fs.FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const { bytesRead } = await handle.read(buffer, done, length - done, position + done);
    if (bytesRead === 0) break;
    done += bytesRead;
  }
  return done === length ? buffer : buffer.subarray(0, done);
}

/** Parses count central headers, with the values in their ZIP64 extra fields. */
export function parseCentralDirectory(directory: Buffer, count: number, file: string): ZipEntry[] {
  const entries: ZipEntry[] = [];
  let at = 0;
  for (let i = 0; i < count; i++) {
    if (at + 46 > directory.length || directory.readUInt32LE(at) !== CENTRAL_HEADER) {
      throw new ZipError("not-a-zip", `Broken central directory: ${file}`);
    }
    const nameLength = directory.readUInt16LE(at + 28);
    const extraLength = directory.readUInt16LE(at + 30);
    const commentLength = directory.readUInt16LE(at + 32);
    if (at + 46 + nameLength + extraLength + commentLength > directory.length) {
      throw new ZipError("not-a-zip", `Broken central directory: ${file}`);
    }
    const name = directory.toString("utf8", at + 46, at + 46 + nameLength);
    let compressedSize = directory.readUInt32LE(at + 20);
    let size = directory.readUInt32LE(at + 24);
    let offset = directory.readUInt32LE(at + 42);
    if (size === ZIP32_LIMIT || compressedSize === ZIP32_LIMIT || offset === ZIP32_LIMIT) {
      const extraAt = at + 46 + nameLength;
      const next = zip64Values(findExtra(directory.subarray(extraAt, extraAt + extraLength), ZIP64_EXTRA), `${file}: ${name}`);
      // APPNOTE 4.5.3: the values that are 0xFFFFFFFF in the header, in this order.
      if (size === ZIP32_LIMIT) size = next();
      if (compressedSize === ZIP32_LIMIT) compressedSize = next();
      if (offset === ZIP32_LIMIT) offset = next();
    }
    entries.push({
      name,
      method: directory.readUInt16LE(at + 10),
      mtime: fromDosDateTime(directory.readUInt16LE(at + 12), directory.readUInt16LE(at + 14)),
      crc32: directory.readUInt32LE(at + 16),
      compressedSize,
      size,
      offset,
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/**
 * Reads the central directory of a zip file: finds the end record (and the ZIP64 end record when a
 * locator comes before it), then parses every entry.
 */
export async function readZipDirectory(file: string): Promise<ZipEntry[]> {
  const handle = await fs.open(file, "r");
  try {
    const { size } = await handle.stat();
    const tailLength = Math.min(size, 22 + 0xffff);
    const tail = await readAt(handle, size - tailLength, tailLength);
    let endAt = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === END_RECORD) {
        endAt = i;
        break;
      }
    }
    if (endAt < 0) throw new ZipError("not-a-zip", `No zip end record: ${file}`);
    let count = tail.readUInt16LE(endAt + 10);
    let directorySize = tail.readUInt32LE(endAt + 12);
    let directoryOffset = tail.readUInt32LE(endAt + 16);
    const endPosition = size - tailLength + endAt;
    if (endPosition >= 20) {
      const locator = await readAt(handle, endPosition - 20, 20);
      if (locator.readUInt32LE(0) === ZIP64_LOCATOR) {
        const recordAt = readU64(locator, 8);
        const record = recordAt + 56 <= endPosition ? await readAt(handle, recordAt, 56) : Buffer.alloc(0);
        if (record.length < 56 || record.readUInt32LE(0) !== ZIP64_END_RECORD) {
          throw new ZipError("not-a-zip", `No ZIP64 end record where its locator points: ${file}`);
        }
        count = readU64(record, 32);
        directorySize = readU64(record, 40);
        directoryOffset = readU64(record, 48);
      }
    }
    if (directoryOffset + directorySize > size) throw new ZipError("not-a-zip", `The central directory is outside the file: ${file}`);
    const directory = await readAt(handle, directoryOffset, directorySize);
    return parseCentralDirectory(directory, count, file);
  } finally {
    await handle.close();
  }
}

/**
 * A stream of one entry's bytes. The stream fails at its end when the CRC-32 or the size does
 * not match the central directory. A local header with ZIP64 sizes must match it too.
 */
export async function openZipEntry(file: string, entry: ZipEntry): Promise<Readable> {
  if (entry.method !== DEFLATE && entry.method !== 0) {
    throw new ZipError("unsupported", `Compression method ${entry.method} is not supported: ${entry.name}`);
  }
  const handle = await fs.open(file, "r");
  let header: Buffer;
  let extra: Buffer;
  try {
    header = await readAt(handle, entry.offset, 30);
    if (header.length < 30 || header.readUInt32LE(0) !== LOCAL_HEADER) throw new ZipError("not-a-zip", `No local header for ${entry.name}`);
    extra = await readAt(handle, entry.offset + 30 + header.readUInt16LE(26), header.readUInt16LE(28));
  } finally {
    await handle.close();
  }
  const start = entry.offset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
  // With a data descriptor, the local sizes may be 0 or stale; the central directory decides.
  const localCompressed = header.readUInt32LE(18);
  const localSize = header.readUInt32LE(22);
  if ((localSize === ZIP32_LIMIT || localCompressed === ZIP32_LIMIT) && (header.readUInt16LE(6) & DATA_DESCRIPTOR_FLAG) === 0) {
    const next = zip64Values(findExtra(extra, ZIP64_EXTRA), `The local header of ${entry.name}`);
    const size = localSize === ZIP32_LIMIT ? next() : localSize;
    const compressedSize = localCompressed === ZIP32_LIMIT ? next() : localCompressed;
    if (size !== entry.size || compressedSize !== entry.compressedSize) {
      throw new ZipError("not-a-zip", `The ZIP64 sizes in the local header of ${entry.name} do not match the central directory`);
    }
  }

  async function* bytes(): AsyncGenerator<Buffer> {
    const raw = entry.compressedSize === 0 ? Readable.from([]) : createReadStream(file, { start, end: start + entry.compressedSize - 1 });
    // pipeline() passes a read error on to the inflate stream, so the loop below throws it.
    const data: AsyncIterable<Buffer> = entry.method === 0 ? raw : streamPipeline(raw, zlib.createInflateRaw(), () => {});
    let crc = 0;
    let size = 0;
    for await (const chunk of data) {
      crc = zlib.crc32(chunk, crc);
      size += chunk.length;
      yield chunk;
    }
    if (crc !== entry.crc32 || size !== entry.size) throw new ZipError("bad-crc", `The CRC-32 or size of ${entry.name} does not match`);
  }
  return Readable.from(bytes());
}

/** Reads one entry into memory, checking its CRC-32. */
export async function readZipEntry(file: string, entry: ZipEntry): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of await openZipEntry(file, entry)) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}
