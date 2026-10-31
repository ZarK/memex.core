import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ZipWriter, readZipDirectory, readZipEntry, openZipEntry } from "../src/zip.js";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "memex-zip-test-"));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

/** A command that answers --version, or null when it is not installed. */
function tool(command: string, args: string[] = ["--version"]): string | null {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return result.status === 0 ? `${result.stdout}${result.stderr}` : null;
}

const python = ["python3", "python"].find((p) => (tool(p) ?? "").startsWith("Python 3")) ?? null;
// Git Bash puts GNU tar first on Windows; bsdtar (which reads zip) is the Windows one.
const bsdtar = [process.platform === "win32" ? "C:\\Windows\\System32\\tar.exe" : "tar", "bsdtar"].find((t) =>
  (tool(t) ?? "").includes("bsdtar"),
) ?? null;

async function writeSample(file: string) {
  const big = randomBytes(300_000);
  const zip = await ZipWriter.create(file);
  await zip.add("records/records.jsonl", Buffer.from('{"id":"1"}\n{"id":"2"}\n'), { mtime: new Date(2026, 9, 24, 3, 15, 2) });
  await zip.add("files/home/p/ø unicode.txt", Buffer.from("blåbær\n"));
  await zip.add("attachments/ab/big.bin", (async function* () {
    for (let i = 0; i < big.length; i += 65536) yield big.subarray(i, i + 65536);
  })());
  await zip.add("empty", Buffer.alloc(0));
  await zip.close();
  return big;
}

describe("zip writer and reader", () => {
  it("writes entries that read back with their CRC checked", async () => {
    const file = path.join(tmp, "a.zip");
    const big = await writeSample(file);
    const entries = await readZipDirectory(file);
    expect(entries.map((e) => e.name)).toEqual(["records/records.jsonl", "files/home/p/ø unicode.txt", "attachments/ab/big.bin", "empty"]);
    expect((await readZipEntry(file, entries[0]!)).toString()).toBe('{"id":"1"}\n{"id":"2"}\n');
    expect((await readZipEntry(file, entries[1]!)).toString()).toBe("blåbær\n");
    expect((await readZipEntry(file, entries[2]!)).equals(big)).toBe(true);
    expect((await readZipEntry(file, entries[3]!)).length).toBe(0);
    expect(entries[0]!.mtime.getMinutes()).toBe(15);
  });

  it("drops an entry whose check fails and goes on with the next one", async () => {
    const file = path.join(tmp, "b.zip");
    const zip = await ZipWriter.create(file);
    await zip.add("one", Buffer.from("1"));
    await expect(zip.add("two", Buffer.from("2".repeat(1000)), { check: () => { throw new Error("changed"); } })).rejects.toThrow("changed");
    await zip.add("three", Buffer.from("3"));
    await zip.close();
    const entries = await readZipDirectory(file);
    expect(entries.map((e) => e.name)).toEqual(["one", "three"]);
    expect((await readZipEntry(file, entries[1]!)).toString()).toBe("3");
  });

  it("reports a damaged entry", async () => {
    const file = path.join(tmp, "c.zip");
    const zip = await ZipWriter.create(file);
    await zip.add("x", Buffer.from("hello hello hello hello"));
    await zip.close();
    const [entry] = await readZipDirectory(file);
    const stream = await openZipEntry(file, entry!);
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe("hello hello hello hello");
    const bad = { ...entry!, crc32: (entry!.crc32 ^ 1) >>> 0 };
    await expect(readZipEntry(file, bad)).rejects.toThrow(/CRC-32/);
    // A changed byte in the compressed data fails too, in inflate or in the CRC check.
    const data = await fs.readFile(file);
    data[30 + 1 + 2] ^= 0xff;
    await fs.writeFile(file, data);
    await expect(readZipEntry(file, entry!)).rejects.toThrow();
  });

  it("refuses a file that is not a zip", async () => {
    const file = path.join(tmp, "not.zip");
    await fs.writeFile(file, "plain text");
    await expect(readZipDirectory(file)).rejects.toThrow(/end record/);
  });

  it.skipIf(python === null)("passes python -m zipfile -t", async () => {
    const file = path.join(tmp, "py.zip");
    await writeSample(file);
    const text = execFileSync(python!, ["-I", "-m", "zipfile", "-t", file], { encoding: "utf8" });
    expect(text).toMatch(/Done testing/);
    const names = execFileSync(python!, ["-I", "-c", "import sys,zipfile;sys.stdout.buffer.write('\\n'.join(zipfile.ZipFile(sys.argv[1]).namelist()).encode())", file], {
      encoding: "utf8",
    });
    expect(names).toContain("files/home/p/ø unicode.txt");
  });

  it.skipIf(bsdtar === null)("lists with tar -tf (bsdtar)", async () => {
    const file = path.join(tmp, "tar.zip");
    await writeSample(file);
    const text = execFileSync(bsdtar!, ["-tf", file], { encoding: "utf8" });
    expect(text.split(/\r?\n/).filter((l) => l !== "")).toContain("records/records.jsonl");
  });
});
