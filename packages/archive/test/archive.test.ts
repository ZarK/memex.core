import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { memexPaths } from "@tjalve/memex-storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ArchiveError,
  ArchiveLockedError,
  STATUS_FORMAT,
  acquireRunLock,
  archiveCacheDir,
  checkArchive,
  copyFileClosed,
  importDir,
  initArchive,
  isAlreadyExists,
  isRunId,
  listPacks,
  listSources,
  lockPath,
  newRunId,
  nextStatus,
  openPack,
  readFileVersion,
  readIndex,
  readStatus,
  rebuildIndex,
  recordRun,
  resolveArchiveRoot,
  sha256Bytes,
  sourceDir,
  startRun,
  writeClosedWith,
  writeFileClosed,
  writeIndex,
  writeStatus,
  indexLines,
  README_VERSION,
  type ArchiveStatus,
  SourceChangedError,
  type ArchiveIndex,
} from "../src/index.js";
import { main } from "../src/cli.js";
import { PackBuilder } from "../src/pack.js";
import { ZipWriter } from "../src/zip.js";

let tmp: string;
let lockDir: string;
let cacheDir: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "memex-archive-test-"));
  lockDir = path.join(tmp, "locks");
  cacheDir = path.join(tmp, "cache");
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

const ref = { domain: "messages", source: "imessage", device: "mac-mini" };

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string) => {
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else out.push(path.relative(dir, full).split(path.sep).join("/"));
    }
  };
  await walk(dir);
  return out.sort();
}

describe("archive root", () => {
  const cases = [
    { platform: "win32", home: "C:\\Users\\ada", env: {} },
    { platform: "win32", home: "C:\\Users\\ada", env: { MEMEX_HOME: "F:/memex-dev" } },
    { platform: "win32", home: "C:\\Users\\ada", env: { MEMEX_HOME: "F:\\dev", MEMEX_ARCHIVE_HOME: "P:\\Proton Drive\\Memex Archive" } },
    { platform: "darwin", home: "/Users/ada", env: {} },
    { platform: "linux", home: "/home/ada", env: { MEMEX_ARCHIVE_HOME: "/mnt/archive/" } },
  ];
  it("matches memexPaths().archive from the storage contract", () => {
    for (const c of cases) {
      expect(resolveArchiveRoot(c)).toBe(memexPaths({ app: "capture", ...c }).archive);
    }
  });
  it("puts the flag first", () => {
    expect(resolveArchiveRoot({ platform: "linux", home: "/home/a", env: { MEMEX_ARCHIVE_HOME: "/x" }, flag: "/y" })).toBe("/y");
  });
  it("refuses relative values", () => {
    expect(() => resolveArchiveRoot({ platform: "linux", home: "/home/a", env: { MEMEX_ARCHIVE_HOME: "archive" } })).toThrow(/absolute/);
  });
  it("puts the lock folder in the OS cache folder of the archive app", () => {
    const envs = [
      { platform: "win32", home: "C:\\Users\\ada", env: { LOCALAPPDATA: "D:\\Local" } },
      { platform: "darwin", home: "/Users/ada", env: {} },
      { platform: "linux", home: "/home/ada", env: { XDG_CACHE_HOME: "/var/cache/ada" } },
    ];
    for (const c of envs) {
      expect(archiveCacheDir(c)).toBe(memexPaths({ app: "archive", ...c }).cache);
    }
  });
});

describe("layout", () => {
  it("builds source and import folders and refuses bad names", () => {
    expect(sourceDir("/r", ref)).toBe(path.join("/r", "messages", "imessage", "mac-mini"));
    expect(importDir("/r", { date: "2026-10-23", name: "takeout" })).toBe(path.join("/r", "imports", "2026-10-23-takeout"));
    expect(() => sourceDir("/r", { ...ref, device: "Mac Mini" })).toThrow(ArchiveError);
    expect(() => sourceDir("/r", { ...ref, source: ".." })).toThrow(ArchiveError);
    expect(() => sourceDir("/r", { ...ref, domain: "imports" })).toThrow(ArchiveError);
    expect(() => importDir("/r", { date: "23-10-2026", name: "x" })).toThrow(ArchiveError);
  });
  it("makes sortable run ids", () => {
    const id = newRunId(new Date("2026-10-23T10:15:00.123Z"));
    expect(id).toMatch(/^20261023T101500Z-[0-9a-f]{8}$/);
    expect(isRunId(id)).toBe(true);
    expect(isRunId("not-a-run")).toBe(false);
    const now = new Date("2026-10-23T10:15:00.500Z");
    for (const last of ["20261023T101500Z-00000000", "20261023T101500Z-fffe0000", "20261023T101459Z-ffffffff"]) {
      expect(newRunId(now, last) > last).toBe(true);
    }
  });
});

describe("closed writes", () => {
  it("writes through a .partial file and leaves none behind", async () => {
    const file = path.join(tmp, "a", "b", "file.txt");
    await writeFileClosed(file, "hello");
    expect(await fs.readFile(file, "utf8")).toBe("hello");
    expect(await listFiles(tmp)).toEqual(["a/b/file.txt"]);
  });
  it("leaves a .partial file from an interrupted run for check to report", async () => {
    const file = path.join(tmp, "x.json");
    await fs.writeFile(file + ".partial", "half");
    await writeFileClosed(file, "{}");
    expect(await fs.readFile(file, "utf8")).toBe("{}");
    expect(await listFiles(tmp)).toEqual(["x.json", "x.json.partial"]);
  });
  it("gives concurrent writes of one file their own .partial files", async () => {
    const file = path.join(tmp, "z.json");
    await Promise.all([writeFileClosed(file, "a".repeat(100_000)), writeFileClosed(file, "b".repeat(100_000))]);
    expect(await fs.readFile(file, "utf8")).toMatch(/^(a{100000}|b{100000})$/);
    expect(await listFiles(tmp)).toEqual(["z.json"]);
  });
  it("does not replace an existing file when replace is false", async () => {
    const file = path.join(tmp, "once.txt");
    await writeFileClosed(file, "first", { replace: false });
    const error = await writeFileClosed(file, "second", { replace: false }).catch((e: unknown) => e);
    expect(isAlreadyExists(error)).toBe(true);
    expect(await fs.readFile(file, "utf8")).toBe("first");
    expect(await listFiles(tmp)).toEqual(["once.txt"]);
  });
  it("does not rename a copy whose bytes changed into place", async () => {
    const src = path.join(tmp, "src.bin");
    await fs.writeFile(src, "new bytes");
    const dest = path.join(tmp, "out", "dest.bin");
    await expect(copyFileClosed(src, dest, sha256Bytes(Buffer.from("old bytes")))).rejects.toThrow(/changed/);
    expect(await listFiles(path.join(tmp, "out"))).toEqual([]);
  });
  it("removes the .partial file when writing fails", async () => {
    const file = path.join(tmp, "y.json");
    await expect(
      writeClosedWith(file, async (handle) => {
        await handle.writeFile("half");
        throw new Error("write failed");
      }),
    ).rejects.toThrow(/write failed/);
    expect(await listFiles(tmp)).toEqual([]);
  });
});

