import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import {
  emptyJournal,
  fileTimeToMs,
  listFolder,
  plan,
  readJournal,
  readMacFlags,
  scanFolder,
  watchFolder,
  writeJournal,
  type ListedFile,
} from "../src/index.js";

let dir: string;
const win = process.platform === "win32";

async function sha(root: string, f: ListedFile): Promise<string | null> {
  try {
    return createHash("sha256").update(await fs.readFile(path.join(root, ...f.path.split("/")))).digest("hex");
  } catch {
    return null;
  }
}

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "memex-folders-"));
  await fs.mkdir(path.join(dir, "album", "2024"), { recursive: true });
  await fs.writeFile(path.join(dir, "album", "a.txt"), "alpha");
  await fs.writeFile(path.join(dir, "album", "2024", "Ålesund æøå 🌊.txt"), "unicode");
  await fs.writeFile(path.join(dir, ".hidden.txt"), "hidden");
  await fs.mkdir(path.join(dir, "linked-target"));
  await fs.writeFile(path.join(dir, "linked-target", "t.txt"), "target");
  try {
    await fs.symlink(path.join(dir, "linked-target"), path.join(dir, "link"), "junction");
  } catch {
    // Links need a privilege on some systems; the link test then has nothing to skip.
  }
});

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("listing on disk", () => {
  it("lists files without following links, and leaves out hidden files", async () => {
    const listing = await listFolder(dir);
    const paths = listing.files.map((f) => f.path).sort();
    expect(paths).toEqual(["album/2024/Ålesund æøå 🌊.txt", "album/a.txt", "linked-target/t.txt"]);
    expect(listing.skippedFiles).toEqual([".hidden.txt"]);
    expect(listing.complete).toBe(true);
    expect(listing.files.every((f) => !f.onlineOnly && f.sizeKnown)).toBe(true);
    const a = listing.files.find((f) => f.path === "album/a.txt")!;
    expect(a.size).toBe(5);
    expect(Math.abs(a.modifiedMs - (await fs.stat(path.join(dir, "album", "a.txt"))).mtimeMs)).toBeLessThan(2);
    if (await fs.lstat(path.join(dir, "link")).then(() => true, () => false)) expect(listing.links).toEqual(["link"]);
  });

  it("refuses a relative or missing root", async () => {
    await expect(listFolder("relative/path")).rejects.toMatchObject({ code: "relative-path" });
    await expect(listFolder(path.join(dir, "nope"))).rejects.toMatchObject({ code: "missing" });
  });

  it("journal: unchanged, changed, moved, missing, and new across scans", async () => {
    const journalFile = path.join(dir, "..", `${path.basename(dir)}-journal.json`);
    try {
      const hash = (f: ListedFile) => sha(dir, f);
      let listing = await listFolder(dir);
      let scan = await scanFolder(listing, await readJournal(journalFile, listing.root), { quietMs: 0, hash });
      expect(scan.counts.new).toBe(3);
      // The app records the content hash when it reads a new file; it proves moves where file ids are weak or unusable.
      for (const e of scan.journal.entries) e.contentHash = await sha(dir, { path: e.path } as ListedFile);
      await writeJournal(journalFile, scan.journal);

      listing = await listFolder(dir);
      scan = await scanFolder(listing, await readJournal(journalFile, listing.root), { quietMs: 0, hash });
      expect(scan.counts).toMatchObject({ unchanged: 3, new: 0, changed: 0, moved: 0, missing: 0 });
      await writeJournal(journalFile, scan.journal);

      await fs.writeFile(path.join(dir, "album", "a.txt"), "alpha, longer now");
      await fs.rename(path.join(dir, "linked-target", "t.txt"), path.join(dir, "album", "moved.txt"));
      await fs.writeFile(path.join(dir, "album", "new.txt"), "new");
      await fs.rm(path.join(dir, "album", "2024", "Ålesund æøå 🌊.txt"));
      listing = await listFolder(dir);
      scan = await scanFolder(listing, await readJournal(journalFile, listing.root), { quietMs: 0, hash });
      const outcomes = Object.fromEntries(scan.decisions.filter((d) => d.outcome !== "unchanged").map((d) => [d.path, d.outcome]));
      expect(outcomes).toEqual({
        "album/a.txt": "changed",
        "album/moved.txt": "moved",
        "album/new.txt": "new",
        "album/2024/Ålesund æøå 🌊.txt": "missing",
      });
      const moved = scan.decisions.find((d) => d.outcome === "moved")!;
      expect(moved.from).toBe("linked-target/t.txt");
      await writeJournal(journalFile, scan.journal);
      const again = await readJournal(journalFile, listing.root);
      expect(again.entries.find((e) => e.path === "album/2024/Ålesund æøå 🌊.txt")?.state).toBe("missing");
      await expect(readJournal(journalFile, path.join(dir, "other"))).rejects.toMatchObject({ code: "invalid-journal" });
    } finally {
      await fs.rm(journalFile, { force: true });
    }
  });

  it("a file just written is settling and stays out of the journal", async () => {
    await fs.writeFile(path.join(dir, "fresh.txt"), "fresh");
    const listing = await listFolder(dir);
    const scan = await scanFolder(listing, emptyJournal(listing.root));
    const fresh = scan.decisions.find((d) => d.path === "fresh.txt")!;
    expect(fresh.settling).toBe(true);
    expect(scan.journal.entries.some((e) => e.path === "fresh.txt")).toBe(false);
    const p = plan(scan);
    expect(p.settling.files).toBeGreaterThanOrEqual(1);
    await fs.rm(path.join(dir, "fresh.txt"));
  });
});

