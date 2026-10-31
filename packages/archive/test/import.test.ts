import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArchiveError, checkArchive, importFolder, listPacks, openPack, readFileVersion, readIndex, readStatus, rebuildIndex } from "../src/index.js";
import { main } from "../src/cli.js";

// Lets a test make the publish step fail, as a full disk or a file in the way of packs/ would.
const publishFailure = vi.hoisted(() => ({ error: null as Error | null }));
vi.mock("../src/pack.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/pack.js")>();
  return {
    ...original,
    publishParts: (...args: Parameters<typeof original.publishParts>) =>
      publishFailure.error !== null ? Promise.reject(publishFailure.error) : original.publishParts(...args),
  };
});

let tmp: string;
let root: string;
let folder: string;
let lockDir: string;
let cacheDir: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "memex-archive-import-"));
  root = path.join(tmp, "archive");
  folder = path.join(tmp, "drop");
  lockDir = path.join(tmp, "locks");
  cacheDir = path.join(tmp, "cache");
  await fs.mkdir(path.join(folder, "a", "b"), { recursive: true });
  await fs.writeFile(path.join(folder, "top.txt"), "top\n");
  await fs.writeFile(path.join(folder, "a", "one.json"), '{"one":1}\n');
  await fs.writeFile(path.join(folder, "a", "b", "deep.bin"), Buffer.alloc(70_000, 7));
  await fs.writeFile(path.join(folder, "a", "empty"), "");
});

afterEach(async () => {
  publishFailure.error = null;
  vi.restoreAllMocks();
  await fs.rm(tmp, { recursive: true, force: true });
});

/** Makes a link to a folder: a symbolic link, or a junction where Windows refuses symbolic links. */
async function linkFolder(target: string, link: string): Promise<void> {
  try {
    await fs.symlink(target, link, "dir");
  } catch {
    await fs.symlink(target, link, "junction");
  }
}

/** Every file under a folder with its bytes, for comparing a folder before and after. */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const e of await fs.readdir(dir, { withFileTypes: true, recursive: true })) {
    const full = path.join(e.parentPath, e.name);
    const rel = path.relative(dir, full).split(path.sep).join("/");
    out[rel] = e.isFile() ? (await fs.readFile(full)).toString("base64") : e.isSymbolicLink() ? "link" : "dir";
  }
  return out;
}

const options = () => ({ root, folder, name: "old-drop", date: "2026-10-25", lockDir, cacheDir });