describe("status", () => {
  const base = { ...ref, runId: "20261023T101500Z-00000001", startedAt: "2026-10-23T10:15:00.000Z", finishedAt: "2026-10-23T10:15:04.000Z" };

  it("records a successful run", () => {
    const s = nextStatus(null, {
      ...base,
      counts: { read: 5, written: 2, unchanged: 1, filtered: 2, failed: 0 },
      filtered: [{ id: "a", reason: "empty" }, { id: "b", reason: "empty" }],
      highWater: 42,
    });
    expect(s.format).toBe(STATUS_FORMAT);
    expect(s.lastRun.outcome).toBe("success");
    expect(s.lastSuccess).toEqual({ runId: base.runId, finishedAt: base.finishedAt });
    expect(s.highWater).toBe(42);
  });

  it("fails a run whose counts do not add up and keeps lastSuccess and highWater", () => {
    const good = nextStatus(null, { ...base, counts: { read: 1, written: 1, unchanged: 0, filtered: 0, failed: 0 }, highWater: 10 });
    const bad = nextStatus(good, {
      ...base,
      runId: "20261024T101500Z-00000002",
      counts: { read: 5, written: 3, unchanged: 0, filtered: 0, failed: 0 },
      highWater: 99,
    });
    expect(bad.lastRun.outcome).toBe("failed");
    expect(bad.lastRun.error).toMatch(/do not add up/);
    expect(bad.lastSuccess).toEqual(good.lastSuccess);
    expect(bad.highWater).toBe(10);
  });

  it("fails a run when the filtered list does not match, a record failed, an error is reported, or a permission is missing", () => {
    const counts = { read: 1, written: 0, unchanged: 0, filtered: 1, failed: 0 };
    expect(nextStatus(null, { ...base, counts }).lastRun.error).toMatch(/filtered records are listed/);
    expect(nextStatus(null, { ...base, counts: { read: 1, written: 0, unchanged: 0, filtered: 0, failed: 1 } }).lastRun.outcome).toBe("failed");
    expect(nextStatus(null, { ...base, counts: { read: 0, written: 0, unchanged: 0, filtered: 0, failed: 0 }, error: "boom" }).lastRun.error).toBe("boom");
    const blocked = nextStatus(null, {
      ...base,
      counts: { read: 0, written: 0, unchanged: 0, filtered: 0, failed: 0 },
      missingPermissions: ["Full Disk Access"],
    });
    expect(blocked.lastRun.outcome).toBe("failed");
    expect(blocked.lastSuccess).toBeNull();
    expect(blocked.highWater).toBeNull();
  });

  it("writes, reads, and refuses an unknown format", async () => {
    const dir = path.join(tmp, "s");
    expect(await readStatus(dir)).toBeNull();
    const s = await recordRun(dir, { ...base, counts: { read: 0, written: 0, unchanged: 0, filtered: 0, failed: 0 }, highWater: "2026-10-23" });
    expect(await readStatus(dir)).toEqual(s);
    await fs.writeFile(path.join(dir, "status.json"), JSON.stringify({ ...s, format: "other/1" }));
    await expect(readStatus(dir)).rejects.toThrow(/format/);
    await expect(writeStatus(dir, { ...s, lastRun: { ...s.lastRun, outcome: "maybe" } } as unknown as ArchiveStatus)).rejects.toThrow();
  });
});

