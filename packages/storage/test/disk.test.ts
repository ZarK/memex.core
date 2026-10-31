import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AppLockedError,
  CACHEDIR_SIGNATURE,
  DataFolderError,
  MEMEX_README_VERSION,
  MemexPathsError,
  acquireAppLock,
  describeLocation,
  folderSize,
  formatBytes,
  locationWarnings,
  markCacheFolder,
  openDataFolder,
  readLocations,
  setAppLocations,
  writeMemexReadme,
} from "../src/index.js";

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "memex-storage-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function file(rel: string, bytes: number): Promise<void> {
  const full = path.join(dir, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, Buffer.alloc(bytes));
}

const here = { platform: process.platform, env: {}, home: os.homedir() };

describe("folderSize", () => {
  it("counts every file in nested folders", async () => {
    await file("a.bin", 100);
    await file("sub/b.bin", 250);
    await file("sub/deeper/c.bin", 650);
    expect(await folderSize(dir)).toEqual({ bytes: 1000, files: 3, complete: true, stoppedBy: null, skipped: 0 });
  });
  it("stops at the byte limit", async () => {
    for (let i = 0; i < 10; i++) await file(`f${i}.bin`, 100);
    const size = await folderSize(dir, { limitBytes: 300 });
    expect(size.complete).toBe(false);
    expect(size.stoppedBy).toBe("limit");
    expect(size.bytes).toBeGreaterThanOrEqual(300);
    expect(size.bytes).toBeLessThan(1000);
  });
  it("stops when the time budget runs out", async () => {
    for (let i = 0; i < 5; i++) await file(`f${i}.bin`, 10);
    let t = 0;
    const size = await folderSize(dir, { timeBudgetMs: 2, now: () => t++ });
    expect(size).toMatchObject({ complete: false, stoppedBy: "time" });
    expect(size.files).toBeLessThan(5);
  });
  it("counts the folder that a linked data folder points to", async () => {
    await file("Dropbox/Memex/Photos/big.bin", 2500);
    const link = path.join(dir, "Photos");
    await fs.symlink(path.join(dir, "Dropbox", "Memex", "Photos"), link, "junction");
    expect(await folderSize(link)).toEqual({ bytes: 2500, files: 1, complete: true, stoppedBy: null, skipped: 0 });
  });
  it("does not follow links inside the folder", async () => {
    await file("data/a.bin", 100);
    await file("elsewhere/b.bin", 900);
    await fs.symlink(path.join(dir, "elsewhere"), path.join(dir, "data", "link"), "junction");
    expect(await folderSize(path.join(dir, "data"))).toMatchObject({ bytes: 100, files: 1, complete: true });
  });
  it("gives 0 for a missing folder", async () => {
    expect(await folderSize(path.join(dir, "missing"))).toMatchObject({ bytes: 0, files: 0, complete: true });
  });
  it("formats sizes in units of 1000", () => {
    expect(formatBytes(0)).toBe("0 bytes");
    expect(formatBytes(1)).toBe("1 byte");
    expect(formatBytes(999)).toBe("999 bytes");
    expect(formatBytes(1000)).toBe("1 KB");
    expect(formatBytes(3_240_000_000)).toBe("3.2 GB");
    expect(formatBytes(38_000_000_000)).toBe("38 GB");
    expect(formatBytes(999_600)).toBe("1 MB");
  });
});

describe("describeLocation on this computer", () => {
  it("finds a Syncthing marker on disk", async () => {
    await fs.writeFile(path.join(dir, ".stfolder"), "");
    await fs.mkdir(path.join(dir, "Memex", "Photos"), { recursive: true });
    const d = describeLocation(path.join(dir, "Memex", "Photos"), here);
    expect(d.kind).toBe("sync");
    expect(d.provider).toBe("Syncthing");
    expect(d.evidence).toBe("marker");
  });
  it("counts a .dropbox file as a marker, and not a .dropbox folder", async () => {
    await fs.mkdir(path.join(dir, ".dropbox"));
    await fs.mkdir(path.join(dir, "Memex", "Photos"), { recursive: true });
    expect(describeLocation(path.join(dir, "Memex", "Photos"), here).kind).toBe("local");
    await fs.mkdir(path.join(dir, "Shared", "Memex"), { recursive: true });
    await fs.writeFile(path.join(dir, "Shared", ".dropbox"), "");
    expect(describeLocation(path.join(dir, "Shared", "Memex"), here)).toMatchObject({
      kind: "sync",
      provider: "Dropbox",
      root: path.join(dir, "Shared"),
      evidence: "marker",
    });
  });
  it("describes a folder that does not exist yet", () => {
    const d = describeLocation(path.join(dir, "not", "yet"), here);
    expect(d.path).toBe(path.join(dir, "not", "yet"));
  });
  it("throws for a relative path", () => {
    expect(() => describeLocation("relative", here)).toThrow(MemexPathsError);
  });
});