describe.runIf(win)("Windows listing helper", () => {
  it("reads paths longer than 260 characters and the offline attribute", async () => {
    let deep = path.join(dir, "deep");
    for (let i = 0; i < 12; i++) deep = path.join(deep, `segment-name-number-${String(i).padStart(2, "0")}`);
    await fs.mkdir(deep, { recursive: true });
    const deepFile = path.join(deep, "æøå deep.txt");
    await fs.writeFile(deepFile, "deep");
    expect(deepFile.length).toBeGreaterThan(260);
    const offline = path.join(dir, "album", "offline.txt");
    await fs.writeFile(offline, "marked offline");
    execFileSync("attrib", ["+O", offline]);
    try {
      const listing = await listFolder(dir);
      const found = listing.files.find((f) => f.path.endsWith("æøå deep.txt"));
      expect(found?.size).toBe(4);
      expect(found?.fileId).toMatch(/^[0-9a-f]{32}$/);
      expect(listing.fileSystem).toBe("ntfs");
      expect(listing.idReliability).toBe("strong");
      expect(listing.files.find((f) => f.path === "album/offline.txt")?.onlineOnly).toBe(true);
      const scan = await scanFolder(listing, emptyJournal(listing.root), { quietMs: 0 });
      expect(plan(scan).onlineOnly.files).toBe(1);
    } finally {
      execFileSync("attrib", ["-O", offline]);
      await fs.rm(offline);
      await fs.rm(path.join(dir, "deep"), { recursive: true });
    }
  });

  it("leaves out names with a lone surrogate with name-not-unicode, and the listing stays complete", async () => {
    // Node.js cannot make such names (its strings go to the file system as UTF-8), so PowerShell makes them.
    const root = path.join(dir, "surrogates");
    await fs.mkdir(root);
    await fs.writeFile(path.join(root, "keep.txt"), "keep");
    const names = "$n = @(('lone' + [char]0xD800 + '.txt'), ('lone' + [char]0xD801 + '.txt'), ('album' + [char]0xDC00))";
    const powershell = (script: string): void => {
      execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
        env: { ...process.env, MEMEX_SURROGATE_ROOT: root },
        windowsHide: true,
      });
    };
    powershell(
      `$ErrorActionPreference = 'Stop'; $r = $env:MEMEX_SURROGATE_ROOT; ${names}
       [IO.File]::WriteAllText([IO.Path]::Combine($r, $n[0]), 'a')
       [IO.File]::WriteAllText([IO.Path]::Combine($r, $n[1]), 'b')
       [void][IO.Directory]::CreateDirectory([IO.Path]::Combine($r, $n[2]))
       [IO.File]::WriteAllText([IO.Path]::Combine($r, 'pair' + [char]0xD83C + [char]0xDF0A + '.txt'), 'c')`,
    );
    try {
      const listing = await listFolder(root);
      expect(listing.files.map((f) => f.path).sort()).toEqual(["keep.txt", "pair🌊.txt"]);
      expect(listing.warnings.map((w) => [w.code, w.path])).toEqual([
        ["name-not-unicode", ""],
        ["name-not-unicode", ""],
        ["name-not-unicode", ""],
      ]);
      expect(listing.unlistedFolders).toEqual([]);
      expect(listing.skippedFiles).toEqual([]);
      expect(listing.complete).toBe(true);
    } finally {
      powershell(
        `$ErrorActionPreference = 'Stop'; $r = $env:MEMEX_SURROGATE_ROOT; ${names}
         [IO.File]::Delete([IO.Path]::Combine($r, $n[0]))
         [IO.File]::Delete([IO.Path]::Combine($r, $n[1]))
         [IO.Directory]::Delete([IO.Path]::Combine($r, $n[2]))`,
      );
      await fs.rm(root, { recursive: true });
    }
  });

  it("converts FILETIME to milliseconds", () => {
    expect(fileTimeToMs("116444736000000000")).toBe(0);
    expect(fileTimeToMs("0")).toBeNull();
  });
});

