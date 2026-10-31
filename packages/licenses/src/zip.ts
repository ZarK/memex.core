import fs from "node:fs";
import { inflateRawSync } from "node:zlib";

export class ZipReadError extends Error {}

function readAt(fd: number, offset: number, length: number): Buffer {
  const buf = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const n = fs.readSync(fd, buf, done, length - done, offset + done);
    if (n === 0) break;
    done += n;
  }
  return buf.subarray(0, done);
}

/**
 * Reads named entries from a zip file without reading the whole archive. Supports stored and
 * deflated entries and ZIP64 sizes. Returns the entries that exist, by name.
 */
export function readZipEntries(file: string, wanted: (name: string) => boolean, maxBytes = 64 * 1024 * 1024): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const tailLen = Math.min(size, 65557);
    const tail = readAt(fd, size - tailLen, tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd === -1) throw new ZipReadError(`${file}: not a zip file`);
    let count = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOffset = tail.readUInt32LE(eocd + 16);
    if (cdOffset === 0xffffffff || count === 0xffff) {
      const locator = eocd - 20;
      if (locator < 0 || tail.readUInt32LE(locator) !== 0x07064b50) throw new ZipReadError(`${file}: ZIP64 locator missing`);
      const z64Offset = Number(tail.readBigUInt64LE(locator + 8));
      const z64 = readAt(fd, z64Offset, 56);
      if (z64.readUInt32LE(0) !== 0x06064b50) throw new ZipReadError(`${file}: ZIP64 record missing`);
      count = Number(z64.readBigUInt64LE(32));
      cdSize = Number(z64.readBigUInt64LE(40));
      cdOffset = Number(z64.readBigUInt64LE(48));
    }
    const cd = readAt(fd, cdOffset, cdSize);
    let p = 0;
    for (let n = 0; n < count && p + 46 <= cd.length; n++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) throw new ZipReadError(`${file}: bad central directory`);
      const method = cd.readUInt16LE(p + 10);
      let compressed = cd.readUInt32LE(p + 20);
      let uncompressed = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      let localOffset = cd.readUInt32LE(p + 42);
      const name = cd.subarray(p + 46, p + 46 + nameLen).toString("utf8");
      const extra = cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
      for (let e = 0; e + 4 <= extra.length; ) {
        const id = extra.readUInt16LE(e);
        const len = extra.readUInt16LE(e + 2);
        if (id === 0x0001) {
          let q = e + 4;
          if (uncompressed === 0xffffffff) (uncompressed = Number(extra.readBigUInt64LE(q))), (q += 8);
          if (compressed === 0xffffffff) (compressed = Number(extra.readBigUInt64LE(q))), (q += 8);
          if (localOffset === 0xffffffff) localOffset = Number(extra.readBigUInt64LE(q));
        }
        e += 4 + len;
      }
      p += 46 + nameLen + extraLen + commentLen;
      if (!wanted(name) || name.endsWith("/")) continue;
      if (uncompressed > maxBytes) throw new ZipReadError(`${file}: ${name} is larger than ${maxBytes} bytes`);
      const local = readAt(fd, localOffset, 30);
      if (local.readUInt32LE(0) !== 0x04034b50) throw new ZipReadError(`${file}: bad local header for ${name}`);
      const dataOffset = localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
      const raw = readAt(fd, dataOffset, compressed);
      let data: Buffer;
      if (method === 0) data = raw;
      else if (method === 8) data = inflateRawSync(raw, { maxOutputLength: maxBytes });
      else throw new ZipReadError(`${file}: ${name} uses compression method ${method}`);
      out.set(name, data);
    }
  } finally {
    fs.closeSync(fd);
  }
  return out;
}