describe("locationWarnings", () => {
  it("warns for a synchronized folder with its size, and skips the archive", async () => {
    await fs.writeFile(path.join(dir, ".stfolder"), "");
    await file("Memex/Photos/db.sqlite", 2_500_000);
    const data = path.join(dir, "Memex", "Photos");
    const warnings = await locationWarnings({ data, archive: path.join(dir, "Archive") }, here);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ key: "data", path: data, size: { bytes: 2_500_000, complete: true } });
    expect(warnings[0]!.text).toContain("Syncthing will upload about 2.5 MB now");
  });
});

describe("locations.json", () => {
  it("reads a missing file as empty, and sets and clears an app's folders", async () => {
    const f = path.join(dir, "cfg", "locations.json");
    expect(await readLocations(f)).toEqual({ format: "memex.locations/1", apps: {} });
    const data = path.join(dir, "Photos");
    await setAppLocations(f, "photos", { data });
    await setAppLocations(f, "study", { cache: path.join(dir, "cache") });
    expect((await readLocations(f)).apps).toEqual({ photos: { data }, study: { cache: path.join(dir, "cache") } });
    await setAppLocations(f, "photos", { data: null });
    expect((await readLocations(f)).apps).toEqual({ study: { cache: path.join(dir, "cache") } });
  });
  it("keeps unknown apps and keys that a newer app wrote", async () => {
    const f = path.join(dir, "locations.json");
    await fs.writeFile(f, JSON.stringify({ format: "memex.locations/1", note: "x", apps: { future: { data: "/x", thumbs: "/y" } } }));
    await setAppLocations(f, "photos", { data: path.join(dir, "P") });
    const value = JSON.parse(await fs.readFile(f, "utf8"));
    expect(value.note).toBe("x");
    expect(value.apps.future).toEqual({ data: "/x", thumbs: "/y" });
  });
  it("reads the moved pack store that Memex.Node writes, and keeps it when an app writes", async () => {
    const f = path.join(dir, "locations.json");
    const packs = path.join(dir, "Moved Packs");
    // The layout that Memex.Node writes when it moves the store (memex-node packs move).
    await fs.writeFile(f, JSON.stringify({ format: "memex.locations/1", apps: {}, packs }, null, 2) + "\n");
    expect((await readLocations(f)).packs).toBe(packs);
    await setAppLocations(f, "photos", { data: path.join(dir, "P") });
    expect((await readLocations(f)).packs).toBe(packs);
    await fs.writeFile(f, JSON.stringify({ format: "memex.locations/1", apps: {}, packs: 3 }));
    await expect(readLocations(f)).rejects.toMatchObject({ code: "invalid-locations" });
  });
  it("refuses a relative folder, a wrong format, and broken JSON", async () => {
    const f = path.join(dir, "locations.json");
    await expect(setAppLocations(f, "photos", { data: "Photos" })).rejects.toMatchObject({ code: "relative-path" });
    await fs.writeFile(f, JSON.stringify({ format: "other", apps: {} }));
    await expect(readLocations(f)).rejects.toMatchObject({ code: "invalid-locations" });
    await fs.writeFile(f, "{");
    await expect(readLocations(f)).rejects.toMatchObject({ code: "invalid-locations" });
    await fs.writeFile(f, JSON.stringify({ format: "memex.locations/1", apps: { photos: { data: 3 } } }));
    await expect(readLocations(f)).rejects.toMatchObject({ code: "invalid-locations" });
  });
});

describe("acquireAppLock", () => {
  const options = () => ({ app: "photos", data: path.join(dir, "Memex", "Photos"), state: path.join(dir, "state") });
  it("lets one instance run per app and data folder", async () => {
    const lock = await acquireAppLock(options());
    await expect(acquireAppLock(options())).rejects.toBeInstanceOf(AppLockedError);
    const other = await acquireAppLock({ ...options(), data: path.join(dir, "Other") });
    const otherApp = await acquireAppLock({ ...options(), app: "study" });
    await lock.release();
    const again = await acquireAppLock(options());
    await Promise.all([again.release(), other.release(), otherApp.release()]);
  });
  it("names the holder in the error", async () => {
    const lock = await acquireAppLock(options());
    const error = await acquireAppLock(options()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppLockedError);
    expect((error as AppLockedError).holder?.pid).toBe(process.pid);
    expect((error as AppLockedError).message).toContain(`process ${process.pid}`);
    await lock.release();
  });
  it("takes over a lock whose process is gone", async () => {
    const lock = await acquireAppLock(options());
    const stale = { app: "photos", data: options().data, pid: 2 ** 22 + 12345, hostname: os.hostname(), startedAt: new Date().toISOString() };
    await fs.writeFile(lock.path, JSON.stringify(stale));
    const next = await acquireAppLock(options());
    await next.release();
  });
  it("takes over a lock from before the last boot", async () => {
    const lock = await acquireAppLock(options());
    const old = { app: "photos", data: options().data, pid: process.pid, hostname: os.hostname(), startedAt: "2020-01-01T00:00:00.000Z" };
    await fs.writeFile(lock.path, JSON.stringify(old));
    const next = await acquireAppLock({ ...options(), bootTime: Date.parse("2021-01-01T00:00:00.000Z") });
    await next.release();
  });
});

