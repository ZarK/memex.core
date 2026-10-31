import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_ENTRY_BYTES, PackBuilder } from "../src/pack.js";
import {
  ZIP32_LIMIT,
  ZipWriter,
  centralHeader,
  deflateBound,
  endRecords,
  needsZip64Sizes,
  openZipEntry,
  readZipDirectory,
  readZipEntry,
  type WrittenEntry,
} from "../src/zip.js";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "memex-zip64-test-"));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

function tool(command: string, args: string[] = ["--version"]): string | null {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return result.status === 0 ? `${result.stdout}${result.stderr}` : null;
}

const python = ["python3", "python"].find((p) => (tool(p) ?? "").startsWith("Python 3")) ?? null;
const bsdtar = [process.platform === "win32" ? "C:\\Windows\\System32\\tar.exe" : "tar", "bsdtar"].find((t) =>
  (tool(t) ?? "").includes("bsdtar"),
) ?? null;

const GiB = 1024 ** 3;
const mtime = new Date(2026, 9, 24, 3, 15, 2);

function has(data: Buffer, signature: number): boolean {
  const sig = Buffer.alloc(4);
  sig.writeUInt32LE(signature, 0);
  return data.includes(sig);
}

/** Python's view of a zip: [name, file_size, compress_size, header_offset] per entry. */
function pythonInfo(file: string): Array<[string, number, number, number]> {
  const code =
    "import sys,json,zipfile;print(json.dumps([[i.filename,i.file_size,i.compress_size,i.header_offset] for i in zipfile.ZipFile(sys.argv[1]).infolist()]))";
  return JSON.parse(execFileSync(python!, ["-I", "-c", code, file], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
}

/** A file of only a central directory and its end records, as a zip of huge entries ends. */
async function craft(file: string, written: WrittenEntry[]): Promise<Buffer> {
  const directory = Buffer.concat(written.map(centralHeader));
  const data = Buffer.concat([directory, endRecords(written.length, 0, directory.length, written.some((e) => e.localZip64))]);
  await fs.writeFile(file, data);
  return data;
}

describe("ZIP64", () => {
  it("leaves a zip that needs no ZIP64 byte-for-byte as before", async () => {
    // The hash is of the bytes the writer made before ZIP64 support (with this Node's zlib).
    const file = path.join(tmp, "plain.zip");
    const zip = await ZipWriter.create(file);
    await zip.add("records/records.jsonl", Buffer.from('{"id":"1"}\n{"id":"2"}\n'), { mtime });
    await zip.add("files/home/p/\u00f8 unicode.txt", Buffer.from("bl\u00e5b\u00e6r\n"), { mtime });
    const big = Buffer.alloc(300_000);
    for (let i = 0; i < big.length; i++) big[i] = (i * 2654435761) >>> 24;
    await zip.add("attachments/ab/big.bin", big, { mtime, size: big.length });
    await zip.add("empty", Buffer.alloc(0), { mtime });
    await zip.close();
    const data = await fs.readFile(file);
    expect(createHash("sha256").update(data).digest("hex")).toBe("eb165e36f321fe43a22b64b2b4ba58c95e93b86ca20c81abf2cfacdbbc62517e");
    expect(has(data, 0x06064b50)).toBe(false);
  });

  it("calls for ZIP64 sizes from 4 GiB less the deflate overhead", () => {
    expect(needsZip64Sizes(4_000_000_000)).toBe(false);
    expect(needsZip64Sizes(ZIP32_LIMIT - 1)).toBe(true);
    expect(needsZip64Sizes(5 * GiB)).toBe(true);
    expect(deflateBound(ZIP32_LIMIT - 1_100_000)).toBeGreaterThanOrEqual(ZIP32_LIMIT);
  });

  it("writes a ZIP64 local header for an entry announced at 4 GiB or more, and reads it back", async () => {
    // The size given before the write decides the local header; the data here is small.
    const file = path.join(tmp, "z64.zip");
    const zip = await ZipWriter.create(file);
    await zip.add("small", Buffer.from("plain entry"), { mtime });
    const zeros = Buffer.alloc(1024 * 1024);
    await zip.add(
      "big/zeros.bin",
      (async function* () {
        for (let i = 0; i < 8; i++) yield zeros;
      })(),
      { mtime, size: 5 * GiB },
    );
    await zip.add("after", Buffer.from("after the big one"), { mtime });
    await zip.close();

    const data = await fs.readFile(file);
    const entries = await readZipDirectory(file);
    expect(entries.map((e) => [e.name, e.size])).toEqual([
      ["small", 11],
      ["big/zeros.bin", 8 * 1024 * 1024],
      ["after", 17],
    ]);
    const big = entries[1]!;
    // The local header: version 45, sizes 0xFFFFFFFF, and a ZIP64 field with the real sizes.
    expect(data.readUInt16LE(big.offset + 4)).toBe(45);
    expect(data.readUInt32LE(big.offset + 18)).toBe(ZIP32_LIMIT);
    expect(data.readUInt32LE(big.offset + 22)).toBe(ZIP32_LIMIT);
    expect(data.readUInt16LE(big.offset + 28)).toBe(20);
    const extra = big.offset + 30 + "big/zeros.bin".length;
    expect(data.readUInt16LE(extra)).toBe(1);
    expect(Number(data.readBigUInt64LE(extra + 4))).toBe(big.size);
    expect(Number(data.readBigUInt64LE(extra + 12))).toBe(big.compressedSize);
    // The other entries stay plain; the zip has the ZIP64 end record and locator.
    expect(data.readUInt16LE(entries[0]!.offset + 4)).toBe(20);
    expect(data.readUInt16LE(entries[2]!.offset + 4)).toBe(20);
    expect(has(data, 0x06064b50)).toBe(true);
    expect(has(data, 0x07064b50)).toBe(true);
    expect((await readZipEntry(file, big)).equals(Buffer.alloc(8 * 1024 * 1024))).toBe(true);
    expect((await readZipEntry(file, entries[2]!)).toString()).toBe("after the big one");

    // A local header whose ZIP64 sizes do not match the central directory is refused.
    data.writeBigUInt64LE(BigInt(big.size + 1), extra + 4);
    await fs.writeFile(file, data);
    await expect(openZipEntry(file, big)).rejects.toThrow(/local header/);
  });

  it.skipIf(python === null)("passes python -m zipfile -t with a ZIP64 entry", async () => {
    const file = path.join(tmp, "z64py.zip");
    const zip = await ZipWriter.create(file);
    await zip.add("a.txt", Buffer.from("a"), { mtime });
    await zip.add("big.bin", Buffer.alloc(100_000), { mtime, size: 6 * GiB });
    await zip.close();
    expect(execFileSync(python!, ["-I", "-m", "zipfile", "-t", file], { encoding: "utf8" })).toMatch(/Done testing/);
    expect(pythonInfo(file).map((i) => [i[0], i[1]])).toEqual([
      ["a.txt", 1],
      ["big.bin", 100_000],
    ]);
  });

  it.skipIf(bsdtar === null)("lists a ZIP64 zip with tar -tf (bsdtar)", async () => {
    const file = path.join(tmp, "z64tar.zip");
    const zip = await ZipWriter.create(file);
    await zip.add("big.bin", Buffer.alloc(100_000), { mtime, size: 6 * GiB });
    await zip.close();
    expect(execFileSync(bsdtar!, ["-tf", file], { encoding: "utf8" })).toContain("big.bin");
  });

  it("encodes and reads sizes and offsets of 4 GiB and more in the central directory", async () => {
    const file = path.join(tmp, "crafted.zip");
    const written: WrittenEntry[] = [
      { name: "huge.bin", size: 6 * GiB, compressedSize: 5 * GiB, crc32: 1, offset: 0, mtime, localZip64: true },
      { name: "after-huge.txt", size: 10, compressedSize: 12, crc32: 2, offset: 5 * GiB + 70, mtime, localZip64: false },
      { name: "exactly.bin", size: ZIP32_LIMIT, compressedSize: ZIP32_LIMIT + 9, crc32: 3, offset: ZIP32_LIMIT, mtime, localZip64: true },
      { name: "plain.txt", size: 3, compressedSize: 5, crc32: 4, offset: 100, mtime, localZip64: false },
    ];
    const data = await craft(file, written);
    const entries = await readZipDirectory(file);
    expect(entries.map((e) => [e.name, e.size, e.compressedSize, e.offset, e.crc32])).toEqual(
      written.map((e) => [e.name, e.size, e.compressedSize, e.offset, e.crc32]),
    );
    // Version needed 45 only where ZIP64 is used.
    let at = 0;
    const versions: number[] = [];
    for (const e of written) {
      versions.push(data.readUInt16LE(at + 6));
      at += 46 + e.name.length + data.readUInt16LE(at + 30);
    }
    expect(versions).toEqual([45, 45, 45, 20]);
    if (python !== null) expect(pythonInfo(file)).toEqual(written.map((e) => [e.name, e.size, e.compressedSize, e.offset]));
  });

  it("writes the ZIP64 end records for 65,535 entries or more", async () => {
    const count = 65_536;
    const written: WrittenEntry[] = [];
    for (let i = 0; i < count; i++) written.push({ name: `e/${i}`, size: 1, compressedSize: 3, crc32: i, offset: i * 40, mtime, localZip64: false });
    const file = path.join(tmp, "many.zip");
    const data = await craft(file, written);
    const end = data.length - 22;
    expect(data.readUInt16LE(end + 10)).toBe(0xffff);
    expect(data.readUInt32LE(end - 20)).toBe(0x07064b50);
    const entries = await readZipDirectory(file);
    expect(entries.length).toBe(count);
    expect(entries[count - 1]!.name).toBe(`e/${count - 1}`);
    if (python !== null) expect(pythonInfo(file).length).toBe(count);
    // 65,534 entries stay without the ZIP64 end records.
    expect(has(await craft(file, written.slice(0, 65_534)), 0x06064b50)).toBe(false);
  });

  it("writes and reads a real zip of 65,536 entries", { timeout: 120_000 }, async () => {
    const file = path.join(tmp, "many-real.zip");
    const zip = await ZipWriter.create(file);
    for (let i = 0; i < 65_536; i++) await zip.add(`e/${i}`, Buffer.from(String(i)), { mtime });
    await zip.close();
    const entries = await readZipDirectory(file);
    expect(entries.length).toBe(65_536);
    expect((await readZipEntry(file, entries[65_535]!)).toString()).toBe("65535");
    if (python !== null) expect(execFileSync(python, ["-I", "-m", "zipfile", "-t", file], { encoding: "utf8" })).toMatch(/Done testing/);
  });
});

describe("pack parts with large entries", () => {
  const ref = { domain: "imports", source: "2026-10-24-test", device: "import", runId: "20261024T031500Z-3f9a0c1e" };

  async function add(pack: PackBuilder, name: string, bytes: number) {
    pack.reserve(name);
    await pack.add(name, Buffer.alloc(bytes), { size: bytes, describe: (info) => ({ entry: name, kind: "attachment", size: info.size, sha256: "" }) });
  }

  it("puts an entry larger than the part size into a part of its own", async () => {
    const pack = new PackBuilder(path.join(tmp, "staging"), ref, { partBytes: 1000 });
    await add(pack, "a", 300);
    await add(pack, "b", 300);
    // Zeros compress to almost nothing: the part is far from full, but big still gets a part of its own,
    // and the next entry starts a new part. An entry exactly as large as a part is a normal entry.
    await add(pack, "big", 5000);
    await add(pack, "c", 300);
    await add(pack, "exact", 1000);
    const parts = await pack.close();
    expect(parts.map((p) => p.manifest.entries.map((e) => ("entry" in e ? e.entry : "")))).toEqual([["a", "b"], ["big"], ["c", "exact"]]);
  });

  it("refuses an entry above 64 GiB as too large for a pack", async () => {
    const pack = new PackBuilder(path.join(tmp, "staging"), ref);
    pack.reserve("huge");
    await expect(
      pack.add("huge", Buffer.alloc(1), { size: MAX_ENTRY_BYTES + 1, describe: () => ({ entry: "huge", kind: "attachment", size: 1, sha256: "" }) }),
    ).rejects.toMatchObject({ code: "too-large", message: expect.stringMatching(/^too large for a pack/) });
    expect(MAX_ENTRY_BYTES).toBe(64 * GiB);
  });
});
