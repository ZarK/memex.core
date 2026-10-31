/**
 * Opt-in: real entries above 4 GiB, through importFolder, the reader, readFileVersion, the CLI and
 * python -m zipfile -t. It writes about 17 GB into the folder named by MEMEX_ARCHIVE_LARGE_TEST
 * (for example D:/scratch on a drive with room) and takes a few minutes:
 *
 *   MEMEX_ARCHIVE_LARGE_TEST=D:/scratch pnpm --filter @tjalve/memex-archive test zip64-large
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { checkArchive, importFolder, openFileVersion, openPack, readFileVersion } from "../src/index.js";

const LARGE_DIR = process.env.MEMEX_ARCHIVE_LARGE_TEST;
const python = ["python3", "python"].find((p) => {
  const r = spawnSync(p, ["--version"], { encoding: "utf8" });
  return r.status === 0 && `${r.stdout}${r.stderr}`.startsWith("Python 3");
});

/** 4.2 GiB, rounded to whole MiB. */
const SIZE = Math.round(4.2 * 1024) * 1024 * 1024;
const MiB = 1024 * 1024;
const LONG = 30 * 60 * 1000;

/** Writes SIZE bytes of one repeated 1 MiB block and returns their SHA-256. */
async function writeBlocks(file: string, block: Buffer): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(
    (async function* () {
      for (let done = 0; done < SIZE; done += MiB) {
        hash.update(block);
        yield block;
      }
    })(),
    createWriteStream(file),
  );
  return hash.digest("hex");
}

async function streamSha(data: AsyncIterable<Buffer | Uint8Array>): Promise<{ sha256: string; size: number }> {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of data) {
    hash.update(chunk);
    size += chunk.length;
  }
  return { sha256: hash.digest("hex"), size };
}

describe.skipIf(LARGE_DIR === undefined)("entries above 4 GiB (opt-in)", () => {
  let tmp: string;
  let root: string;
  let dir: string;
  const sha: Record<string, string> = {};

  beforeAll(async () => {
    tmp = await fs.mkdtemp(path.join(LARGE_DIR!, "memex-zip64-large-"));
    const folder = path.join(tmp, "drop");
    await fs.mkdir(folder);
    root = path.join(tmp, "Archive");
    // Zeros deflate to almost nothing: a ZIP64 size with small offsets.
    sha["zeros.bin"] = await writeBlocks(path.join(folder, "zeros.bin"), Buffer.alloc(MiB));
    // A random 1 MiB block repeated is out of reach of deflate's 32 KiB window: the part passes
    // 4 GiB, so its manifest.json has a ZIP64 offset and its central directory starts above 4 GiB.
    sha["random.bin"] = await writeBlocks(path.join(folder, "random.bin"), randomBytes(MiB));
    await fs.writeFile(path.join(folder, "small.txt"), "a small file\n");
    sha["small.txt"] = createHash("sha256").update("a small file\n").digest("hex");
    const result = await importFolder({
      root,
      folder,
      name: "zip64-large",
      date: "2026-10-24",
      lockDir: path.join(tmp, "locks"),
      cacheDir: path.join(tmp, "cache"),
    });
    expect(result.failed).toEqual([]);
    expect(result.ok).toBe(true);
    dir = result.dir;
  }, LONG);

  afterAll(async () => {
    if (tmp !== undefined) await fs.rm(tmp, { recursive: true, force: true });
  }, LONG);

  it("stores each large file in a part of its own that the library reads back", async () => {
    const packs = await fs.readdir(path.join(dir, "packs", "2026"));
    expect(packs.length).toBe(3);
    const seen: string[] = [];
    for (const name of packs) {
      const pack = await openPack(path.join(dir, "packs", "2026", name));
      for (const e of pack.entries.filter((x) => x.name !== "manifest.json")) {
        seen.push(e.name);
        const id = e.name.slice("files/".length);
        expect(await streamSha(await pack.open(e.name))).toEqual({ sha256: sha[id], size: id === "small.txt" ? 13 : SIZE });
      }
    }
    expect(seen.sort()).toEqual(["files/random.bin", "files/small.txt", "files/zeros.bin"]);
    const random = (await Promise.all(packs.map((n) => openPack(path.join(dir, "packs", "2026", n))))).find((p) =>
      p.entries.some((e) => e.name === "files/random.bin"),
    )!;
    expect(random.entries.find((e) => e.name === "manifest.json")!.offset).toBeGreaterThan(0xffffffff);
    expect((await checkArchive(root)).problems).toEqual([]);
  }, LONG);

  it.skipIf(python === undefined)("passes python -m zipfile -t", async () => {
    for (const name of await fs.readdir(path.join(dir, "packs", "2026"))) {
      const text = execFileSync(python!, ["-I", "-m", "zipfile", "-t", path.join(dir, "packs", "2026", name)], { encoding: "utf8" });
      expect(text).toMatch(/Done testing/);
    }
  }, LONG);

  it("reads a large file with openFileVersion, readFileVersion and the CLI cat", async () => {
    expect(await streamSha(await openFileVersion(dir, "random.bin"))).toEqual({ sha256: sha["random.bin"], size: SIZE });
    // readFileVersion holds the file in memory: only where there is room for it.
    if (os.freemem() > 3 * SIZE) {
      const data = await readFileVersion(dir, "zeros.bin");
      expect(data.length).toBe(SIZE);
      // One hash update takes less than 4 GiB.
      const hash = createHash("sha256");
      for (let at = 0; at < data.length; at += 256 * MiB) hash.update(data.subarray(at, at + 256 * MiB));
      expect(hash.digest("hex")).toBe(sha["zeros.bin"]);
    }
    const hash = createHash("sha256");
    let size = 0;
    const code = await main(["cat", "imports/2026-10-24-zip64-large", "zeros.bin", "--root", root], () => {}, async (d) => {
      hash.update(d);
      size += d.length;
    });
    expect({ code, size, sha256: hash.digest("hex") }).toEqual({ code: 0, size: SIZE, sha256: sha["zeros.bin"] });
  }, LONG);
});