describe("importFolder", () => {
  it("stores every file whole with ids relative to the folder, and leaves the folder as it was", async () => {
    const before = await snapshot(folder);
    const result = await importFolder(options());
    expect(await snapshot(folder)).toEqual(before);

    expect(result.dir).toBe(path.join(root, "imports", "2026-10-25-old-drop"));
    expect(result.path).toBe("imports/2026-10-25-old-drop");
    expect(result.files).toBe(4);
    expect(result.bytes).toBe(4 + 10 + 70_000);
    expect(result.failed).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.status.lastRun.outcome).toBe("success");
    expect(result.status).toMatchObject({ domain: "imports", source: "2026-10-25-old-drop", device: "import" });
    expect(result.status.counts).toEqual({ read: 4, written: 4, unchanged: 0, filtered: 0, failed: 0 });

    const index = await readIndex(result.dir);
    expect(index!.files.map((f) => f.id)).toEqual(["a/b/deep.bin", "a/empty", "a/one.json", "top.txt"]);
    expect(index!.files.find((f) => f.id === "a/empty")!.size).toBe(0);
    expect((await readFileVersion(result.dir, "a/b/deep.bin")).equals(Buffer.alloc(70_000, 7))).toBe(true);
    expect((await readFileVersion(result.dir, "a/empty")).length).toBe(0);

    const packs = await listPacks(result.dir);
    expect(packs.map((p) => p.file)).toEqual(result.packs);
    const manifest = (await openPack(packs[0]!.path)).manifest;
    expect(manifest.entries.map((e) => (e as { entry: string }).entry)).toEqual([
      "files/a/b/deep.bin",
      "files/a/empty",
      "files/a/one.json",
      "files/top.txt",
    ]);
    expect((await checkArchive(root)).problems).toEqual([]);
  });

  it("lists a link and skips it without following it", async () => {
    const outside = path.join(tmp, "outside");
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "secret.txt"), "not part of the drop");
    await linkFolder(outside, path.join(folder, "a", "linked"));

    const result = await importFolder(options());
    expect(result.skipped).toEqual([{ id: "a/linked", reason: "link, not followed" }]);
    expect(result.status.lastRun.outcome).toBe("success");
    expect(result.status.counts).toEqual({ read: 5, written: 4, unchanged: 0, filtered: 1, failed: 0 });
    expect(result.status.filtered).toEqual([{ id: "a/linked", reason: "link, not followed" }]);
    const index = await readIndex(result.dir);
    expect(index!.files.some((f) => f.id.startsWith("a/linked"))).toBe(false);
    expect(await fs.readFile(path.join(outside, "secret.txt"), "utf8")).toBe("not part of the drop");
  });

  it("refuses a second import with the same date and name, and keeps the first", async () => {
    const first = await importFolder(options());
    const packs = await listPacks(first.dir);
    await expect(importFolder(options())).rejects.toMatchObject({ code: "import-exists" });
    expect(await listPacks(first.dir)).toEqual(packs);
    expect((await readStatus(first.dir))!.lastRun.runId).toBe(first.status.lastRun.runId);
    // Another name on the same date is a separate import.
    const second = await importFolder({ ...options(), name: "other" });
    expect(second.files).toBe(4);
  });

  it("splits a large import into parts", async () => {
    for (let i = 0; i < 5; i++) await fs.writeFile(path.join(folder, `r${i}.bin`), Buffer.from(String(i).repeat(50_000) + Math.random()));
    const result = await importFolder({ ...options(), partBytes: 1 });
    expect(result.packs.length).toBeGreaterThan(1);
    const index = await readIndex(result.dir);
    expect(index!.files).toHaveLength(9);
  });

  it("makes the same index again from the packs", async () => {
    const result = await importFolder(options());
    const written = await readIndex(result.dir);
    await fs.rm(path.join(result.dir, "index.jsonl"));
    const rebuilt = await rebuildIndex(result.dir);
    expect({ ...rebuilt.source, updatedAt: "" }).toEqual({ ...written!.source, updatedAt: "" });
    expect(rebuilt.files).toEqual(written!.files);
  });

  it("refuses a folder that is not there, a bad name, a bad date and an import inside the folder", async () => {
    await expect(importFolder({ ...options(), folder: path.join(tmp, "missing") })).rejects.toMatchObject({ code: "not-a-folder" });
    await expect(importFolder({ ...options(), name: "Bad Name" })).rejects.toBeInstanceOf(ArchiveError);
    await expect(importFolder({ ...options(), date: "25.10.2026" })).rejects.toMatchObject({ code: "invalid-date" });
    await expect(importFolder({ ...options(), root: path.join(folder, "archive") })).rejects.toMatchObject({ code: "import-inside-folder" });
    expect(await fs.readdir(folder)).toEqual(["a", "top.txt"]);
  });

  it("stores every readable file when a folder cannot be read, and records a failed run", async () => {
    await fs.writeFile(path.join(folder, "z.txt"), "after\n");
    const readdir = fs.readdir;
    vi.spyOn(fs, "readdir").mockImplementation(((dir: string, ...rest: unknown[]) => {
      if (path.resolve(String(dir)) === path.join(folder, "a", "b")) {
        return Promise.reject(Object.assign(new Error(`EPERM: operation not permitted, scandir '${dir}'`), { code: "EPERM" }));
      }
      return (readdir as (...a: unknown[]) => unknown)(dir, ...rest);
    }) as typeof fs.readdir);

    const result = await importFolder(options());
    expect(result.failed).toEqual([{ id: "a/b", error: expect.stringContaining("EPERM") }]);
    expect(result.ok).toBe(false);
    expect(result.status.lastRun.outcome).toBe("failed");
    expect(result.status.lastRun.error).toContain("a/b");
    expect(result.status.counts).toEqual({ read: 5, written: 4, unchanged: 0, filtered: 0, failed: 1 });
    expect(result.files).toBe(4);
    const index = await readIndex(result.dir);
    expect(index!.files.map((f) => f.id)).toEqual(["a/empty", "a/one.json", "top.txt", "z.txt"]);
  });

  it("counts no file as stored when the packs could not be published", async () => {
    publishFailure.error = new Error("ENOTDIR: not a directory, mkdir 'packs'");
    const result = await importFolder(options());
    expect(result.ok).toBe(false);
    expect(result.status.lastRun.outcome).toBe("failed");
    expect(result.status.lastRun.error).toContain("could not publish the run");
    expect(result.failed).toEqual([]);
    expect(result.packs).toEqual([]);
    expect(result.files).toBe(0);
    expect(result.bytes).toBe(0);
  });

  it("imports an empty folder as a successful run with no packs", async () => {
    const empty = path.join(tmp, "empty");
    await fs.mkdir(empty);
    const result = await importFolder({ ...options(), folder: empty });
    expect(result.files).toBe(0);
    expect(result.packs).toEqual([]);
    expect(result.status.lastRun.outcome).toBe("success");
    expect((await readIndex(result.dir))!.files).toEqual([]);
  });
});

describe("memex-archive import", () => {
  it("imports a folder, prints the totals, and refuses the second time", async () => {
    const lines: string[] = [];
    const env = { ...process.env };
    // Keep the staging folder and the lock out of the real cache folder (Windows and Linux).
    process.env.LOCALAPPDATA = cacheDir;
    process.env.XDG_CACHE_HOME = cacheDir;
    try {
      const code = await main(["import", folder, "--name", "old-drop", "--date", "2026-10-25", "--root", root], (l) => lines.push(l));
      expect(code).toBe(0);
      expect(lines.join("\n")).toContain("Files: 4 (68.4 KiB)  packs: 1  skipped: 0  failed: 0");
      lines.length = 0;
      expect(await main(["import", folder, "--name", "old-drop", "--date", "2026-10-25", "--root", root], (l) => lines.push(l))).toBe(1);
      expect(lines.join("\n")).toContain("exists already");
      lines.length = 0;
      expect(await main(["import", folder, "--root", root], (l) => lines.push(l))).toBe(2);
      expect(lines.join("\n")).toContain("--name");

      lines.length = 0;
      await fs.rm(path.join(root, "imports", "2026-10-25-old-drop", "index.jsonl"));
      expect(await main(["index", "imports/2026-10-25-old-drop", "--rebuild", "--root", root], (l) => lines.push(l))).toBe(0);
      expect(lines.join("\n")).toContain("1 packs, 4 files");
    } finally {
      process.env = env;
    }
  });
});