describe("run lock", () => {
  it("lets one run hold a source at a time and lives outside the archive", async () => {
    const dir = path.join(tmp, "archive", "s");
    const lock = await acquireRunLock(dir, { lockDir });
    expect(lock.path.startsWith(lockDir)).toBe(true);
    await expect(acquireRunLock(dir, { lockDir })).rejects.toBeInstanceOf(ArchiveLockedError);
    await lock.release();
    const again = await acquireRunLock(dir, { lockDir });
    await again.release();
  });
  it("takes over a lock whose process is gone", async () => {
    const dir = path.join(tmp, "s");
    const file = lockPath(dir, { lockDir });
    await fs.mkdir(lockDir, { recursive: true });
    await fs.writeFile(file, JSON.stringify({ pid: 999999999, hostname: os.hostname(), startedAt: "2020-01-01T00:00:00Z", dir }));
    const lock = await acquireRunLock(dir, { lockDir });
    await lock.release();
  });
  it("lets only one of two runs take over the same stale lock", async () => {
    const dir = path.join(tmp, "s");
    const file = lockPath(dir, { lockDir });
    await fs.mkdir(lockDir, { recursive: true });
    for (let i = 0; i < 20; i++) {
      await fs.writeFile(file, JSON.stringify({ pid: 999999999, hostname: os.hostname(), startedAt: "2020-01-01T00:00:00Z", dir }));
      const results = await Promise.allSettled([acquireRunLock(dir, { lockDir }), acquireRunLock(dir, { lockDir })]);
      const taken = results.filter((r) => r.status === "fulfilled");
      const refused = results.filter((r) => r.status === "rejected");
      expect(taken).toHaveLength(1);
      expect(refused).toHaveLength(1);
      expect((refused[0] as PromiseRejectedResult).reason).toBeInstanceOf(ArchiveLockedError);
      expect(await fs.readdir(lockDir)).toEqual([path.basename(file)]);
      await (taken[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof acquireRunLock>>>).value.release();
    }
  });
  it("takes over a lock from before the last boot even when its process id is in use again", async () => {
    const dir = path.join(tmp, "s");
    const file = lockPath(dir, { lockDir });
    await fs.mkdir(lockDir, { recursive: true });
    const bootTime = Date.parse("2026-10-23T08:00:00Z");
    const write = (startedAt: string, hostname = os.hostname()) =>
      fs.writeFile(file, JSON.stringify({ pid: process.pid, hostname, startedAt, dir }));

    await write("2026-10-23T07:30:00Z");
    const lock = await acquireRunLock(dir, { lockDir, bootTime });
    await lock.release();

    await write("2026-10-23T08:05:00Z");
    await expect(acquireRunLock(dir, { lockDir, bootTime })).rejects.toBeInstanceOf(ArchiveLockedError);

    await write("2026-10-23T07:30:00Z", "another-host");
    await expect(acquireRunLock(dir, { lockDir, bootTime })).rejects.toBeInstanceOf(ArchiveLockedError);
  });
  it("uses the OS cache folder by default", () => {
    const env = { LOCALAPPDATA: "D:\\Local", XDG_CACHE_HOME: "/var/cache/x" };
    const file = lockPath(path.join(tmp, "s"), { env });
    expect(file.startsWith(path.join(archiveCacheDir({ env }), "locks"))).toBe(true);
  });
});

const zero = { read: 0, written: 0, unchanged: 0, filtered: 0, failed: 0 };

function begin(root: string, extra: { partBytes?: number } = {}) {
  return startRun({ root, ...ref, lockDir, cacheDir, partBytes: extra.partBytes });
}

async function stagingLeft(): Promise<string[]> {
  try {
    return await listFiles(path.join(cacheDir, "staging"));
  } catch {
    return [];
  }
}

/** The index lines without updatedAt, for comparing a written index with a rebuilt one. */
function comparable(index: ArchiveIndex) {
  return indexLines({ ...index, source: { ...index.source, updatedAt: "" } });
}

describe("startRun", () => {
  it("packs records, attachments, files, and notes, then writes the index, status, and README", async () => {
    const root = path.join(tmp, "Archive");
    await initArchive(root);
    const run = await begin(root);
    expect(run.previous).toBeNull();
    expect(run.previousIndex).toBeNull();
    await expect(begin(root)).rejects.toBeInstanceOf(ArchiveLockedError);
    const src = path.join(tmp, "s1.jsonl");
    await fs.writeFile(src, '{"type":"user"}\n');
    const [chunk, att, file] = await Promise.all([
      run.writeChunk([{ id: "1" }, { id: "2" }]),
      run.putAttachment(Buffer.from("img"), { ext: "PNG" }),
      run.captureFile(src, "home/projects/p/s1.jsonl", { meta: { kind: "session", firstPrompt: "hi" } }),
    ]);
    run.note("chat/42", { kind: "chat", messages: 3 });
    const status = await run.finish({
      counts: { read: 3, written: 2, unchanged: 0, filtered: 1, failed: 0 },
      filtered: [{ id: "3", reason: "system message" }],
      highWater: 3,
    });
    expect(status.lastRun.outcome).toBe("success");
    const packFile = `packs/${run.runId.slice(0, 4)}/${run.runId}.zip`;
    expect(status.lastRun.packs).toEqual([packFile]);
    await expect(run.writeChunk([{ id: "4" }])).rejects.toThrow(/finished/);
    expect(chunk).toMatchObject({ entry: "records/records.jsonl", count: 2 });
    expect(att).toMatchObject({ ext: "png", stored: true, entry: `attachments/${att.sha256.slice(0, 2)}/${att.sha256}.png` });
    expect(file).toMatchObject({ id: "home/projects/p/s1.jsonl", entry: "files/home/projects/p/s1.jsonl", size: 16 });

    expect(await listFiles(root)).toEqual([
      "README.md",
      "messages/imessage/mac-mini/index.jsonl",
      `messages/imessage/mac-mini/${packFile}`,
      "messages/imessage/mac-mini/status.json",
    ]);
    expect(await stagingLeft()).toEqual([]);

    const pack = await openPack(path.join(run.dir, packFile));
    expect(pack.manifest).toMatchObject({ format: "memex.archive.pack/1", ...ref, runId: run.runId, part: 1 });
    expect(pack.entries.at(-1)?.name).toBe("manifest.json");
    expect(pack.manifest.entries.map((e) => e.kind).sort()).toEqual(["attachment", "full", "item", "records"]);
    expect((await pack.read("records/records.jsonl")).toString()).toBe('{"id":"1"}\n{"id":"2"}\n');

    const index = (await readIndex(run.dir))!;
    expect(index.source).toMatchObject({ format: "memex.archive.index/1", runs: 1, packs: [{ file: packFile, runId: run.runId, part: 1 }] });
    expect(index.files[0]).toMatchObject({ id: file.id, path: file.entry, size: 16, meta: { kind: "session", firstPrompt: "hi" } });
    expect(index.items).toEqual([{ type: "item", id: "chat/42", meta: { kind: "chat", messages: 3 }, firstRun: run.runId, lastRun: run.runId }]);
    expect(index.records).toEqual([{ type: "records", run: run.runId, file: packFile, entry: "records/records.jsonl", stream: "records", count: 2 }]);
    const text = await fs.readFile(path.join(run.dir, "index.jsonl"), "utf8");
    expect(text.split("\n").filter(Boolean).map((l) => JSON.parse(l).type)).toEqual(["source", "attachment", "file", "item", "records"]);

    const next = await begin(root);
    expect(next.previous?.highWater).toBe(3);
    expect(next.previousIndex?.files).toHaveLength(1);
    const failed = await next.fail(new Error("Messages database is locked"));
    expect(failed.lastRun.outcome).toBe("failed");
    expect(failed.lastRun.packs).toEqual([]);
    expect(failed.highWater).toBe(3);
    expect(failed.lastSuccess?.runId).toBe(run.runId);
  });

  it("writes no pack for a run that found nothing", async () => {
    const root = path.join(tmp, "Archive");
    const run = await begin(root);
    expect(await run.writeChunk([])).toEqual({ entry: null, count: 0, size: 0, sha256: null });
    const status = await run.finish({ counts: zero });
    expect(status.lastRun.packs).toEqual([]);
    expect(await listPacks(run.dir)).toEqual([]);
    expect((await readIndex(run.dir))?.source.packs).toEqual([]);
    expect(await stagingLeft()).toEqual([]);
  });

  it("publishes the staged pack of a failed run", async () => {
    const root = path.join(tmp, "Archive");
    const run = await begin(root);
    await run.writeChunk([{ id: "1" }]);
    const att = await run.putAttachment(Buffer.from("photo"), { ext: "jpg" });
    const status = await run.fail(new Error("the source went away"), { read: 2, written: 1, failed: 1 });
    expect(status.lastRun.outcome).toBe("failed");
    expect(status.lastRun.packs).toHaveLength(1);
    const pack = await openPack(path.join(run.dir, status.lastRun.packs[0]!));
    expect(pack.manifest.entries.map((e) => ("entry" in e ? e.entry : ""))).toEqual(["records/records.jsonl", att.entry]);
    expect((await readIndex(run.dir))?.attachments.map((a) => a.sha256)).toEqual([att.sha256]);
    expect(await stagingLeft()).toEqual([]);
  });

  it("stores an attachment once across runs", async () => {
    const root = path.join(tmp, "Archive");
    const bytes = Buffer.from("same picture");
    const first = await begin(root);
    const a = await first.putAttachment(bytes, { ext: "jpg" });
    const again = await first.putAttachment(bytes, { ext: "jpg" });
    expect([a.stored, again.stored]).toEqual([true, false]);
    await first.finish({ counts: zero });

    const second = await begin(root);
    const src = path.join(tmp, "copy.jpg");
    await fs.writeFile(src, bytes);
    const b = await second.putAttachment({ path: src });
    expect(b).toMatchObject({ sha256: a.sha256, stored: false, entry: a.entry });
    const c = await second.putAttachment(Buffer.from("new picture"), { ext: "jpg" });
    expect(c.stored).toBe(true);
    await second.finish({ counts: zero });
    const index = (await readIndex(second.dir))!;
    expect(index.attachments).toHaveLength(2);
    const packs = await listPacks(second.dir);
    expect(packs).toHaveLength(2);
    expect((await openPack(packs[1]!.path)).manifest.entries.map((e) => e.kind)).toEqual(["attachment"]);
  });

  it("joins appends back to the exact bytes, also at an earlier run", async () => {
    const root = path.join(tmp, "Archive");
    const src = path.join(tmp, "session.jsonl");
    const id = "home/projects/p/s0.jsonl";
    const v1 = Buffer.from('{"n":1}\n'.repeat(1000));
    await fs.writeFile(src, v1);
    const r1 = await begin(root);
    const full = await r1.captureFile(src, id);
    await r1.finish({ counts: zero });

    const v2 = Buffer.concat([v1, randomBytes(70_000)]);
    await fs.writeFile(src, v2);
    const r2 = await begin(root);
    const prev = r2.previousIndex!.files.find((f) => f.id === id)!;
    expect(prev).toMatchObject({ size: v1.length, sha256: full.sha256 });
    const a2 = await r2.appendFile(src, id, { offset: prev.size, base: prev.sha256, meta: { kind: "session", messages: 2 } });
    expect(a2).toMatchObject({ offset: v1.length, size: 70_000, fileSize: v2.length, sha256: sha256Bytes(v2) });
    await r2.finish({ counts: zero });

    const v3 = Buffer.concat([v2, Buffer.from("tail\n")]);
    await fs.writeFile(src, v3);
    const r3 = await begin(root);
    const p3 = r3.previousIndex!.files[0]!;
    await r3.appendFile(src, id, { offset: p3.size, base: p3.sha256 });
    await r3.finish({ counts: zero });

    const dir = r3.dir;
    expect((await readFileVersion(dir, id)).equals(v3)).toBe(true);
    expect((await readFileVersion(dir, id, { run: r2.runId })).equals(v2)).toBe(true);
    expect((await readFileVersion(dir, id, { run: r1.runId })).equals(v1)).toBe(true);
    const file = (await readIndex(dir))!.files[0]!;
    expect(file.revisions.map((r) => r.kind)).toEqual(["full", "append", "append"]);
    expect(file).toMatchObject({ path: `appends/${id}`, size: v3.length, meta: { kind: "session", messages: 2 }, firstRun: r1.runId, lastRun: r3.runId });
  });

  it("refuses an append to a file that did not only grow, and keeps no entry for it", async () => {
    const root = path.join(tmp, "Archive");
    const src = path.join(tmp, "f.txt");
    await fs.writeFile(src, "hello\n");
    const r1 = await begin(root);
    const full = await r1.captureFile(src, "f.txt");
    await r1.finish({ counts: zero });
    await fs.writeFile(src, "HELLO\nworld\n");
    const r2 = await begin(root);
    await expect(r2.appendFile(src, "f.txt", { offset: full.size, base: full.sha256 })).rejects.toMatchObject({ code: "append-base-mismatch" });
    await expect(r2.appendFile(src, "f.txt", { offset: 3, base: full.sha256 })).rejects.toMatchObject({ code: "append-mismatch" });
    await expect(r2.appendFile(src, "other.txt", { offset: 0, base: full.sha256 })).rejects.toMatchObject({ code: "append-unknown" });
    // The collector stores it whole instead.
    await r2.captureFile(src, "f.txt");
    await r2.finish({ counts: zero });
    expect((await readFileVersion(r2.dir, "f.txt")).toString()).toBe("HELLO\nworld\n");
    const manifest = (await openPack((await listPacks(r2.dir))[1]!.path)).manifest;
    expect(manifest.entries.map((e) => e.kind)).toEqual(["full"]);
  });

  it("keeps a captured file out of the pack when it differs from the expected hash", async () => {
    const root = path.join(tmp, "Archive");
    const src = path.join(tmp, "contacts.vcf");
    await fs.writeFile(src, "BEGIN:VCARD\nEND:VCARD\n");
    const run = await begin(root);
    const error = await run.captureFile(src, "contacts.vcf", { expectedSha256: sha256Bytes(Buffer.from("other")) }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SourceChangedError);
    const ok = await run.captureFile(src, "contacts.vcf", { expectedSha256: sha256Bytes(Buffer.from("BEGIN:VCARD\nEND:VCARD\n")) });
    await run.finish({ counts: zero });
    const index = (await readIndex(run.dir))!;
    expect(index.files.map((f) => [f.id, f.sha256])).toEqual([["contacts.vcf", ok.sha256]]);
  });

  it("checks paths, streams, and meta", async () => {
    const root = path.join(tmp, "Archive");
    const src = path.join(tmp, "f");
    await fs.writeFile(src, "x");
    const run = await begin(root);
    for (const p of ["../x", "a/../../x", "/abs", "a\\b", "a//b", "", "a/./b"]) {
      await expect(run.captureFile(src, p)).rejects.toMatchObject({ code: "invalid-path" });
    }
    await expect(run.writeChunk([{ id: "1" }], { stream: "Chats" })).rejects.toThrow(ArchiveError);
    await expect(run.writeChunk([{ id: "1" }, [1, 2]])).rejects.toThrow(/not a JSON object/);
    await run.writeChunk([{ id: "1" }]);
    await expect(run.writeChunk([{ id: "2" }])).rejects.toMatchObject({ code: "chunk-exists" });
    await expect(run.captureFile(src, "a.txt", { meta: { text: "x".repeat(5000) } })).rejects.toMatchObject({ code: "meta-too-large" });
    expect(() => run.note("x", { text: "y".repeat(5000) })).toThrow(/limit is 4096/);
    await run.captureFile(src, "a.txt");
    await expect(run.captureFile(src, "a.txt")).rejects.toMatchObject({ code: "entry-exists" });
    await run.finish({ counts: zero });
  });

  it("splits a pack into parts at the size limit, each with its own manifest", async () => {
    const root = path.join(tmp, "Archive");
    const run = await begin(root, { partBytes: 4096 });
    for (let i = 0; i < 5; i++) await run.putAttachment(randomBytes(3000), { ext: "bin" });
    run.note("album", { kind: "album" });
    const status = await run.finish({ counts: zero });
    const year = run.runId.slice(0, 4);
    expect(status.lastRun.packs).toEqual([
      `packs/${year}/${run.runId}.zip`,
      `packs/${year}/${run.runId}.2.zip`,
      `packs/${year}/${run.runId}.3.zip`,
    ]);
    const packs = await listPacks(run.dir);
    const manifests = await Promise.all(packs.map(async (p) => (await openPack(p.path)).manifest));
    expect(manifests.map((m) => m.part)).toEqual([1, 2, 3]);
    expect(manifests.map((m) => m.entries.length)).toEqual([2, 2, 2]);
    expect(manifests[2]!.entries.map((e) => e.kind)).toEqual(["attachment", "item"]);
    const index = (await readIndex(run.dir))!;
    expect(index.attachments).toHaveLength(5);
    expect(new Set(index.attachments.map((a) => a.file)).size).toBe(3);
  });

  it("fails the run when a part cannot be finished, refuses later entries, and never reuses the part", async () => {
    const root = path.join(tmp, "Archive");
    const src = path.join(tmp, "x.txt");
    // As large as a part, not larger: it joins the records in part 1 and fills it.
    await fs.writeFile(src, randomBytes(1000));
    const run = await begin(root, { partBytes: 1000 });
    await run.writeChunk([{ id: "1" }, { id: "2" }]);
    const full = await run.captureFile(src, "x.txt");
    // The disk fills up while part 1 writes its manifest.json.
    const add = ZipWriter.prototype.add;
    const spy = vi.spyOn(ZipWriter.prototype, "add").mockImplementation(function (this: ZipWriter, name, data, options) {
      if (name === "manifest.json") {
        spy.mockRestore();
        return Promise.reject(Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" }));
      }
      return add.call(this, name, data, options);
    });
    await expect(run.putAttachment(randomBytes(100), { ext: "bin" })).rejects.toThrow(/ENOSPC/);
    await fs.appendFile(src, "more");
    await expect(run.appendFile(src, "x.txt", { offset: full.size, base: full.sha256 })).rejects.toMatchObject({ code: "pack-broken" });
    await expect(run.writeChunk([{ id: "3" }], { stream: "late" })).rejects.toMatchObject({ code: "pack-broken" });
    const status = await run.finish({ counts: { read: 2, written: 2, unchanged: 0, filtered: 0, failed: 0 } });
    expect(status.lastRun.outcome).toBe("failed");
    expect(status.lastRun.error).toMatch(/could not be finished: ENOSPC/);
    expect(status.lastRun.packs).toEqual([]);
    expect(await listPacks(run.dir)).toEqual([]);
    // The next run does not know x.txt, so it stores it whole again.
    const next = await begin(root);
    expect(next.previousIndex?.files ?? []).toEqual([]);
    await next.finish({ counts: zero });
  });

  it("still publishes the parts that closed when the last part cannot be finished", async () => {
    const root = path.join(tmp, "Archive");
    const run = await begin(root, { partBytes: 1000 });
    const first = await run.putAttachment(randomBytes(2000), { ext: "bin" });
    await run.putAttachment(randomBytes(2000), { ext: "bin" });
    const add = ZipWriter.prototype.add;
    const spy = vi.spyOn(ZipWriter.prototype, "add").mockImplementation(function (this: ZipWriter, name, data, options) {
      if (name === "manifest.json") {
        spy.mockRestore();
        return Promise.reject(new Error("ENOSPC: no space left on device"));
      }
      return add.call(this, name, data, options);
    });
    const status = await run.finish({ counts: zero });
    expect(status.lastRun.outcome).toBe("failed");
    expect(status.lastRun.packs).toEqual([`packs/${run.runId.slice(0, 4)}/${run.runId}.zip`]);
    expect((await readIndex(run.dir))!.attachments.map((a) => a.sha256)).toEqual([first.sha256]);
  });

  it("starts a new part before the manifest and central directory would pass the zip limit", async () => {
    const dir = path.join(tmp, "staging");
    const pack = new PackBuilder(dir, { ...ref, runId: "20261024T031500Z-3f9a0c1e" }, { limit: 170_000 });
    for (let i = 0; i < 4; i++) {
      pack.reserve(`a/${i}`);
      await pack.add(`a/${i}`, randomBytes(20_000), { size: 20_000, describe: (info) => ({ entry: `a/${i}`, kind: "attachment", size: info.size, sha256: "" }) });
    }
    const meta = { text: "m".repeat(3000) };
    for (let i = 0; i < 20; i++) pack.note({ kind: "item", id: `chat/${i}`, meta });
    // 80 KB of entries fit, but not with 60 KB of items in the manifest: they go into a part of their own.
    const parts = await pack.close();
    expect(parts.map((p) => p.manifest.entries.length)).toEqual([4, 20]);
    for (const p of parts) expect((await fs.stat(p.file)).size).toBeLessThan(170_000);
    expect(pack.parts).toEqual(parts);
  });

  it("stores an attachment that a concurrent call for the same bytes failed to store", async () => {
    const root = path.join(tmp, "Archive");
    const run = await begin(root);
    const bytes = Buffer.from("a picture that is still being written");
    const same = Buffer.from(bytes);
    const first = run.putAttachment(bytes, { ext: "jpg" });
    const second = run.putAttachment(same, { ext: "jpg" });
    // The first input changes after it was hashed and before it was copied.
    bytes[0] = bytes[0]! ^ 1;
    const [a, b] = await Promise.allSettled([first, second]);
    expect(a.status === "rejected" && a.reason).toBeInstanceOf(SourceChangedError);
    expect(b).toMatchObject({ status: "fulfilled", value: { sha256: sha256Bytes(same), stored: true } });
    await run.finish({ counts: zero });
    expect((await readIndex(run.dir))!.attachments.map((x) => x.sha256)).toEqual([sha256Bytes(same)]);
  });

  it("keeps the latest three database snapshots and skips an unchanged one", async () => {
    const root = path.join(tmp, "Archive");
    const db = path.join(tmp, "chat.db");
    const runs: string[] = [];
    for (let i = 0; i < 5; i++) {
      await fs.writeFile(db, `database version ${i}`.repeat(100));
      const run = await startRun({ root, ...ref, lockDir, cacheDir, now: new Date(Date.UTC(2026, 8, 20 + i)) });
      const r = await run.putDatabase(db, "chat");
      expect(r).toMatchObject({ stored: true, file: `databases/chat/${run.runId}.db.gz`, sourceSize: 1800 });
      runs.push(run.runId);
      await run.finish({ counts: zero });
    }
    const dir = sourceDir(root, ref);
    expect(await fs.readdir(path.join(dir, "databases", "chat"))).toEqual(runs.slice(2).map((r) => `${r}.db.gz`));
    const index = (await readIndex(dir))!;
    expect(index.databases).toHaveLength(1);
    expect(index.databases[0]!.snapshots.map((s) => s.run)).toEqual(runs.slice(2).reverse());
    expect(index.databases[0]!.snapshots[0]!.sha256).toBe(sha256Bytes(Buffer.from("database version 4".repeat(100))));
    expect(await listPacks(dir)).toEqual([]);

    const same = await begin(root);
    const r = await same.putDatabase(db, "chat");
    expect(r).toMatchObject({ stored: false, file: `databases/chat/${runs[4]}.db.gz` });
    await same.finish({ counts: zero });
    // At most one snapshot a UTC day, unless oncePerDay is false.
    await fs.writeFile(db, "changed later the same day");
    const sameDay = await startRun({ root, ...ref, lockDir, cacheDir, now: new Date(Date.UTC(2026, 8, 24, 18)) });
    expect(await sameDay.putDatabase(db, "chat")).toMatchObject({ stored: false, file: `databases/chat/${runs[4]}.db.gz` });
    await sameDay.finish({ counts: zero });
    const gz = await fs.readFile(path.join(dir, "databases", "chat", `${runs[4]}.db.gz`));
    expect(zlib.gunzipSync(gz).toString()).toBe("database version 4".repeat(100));

    const two = await begin(root);
    await fs.writeFile(db, "changed");
    expect((await two.putDatabase(db, "chat", { keep: 1, oncePerDay: false })).stored).toBe(true);
    await two.finish({ counts: zero });
    expect(await fs.readdir(path.join(dir, "databases", "chat"))).toEqual([`${two.runId}.db.gz`]);
  });

  it("rebuilds an index equal to the written one", async () => {
    const root = path.join(tmp, "Archive");
    const src = path.join(tmp, "s.jsonl");
    const db = path.join(tmp, "store.sqlite");
    await fs.writeFile(db, "sqlite bytes");
    await fs.writeFile(src, "a\n");
    const r1 = await begin(root, { partBytes: 2048 });
    await r1.writeChunk([{ id: "1" }], { stream: "chats" });
    await r1.captureFile(src, "p/s.jsonl", { meta: { kind: "session" } });
    await r1.putAttachment(randomBytes(3000), { ext: "jpg" });
    await r1.putAttachment(randomBytes(3000));
    await r1.putDatabase(db, "store");
    r1.note("chat/1", { kind: "chat" });
    await r1.finish({ counts: zero });
    await fs.appendFile(src, "b\n");
    const r2 = await begin(root);
    const prev = r2.previousIndex!.files[0]!;
    await r2.appendFile(src, "p/s.jsonl", { offset: prev.size, base: prev.sha256 });
    r2.note("chat/1", { kind: "chat", messages: 2 });
    await r2.writeChunk([{ id: "2" }], { stream: "chats" });
    await r2.finish({ counts: zero });

    const written = (await readIndex(r2.dir))!;
    expect(written.source.packs.length).toBeGreaterThan(2);
    const rebuilt = await rebuildIndex(r2.dir);
    expect(comparable(rebuilt)).toEqual(comparable(written));
    expect(written.items[0]).toMatchObject({ meta: { kind: "chat", messages: 2 }, firstRun: r1.runId, lastRun: r2.runId });

    // A run that finds the index missing makes it again from the packs.
    await fs.rm(path.join(r2.dir, "index.jsonl"));
    const r3 = await begin(root);
    expect(comparable(r3.previousIndex!)).toEqual(comparable(written));
    await r3.finish({ counts: zero });
  });

  it("writes README.md when it is missing or older, and leaves a current one alone", async () => {
    const root = path.join(tmp, "Archive");
    await initArchive(root);
    const file = path.join(root, "README.md");
    const text = await fs.readFile(file, "utf8");
    expect(text).toContain(`<!-- memex-archive readme ${README_VERSION} -->`);
    expect(text).toContain("zipfile.ZipFile");
    expect(text).toContain("memex-archive cat");
    await fs.writeFile(file, "<!-- memex-archive readme 0 -->\nold");
    await (await begin(root)).finish({ counts: zero });
    expect(await fs.readFile(file, "utf8")).toBe(text);
    await fs.writeFile(file, `<!-- memex-archive readme ${README_VERSION} -->\nedited`);
    await (await begin(root)).finish({ counts: zero });
    expect(await fs.readFile(file, "utf8")).toContain("edited");
  });
});

describe("a failed finish", () => {
  const counts = { read: 1, written: 1, unchanged: 0, filtered: 0, failed: 0 };
  it("releases the lock, rethrows the write error, and lets fail() record the failure", async () => {
    const root = path.join(tmp, "Archive");
    const run = await begin(root);
    // A folder where status.json goes makes the status write fail.
    const blocker = path.join(run.dir, "status.json");
    await fs.mkdir(blocker);
    const error = await run.finish({ counts }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toMatch(/finished/);
    expect((await fs.readdir(run.dir)).filter((f) => f.endsWith(".partial"))).toEqual([]);
    const lock = await acquireRunLock(run.dir, { lockDir });
    await lock.release();

    await expect(run.fail(new Error("again"))).rejects.toBe(error);
    await fs.rm(blocker, { recursive: true });
    const failed = await run.fail(new Error("status write failed"));
    expect(failed.lastRun.outcome).toBe("failed");
    expect((await readStatus(run.dir))?.lastRun.error).toBe("status write failed");
    await expect(run.fail(new Error("third"))).rejects.toThrow(/finished/);
    const next = await begin(root);
    await next.fail("done");
  });
});

describe("startRun status identity", () => {
  it("refuses a status.json that belongs to another source and releases the lock", async () => {
    const root = path.join(tmp, "Archive");
    const dir = sourceDir(root, ref);
    const other = nextStatus(null, {
      domain: "messages",
      source: "whatsapp",
      device: "mac-mini",
      runId: newRunId(),
      startedAt: "2026-10-23T10:00:00.000Z",
      counts: zero,
      error: null,
    });
    await writeStatus(dir, other);
    const error = await begin(root).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ArchiveError);
    expect((error as ArchiveError).code).toBe("status-mismatch");
    const lock = await acquireRunLock(dir, { lockDir });
    await lock.release();
  });
});

describe("listSources and checkArchive", () => {
  async function seed(root: string) {
    await initArchive(root);
    const ok = await begin(root);
    await ok.writeChunk([{ id: "1" }]);
    await ok.finish({ counts: { read: 1, written: 1, unchanged: 0, filtered: 0, failed: 0 } });
    const bad = await startRun({ root, domain: "calls", source: "apple", device: "mac-mini", lockDir, cacheDir });
    await bad.fail("no Full Disk Access");
    await fs.mkdir(path.join(root, "contacts", "apple", "mac-mini"), { recursive: true });
    await fs.mkdir(path.join(root, "imports", "2026-10-23-takeout"), { recursive: true });
    await writeStatus(
      path.join(root, "imports", "2026-10-23-takeout"),
      nextStatus(null, {
        domain: "imports",
        source: "takeout",
        device: "once",
        runId: newRunId(),
        startedAt: new Date().toISOString(),
        counts: zero,
      }),
    );
    return ok;
  }

  it("lists sources and imports with their packs and size", async () => {
    const root = path.join(tmp, "Archive");
    await seed(root);
    const sources = await listSources(root);
    expect(sources.map((s) => [s.kind, s.path, s.failing, s.packs])).toEqual([
      ["source", "calls/apple/mac-mini", true, 0],
      ["source", "contacts/apple/mac-mini", false, 0],
      ["import", "imports/2026-10-23-takeout", false, 0],
      ["source", "messages/imessage/mac-mini", false, 1],
    ]);
    expect(sources[3]!.bytes).toBeGreaterThan(100);
  });

  it("reports failing, missing status, stale, partial files, and packs that do not match the index", async () => {
    const root = path.join(tmp, "Archive");
    const ok = await seed(root);
    const dir = sourceDir(root, ref);
    const year = ok.runId.slice(0, 4);
    const packs = path.join(dir, "packs", year);
    await fs.writeFile(path.join(packs, `${ok.runId}.2.zip.1234-abcd.partial`), "half");
    // A copy under another run id (the manifest names the wrong run, the index does not list it), and a file that is not a zip.
    const copy = "20261001T000000Z-00000000";
    await fs.copyFile(path.join(packs, `${ok.runId}.zip`), path.join(packs, `${copy}.zip`));
    const junk = "20261002T000000Z-00000000";
    await fs.writeFile(path.join(packs, `${junk}.zip`), "not a zip");

    const result = await checkArchive(root);
    expect(result.ok).toBe(false);
    const kinds = result.problems.map((p) => `${p.kind} ${p.path}`).sort();
    const at = `messages/imessage/mac-mini/packs/${year}`;
    expect(kinds).toEqual(
      [
        "failing calls/apple/mac-mini",
        "stale calls/apple/mac-mini",
        "missing-status contacts/apple/mac-mini",
        "stale contacts/apple/mac-mini",
        `partial-file ${at}/${ok.runId}.2.zip.1234-abcd.partial`,
        `invalid-pack ${at}/${copy}.zip`,
        `index-mismatch ${at}/${copy}.zip`,
        `invalid-pack ${at}/${junk}.zip`,
      ].sort(),
    );

    const later = await checkArchive(root, { now: new Date(Date.now() + 10 * 86400000), staleDays: 3 });
    expect(later.problems.some((p) => p.kind === "stale" && p.path === "messages/imessage/mac-mini")).toBe(true);
  });

  it("reports an index that does not describe a pack's entries, and a missing index", async () => {
    const root = path.join(tmp, "Archive");
    const run = await begin(root);
    await run.putAttachment(Buffer.from("a"), { ext: "txt" });
    await run.finish({ counts: zero });
    const index = (await readIndex(run.dir))!;
    await writeIndex(run.dir, { ...index, attachments: [] });
    expect((await checkArchive(root)).problems.map((p) => p.kind)).toEqual(["index-mismatch"]);
    await fs.rm(path.join(run.dir, "index.jsonl"));
    expect((await checkArchive(root)).problems.map((p) => p.kind)).toEqual(["missing-index"]);
  });

  it("reports a missing root", async () => {
    const result = await checkArchive(path.join(tmp, "nope"));
    expect(result.problems[0]?.kind).toBe("missing-root");
  });

  it("passes a clean archive", async () => {
    const root = path.join(tmp, "Archive");
    await initArchive(root);
    const run = await begin(root);
    await run.writeChunk([{ id: "1" }]);
    await run.putAttachment(Buffer.from("a"), { ext: "txt" });
    run.note("x", { kind: "chat" });
    await run.finish({ counts: { read: 1, written: 1, unchanged: 0, filtered: 0, failed: 0 } });
    expect((await checkArchive(root)).problems).toEqual([]);
  });
});

describe("memex-archive CLI", () => {
  async function cli(args: string[]): Promise<{ code: number; text: string }> {
    const lines: string[] = [];
    const code = await main(args, (l) => lines.push(l));
    return { code, text: lines.join("\n") };
  }

  it("init, status, status --json, and check", async () => {
    const root = path.join(tmp, "Archive");
    expect((await cli(["status", "--root", root])).code).toBe(1);
    expect((await cli(["init", "--root", root])).text).toContain("Created");
    expect(await fs.readFile(path.join(root, "README.md"), "utf8")).toContain("# Memex archive");
    expect((await cli(["init", "--root", root])).text).toContain("Exists");
    expect((await cli(["status", "--root", root])).text).toContain("No sources yet.");
    expect((await cli(["check", "--root", root])).code).toBe(0);

    const run = await begin(root);
    await run.writeChunk([{ id: "1" }]);
    await run.finish({ counts: { read: 1, written: 0, unchanged: 0, filtered: 0, failed: 0 } });

    expect((await cli(["status", "--root", root])).text).toMatch(/packs: 1 {2}size: \d/);
    const status = await cli(["status", "--root", root, "--json", "--stale-days", "7"]);
    expect(status.code).toBe(0);
    const json = JSON.parse(status.text) as { staleDays: number; sources: Array<{ path: string; failing: boolean; packs: number }> };
    expect(json.staleDays).toBe(7);
    expect(json.sources).toMatchObject([{ path: "messages/imessage/mac-mini", failing: true, packs: 1 }]);

    const check = await cli(["check", "--root", root, "--json"]);
    expect(check.code).toBe(1);
    expect(JSON.parse(check.text).problems[0].kind).toBe("failing");
  });

  it("ls, cat, and index", async () => {
    const root = path.join(tmp, "Archive");
    const src = path.join(tmp, "s1.jsonl");
    await fs.writeFile(src, "line 1\n");
    const r1 = await begin(root);
    await r1.captureFile(src, "home/p/s1.jsonl", { meta: { kind: "session", project: "demo" } });
    r1.note("chat/9", { kind: "chat" });
    await r1.finish({ counts: zero });
    await fs.appendFile(src, "line 2\n");
    const r2 = await begin(root);
    const prev = r2.previousIndex!.files[0]!;
    await r2.appendFile(src, "home/p/s1.jsonl", { offset: prev.size, base: prev.sha256 });
    await r2.finish({ counts: zero });
    const folder = "messages/imessage/mac-mini";
    const dir = sourceDir(root, ref);

    const ls = await cli(["ls", folder, "--root", root]);
    expect(ls.code).toBe(0);
    expect(ls.text).toContain("home/p/s1.jsonl");
    expect(ls.text).toContain("chat/9");
    const files = await cli(["ls", dir, "--type", "file", "--grep", "DEMO", "--json"]);
    expect((JSON.parse(files.text) as Array<{ id: string }>).map((l) => l.id)).toEqual(["home/p/s1.jsonl"]);
    expect(JSON.parse((await cli(["ls", folder, "--root", root, "--grep", "nothing", "--json"])).text)).toEqual([]);

    const out = path.join(tmp, "out.jsonl");
    expect((await cli(["cat", folder, "home/p/s1.jsonl", "--root", root, "--out", out])).code).toBe(0);
    expect(await fs.readFile(out, "utf8")).toBe("line 1\nline 2\n");
    await cli(["cat", folder, "home/p/s1.jsonl", "--root", root, "--run", r1.runId, "--out", out]);
    expect(await fs.readFile(out, "utf8")).toBe("line 1\n");
    const written: Uint8Array[] = [];
    await main(["cat", folder, "home/p/s1.jsonl", "--root", root], () => {}, async (d) => {
      written.push(d);
    });
    expect(Buffer.concat(written).toString()).toBe("line 1\nline 2\n");
    expect((await cli(["cat", folder, "nope", "--root", root])).code).toBe(1);

    const index = await cli(["index", folder, "--root", root]);
    expect(JSON.parse(index.text.split("\n")[0]!).type).toBe("source");
    const before = (await readIndex(dir))!;
    await fs.rm(path.join(dir, "index.jsonl"));
    expect((await cli(["ls", folder, "--root", root])).code).toBe(1);
    const rebuilt = await cli(["index", folder, "--root", root, "--rebuild"]);
    expect(rebuilt.text).toContain("Rebuilt");
    expect(comparable((await readIndex(dir))!)).toEqual(comparable(before));
  });

  it("rejects bad usage", async () => {
    expect((await cli([])).code).toBe(2);
    expect((await cli(["frobnicate"])).code).toBe(2);
    expect((await cli(["status", "--stale-days", "soon", "--root", tmp])).code).toBe(2);
    expect((await cli(["status", "--bogus"])).code).toBe(2);
    expect((await cli(["ls"])).code).toBe(2);
    expect((await cli(["ls", "no/such/folder", "--root", tmp])).code).toBe(2);
    expect((await cli(["status", "extra", "--root", tmp])).code).toBe(2);
  });
});