describe("macOS flags", () => {
  it("parses stat output and fails closed", async () => {
    expect(await readMacFlags(["/a", "/b"], async () => "40000000\n0\n")).toEqual([0x40000000, 0]);
    expect(await readMacFlags(["/a"], async () => { throw new Error("no stat"); })).toBeNull();
    expect(await readMacFlags(["/a", "/b"], async () => "0\n")).toBeNull();
  });
});

describe("watchFolder", () => {
  it("scans on start and after a change, once the folder is quiet", async () => {
    // macOS FSEvents can report changes made just before the watch started (the earlier tests write in this folder),
    // so a "change" scan may come before this test writes anything. The contract is that a change made while
    // watching leads to a scan once the folder has been quiet for quietMs; an extra scan is harmless.
    const quietMs = 200;
    const watched = path.join(dir, "album", "watched.txt");
    const reasons: string[] = [];
    // Set before the write: its change event can arrive before the write call returns.
    let writeStartedAt: number | null = null;
    // Timers may fire a millisecond early by Date.now(), so allow a little.
    const quietEnough = quietMs - 10;
    let w: ReturnType<typeof watchFolder> | undefined;
    const sawChange = new Promise<number>((resolve) => {
      w = watchFolder(dir, {
        quietMs,
        periodicMs: 0,
        onScan: (reason) => {
          reasons.push(reason);
          if (reason === "change" && writeStartedAt !== null && Date.now() - writeStartedAt >= quietEnough) resolve(Date.now() - writeStartedAt);
        },
      });
    });
    try {
      expect(w!.mode).toBe("live");
      await new Promise((r) => setTimeout(r, 300));
      writeStartedAt = Date.now();
      await fs.writeFile(watched, "x");
      const after = await sawChange;
      expect(after).toBeGreaterThanOrEqual(quietEnough);
      expect(reasons[0]).toBe("start");
      expect(reasons.slice(1).every((r) => r === "change")).toBe(true);
    } finally {
      w?.close();
      await fs.rm(watched, { force: true });
    }
  });

  it("falls back to scan-on-start when the folder cannot be watched", async () => {
    const reasons: string[] = [];
    const w = watchFolder(dir, {
      periodicMs: 0,
      onScan: (r) => reasons.push(r),
      watchFn: (() => {
        throw new Error("ENOSPC");
      }) as never,
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(w.mode).toBe("scan-on-start");
    expect(reasons).toEqual(["start"]);
    w.close();
  });

  it("falls back when the watch fails later", async () => {
    const emitter = new EventEmitter() as EventEmitter & { close: () => void };
    emitter.close = () => undefined;
    const reasons: string[] = [];
    const w = watchFolder(dir, { periodicMs: 0, onScan: (r) => reasons.push(r), watchFn: (() => emitter) as never });
    expect(w.mode).toBe("live");
    emitter.emit("error", new Error("gone"));
    await new Promise((r) => setTimeout(r, 10));
    expect(w.mode).toBe("scan-on-start");
    expect(reasons).toEqual(["watch-failed", "start"]);
    w.close();
  });
});

describe("memex-folders CLI", () => {
  it("prints counts and sizes, never file names", async () => {
    const lines: string[] = [];
    expect(await main(["scan", dir, "--plan"], { out: (l) => lines.push(l), err: (l) => lines.push(l) })).toBe(0);
    const text = lines.join("\n");
    expect(text).toContain("Listed: ");
    expect(text).toContain("No confirmation needed");
    expect(text).not.toContain("a.txt");
    expect(text).not.toContain("Ålesund");
    const json: string[] = [];
    expect(await main(["scan", dir, "--plan", "--json"], { out: (l) => json.push(l) })).toBe(0);
    const parsed = JSON.parse(json.join("\n")) as { listing: { files: number }; plan: { needsConfirmation: boolean } };
    expect(parsed.listing.files).toBeGreaterThan(0);
    expect(parsed.plan.needsConfirmation).toBe(false);
  });

  it("exits 2 on a usage error and 1 on a missing folder", async () => {
    const quiet = { out: () => undefined, err: () => undefined };
    expect(await main(["scan"], quiet)).toBe(2);
    expect(await main(["scan", path.join(dir, "nope")], quiet)).toBe(1);
  });
});