describe("markCacheFolder", () => {
  it("writes CACHEDIR.TAG once", async () => {
    const cache = path.join(dir, "cache");
    expect(await markCacheFolder(cache, { platform: "win32" })).toEqual([path.join(cache, "CACHEDIR.TAG")]);
    expect((await fs.readFile(path.join(cache, "CACHEDIR.TAG"), "utf8")).startsWith(CACHEDIR_SIGNATURE)).toBe(true);
    expect(await markCacheFolder(cache, { platform: "win32" })).toEqual([]);
  });
  it("also keeps Spotlight out on macOS", async () => {
    const cache = path.join(dir, "cache");
    expect(await markCacheFolder(cache, { platform: "darwin" })).toEqual([
      path.join(cache, "CACHEDIR.TAG"),
      path.join(cache, ".metadata_never_index"),
    ]);
  });
});

describe("writeMemexReadme", () => {
  it("writes README.txt once, and again for a newer version", async () => {
    const root = path.join(dir, "Memex");
    expect(await writeMemexReadme(root, { platform: "linux" })).toBe(true);
    const text = await fs.readFile(path.join(root, "README.txt"), "utf8");
    expect(text).toContain("Back up this folder with your own tool.");
    expect(await writeMemexReadme(root)).toBe(false);
    await fs.writeFile(path.join(root, "README.txt"), `old\nmemex-readme ${MEMEX_README_VERSION - 1}\n`);
    expect(await writeMemexReadme(root)).toBe(true);
  });
  it("leaves a README.txt without a memex-readme line as it is", async () => {
    await fs.writeFile(path.join(dir, "README.txt"), "My own notes about this folder.\n");
    expect(await writeMemexReadme(dir)).toBe(false);
    expect(await fs.readFile(path.join(dir, "README.txt"), "utf8")).toBe("My own notes about this folder.\n");
  });
  it("uses CRLF on Windows", async () => {
    await writeMemexReadme(dir, { platform: "win32" });
    expect(await fs.readFile(path.join(dir, "README.txt"), "utf8")).toContain("\r\n");
  });
});

describe("openDataFolder", () => {
  const state = () => path.join(dir, "state");
  it("makes the default folder on the first run only", async () => {
    const data = path.join(dir, "Memex", "Photos");
    expect(await openDataFolder({ app: "photos", data, source: "default", state: state() })).toEqual({ created: true });
    expect(await openDataFolder({ app: "photos", data, source: "default", state: state() })).toEqual({ created: false });
    await fs.rm(data, { recursive: true });
    const error = await openDataFolder({ app: "photos", data, source: "default", state: state() }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DataFolderError);
    expect(error).toMatchObject({ code: "missing", path: data });
    expect((error as Error).message).toContain("used this folder before");
    await expect(fs.stat(data)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("stops for a missing chosen folder and does not make it", async () => {
    const data = path.join(dir, "Unplugged", "Photos");
    for (const source of ["flag", "variable", "locations"] as const) {
      const error = await openDataFolder({ app: "photos", data, source, state: state() }).catch((e: unknown) => e);
      expect(error).toMatchObject({ code: "missing" });
    }
    const error = await openDataFolder({ app: "photos", data, source: "variable", state: state() }).catch((e: unknown) => e);
    expect((error as Error).message).toContain("MEMEX_PHOTOS_HOME");
    await expect(fs.stat(data)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("opens an existing chosen folder", async () => {
    const data = path.join(dir, "Chosen");
    await fs.mkdir(data);
    expect(await openDataFolder({ app: "photos", data, source: "locations", state: state() })).toEqual({ created: false });
  });
  it("refuses a file in place of the folder", async () => {
    const data = path.join(dir, "file");
    await fs.writeFile(data, "");
    await expect(openDataFolder({ app: "photos", data, source: "default", state: state() })).rejects.toMatchObject({ code: "not-a-folder" });
  });
});
