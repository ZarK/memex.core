import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  PackError,
  STORE_LOCK,
  acquireStoreLock,
  activatePack,
  installPack,
  isAccepted,
  listInstalledPacks,
  lockHostname,
  packDigest,
  packFolder,
  packStoreFolder,
  readStoreIndex,
  readStoreLock,
  recordAcceptance,
  resolvePack,
  sameComputer,
  stagePack,
  type Downloader,
  type PackManifest,
} from "../src/index.js";

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const MODEL = Buffer.alloc(300_000, 7);
const LICENSE = Buffer.from("Permission is granted to use this test file.\n");

let server: http.Server;
let base: string;
let requests: Array<{ url: string; range?: string }> = [];
let corrupt = 0;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    requests.push({ url: req.url ?? "", range: req.headers.range });
    const body = req.url?.endsWith("/model.bin") ? MODEL : req.url?.endsWith("/LICENSE") ? LICENSE : null;
    if (body === null) {
      res.writeHead(404).end();
      return;
    }
    const data = corrupt > 0 && req.url?.endsWith("/model.bin") ? (corrupt--, Buffer.alloc(body.length, 1)) : body;
    const m = /^bytes=(\d+)-$/.exec(req.headers.range ?? "");
    if (m) {
      const from = Number(m[1]);
      res.writeHead(206, { "content-length": data.length - from, "content-range": `bytes ${from}-${data.length - 1}/${data.length}` });
      res.end(data.subarray(from));
    } else {
      res.writeHead(200, { "content-length": data.length });
      res.end(data);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

let root: string;
let acceptances: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "memex-packs-store-"));
  acceptances = path.join(root, "..", `${path.basename(root)}-acceptances.json`);
  requests = [];
  corrupt = 0;
});

/** A manifest for the local test server. The library downloads over http here only because fetch is injected. */
function manifest(over: Partial<PackManifest> = {}): PackManifest {
  return {
    format: "memex.pack/1",
    id: "test-corpus",
    version: "2026.10",
    title: "Test corpus",
    kind: "corpus",
    engine: "files",
    capabilities: [],
    origin: "upstream",
    source: { publisher: "Test", homepage: "https://example.org/test", revision: "v1" },
    license: { spdx: "MIT", url: "https://example.org/test/LICENSE", file: "LICENSE", commercial: "allowed", limits: [], attribution: null, acceptance: "none" },
    files: [
      { path: "data/model.bin", bytes: MODEL.length, sha256: sha(MODEL), url: "https://example.org/test/model.bin" },
      { path: "LICENSE", bytes: LICENSE.length, sha256: sha(LICENSE), url: "https://example.org/test/LICENSE" },
    ],
    ...over,
  };
}

/** fetchDownloader against the local server: the https urls of the manifest are served by it. */
const local: Downloader = async (req) => {
  const { fetchDownloader } = await import("../src/writer.js");
  return fetchDownloader({ ...req, url: req.url.replace("https://example.org", base) });
};

describe("packStoreFolder", () => {
  it("reads the store that Memex.Node moved, from the top-level packs of locations.json", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "memex-packs-home-"));
    const env = { LOCALAPPDATA: path.join(home, "Local"), XDG_CONFIG_HOME: path.join(home, "config") } as NodeJS.ProcessEnv;
    const file = process.platform === "win32" ? path.join(home, "Local", "Memex", "locations.json") : process.platform === "darwin" ? path.join(home, "Library", "Application Support", "Memex", "locations.json") : path.join(home, "config", "memex", "locations.json");
    const before = packStoreFolder({ env, home });
    expect(before.source).toBe("default");
    const moved = path.join(home, "Moved Packs");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ format: "memex.locations/1", apps: {}, packs: moved }, null, 2) + "\n");
    expect(packStoreFolder({ env, home })).toEqual({ path: moved, source: "locations" });
    expect(packStoreFolder({ env: { ...env, MEMEX_HOME: path.join(home, "dev") }, home }).source).toBe("default");
    expect(packStoreFolder({ env: { ...env, MEMEX_PACKS_DIR: path.join(home, "p") }, home })).toEqual({ path: path.join(home, "p"), source: "variable" });
  });
  it("uses MEMEX_PACKS_DIR from the test setup by default", () => {
    expect(packStoreFolder()).toEqual({ path: process.env.MEMEX_PACKS_DIR, source: "variable" });
  });
});

describe("the store lock", () => {
  it("writes the holder in Memex.Node's layout and refuses a second holder", async () => {
    const lock = await acquireStoreLock(root, { program: "test" });
    const holder = JSON.parse(await fs.readFile(path.join(root, STORE_LOCK), "utf8"));
    expect(Object.keys(holder)).toEqual(["pid", "startedAt", "hostname", "program"]);
    expect(holder).toMatchObject({ pid: process.pid, hostname: lockHostname(), program: "test" });
    expect(Number.isNaN(Date.parse(holder.startedAt))).toBe(false);
    const error = await acquireStoreLock(root, { waitMs: 200 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PackError);
    expect((error as PackError).code).toBe("store_busy");
    expect((error as PackError).message).toContain(`test (process ${process.pid})`);
    await lock.release();
    expect(await readStoreLock(root)).toBeNull();
  });
  it("takes over the lock of a process that is gone", async () => {
    await fs.writeFile(path.join(root, STORE_LOCK), JSON.stringify({ pid: 2 ** 22 + 12345, startedAt: "2026-10-26T00:00:00Z", hostname: os.hostname(), program: "memex-node" }));
    const lock = await acquireStoreLock(root, { waitMs: 200 });
    expect((await readStoreLock(root))?.pid).toBe(process.pid);
    await lock.release();
    expect((await fs.readdir(root)).filter((n) => n.startsWith(".lock"))).toEqual([]);
  });
  it("takes over a lock that a crash left half written", async () => {
    const file = path.join(root, STORE_LOCK);
    await fs.writeFile(file, "{\"pid\":");
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(file, old, old);
    const lock = await acquireStoreLock(root, { waitMs: 200 });
    await lock.release();
  });
  it("waits for a lock of another computer (a shared drive)", async () => {
    await fs.writeFile(path.join(root, STORE_LOCK), JSON.stringify({ pid: 1, startedAt: "2026-10-26T00:00:00Z", hostname: "another-computer", program: "memex-node" }));
    await expect(acquireStoreLock(root, { waitMs: 150 })).rejects.toMatchObject({ code: "store_busy" });
  });
  it("matches the computer names that Memex.Node and Node.js give for one computer", () => {
    // .NET Environment.MachineName against Node.js os.hostname(): macOS without and with the mDNS suffix, Windows NetBIOS (15) and DNS.
    expect(sameComputer("host", "host.local")).toBe(true);
    expect(sameComputer("Example-Mac", "example-mac.local")).toBe(true);
    expect(sameComputer("WORKSTATION-LON", "workstation-long-name.corp.example")).toBe(true);
    expect(sameComputer("host", "other")).toBe(false);
    expect(sameComputer("host-a", "host-ab")).toBe(false);
    expect(sameComputer("", "")).toBe(false);
    expect(lockHostname()).not.toContain(".");
  });
  it("takes over the lock of a gone process that Memex.Node wrote with its form of this computer's name", async () => {
    await fs.writeFile(path.join(root, STORE_LOCK), JSON.stringify({ pid: 2 ** 22 + 12346, startedAt: "2026-10-26T00:00:00Z", hostname: `${lockHostname().toUpperCase()}.local`, program: "memex-node" }));
    const lock = await acquireStoreLock(root, { waitMs: 200 });
    expect((await readStoreLock(root))?.pid).toBe(process.pid);
    await lock.release();
  });
});

describe("the layout writer", () => {
  it("installs a pack in Node's layout and resolves it without Node", async () => {
    const m = manifest();
    const steps: string[] = [];
    const installed = await installPack(m, { root, download: local, onProgress: (p) => steps.push(p.phase) });
    const folder = packFolder(m);
    expect(installed).toMatchObject({ id: m.id, version: m.version, digest: packDigest(m.files), folder, active: true, path: path.join(root, ...folder.split("/")) });
    expect(await fs.readFile(path.join(installed.path, "data", "model.bin"))).toEqual(MODEL);
    expect(JSON.parse(await fs.readFile(path.join(installed.path, "memex.pack.json"), "utf8"))).toEqual(m);
    const index = await readStoreIndex(root);
    expect(index.packs[m.id]).toMatchObject({ version: m.version, digest: packDigest(m.files), folder });
    expect(index.packs[m.id]!.activatedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    expect(await fs.readdir(root)).toEqual(expect.not.arrayContaining([".staging", ".lock"]));
    expect(steps).toEqual(expect.arrayContaining(["downloading", "verifying", "activating", "done"]));
    expect((await resolvePack(m.id, { root }))?.path).toBe(installed.path);
    expect(await listInstalledPacks(root)).toHaveLength(1);
  });
  it("continues a download that an earlier run left in <file>.part", async () => {
    const m = manifest();
    const staged = await stagePack(m, { root });
    const part = staged.partPath(m.files[0]!);
    await fs.mkdir(path.dirname(part), { recursive: true });
    await fs.writeFile(part, MODEL.subarray(0, 100_000));
    await staged.close();
    await installPack(m, { root, download: local });
    expect(requests.find((r) => r.url.endsWith("/model.bin"))?.range).toBe("bytes=100000-");
  });
  it("downloads a file that does not match again one time, and stops after a second mismatch", async () => {
    corrupt = 1;
    await installPack(manifest(), { root, download: local });
    expect(requests.filter((r) => r.url.endsWith("/model.bin"))).toHaveLength(2);
    corrupt = 2;
    const other = manifest({ id: "test-corpus-two" });
    await expect(installPack(other, { root, download: local })).rejects.toMatchObject({ code: "checksum_mismatch" });
    expect(await resolvePack("test-corpus-two", { root })).toBeNull();
  });
  it("refuses an unknown license, and a license that needs acceptance until the user accepted it", async () => {
    await expect(stagePack(manifest({ license: { ...manifest().license, commercial: "unknown" } }), { root })).rejects.toMatchObject({ code: "license_unknown" });
    const gated = manifest({ id: "gated-corpus", license: { ...manifest().license, acceptance: "required" } });
    await expect(installPack(gated, { root, download: local, acceptances: { file: acceptances } })).rejects.toMatchObject({ code: "acceptance_required" });
    await recordAcceptance({ pack: "gated-corpus", version: gated.version, textSha256: sha(LICENSE), app: "study" }, { file: acceptances });
    expect(await isAccepted("gated-corpus", sha(LICENSE), { file: acceptances })).toBe(true);
    const doc = JSON.parse(await fs.readFile(acceptances, "utf8"));
    expect(doc.format).toBe("memex.acceptances/1");
    expect(Object.keys(doc.acceptances[0])).toEqual(["pack", "version", "textSha256", "acceptedAt", "app"]);
    await installPack(gated, { root, download: local, acceptances: { file: acceptances } });
    expect((await resolvePack("gated-corpus", { root }))?.active).toBe(true);
  });
  it("downloads nothing and stages nothing before the license is accepted", async () => {
    const gated = manifest({ id: "gated-corpus", license: { ...manifest().license, acceptance: "required" } });
    await expect(installPack(gated, { root, download: local, acceptances: { file: acceptances } })).rejects.toMatchObject({ code: "acceptance_required" });
    await expect(stagePack(gated, { root, acceptances: { file: acceptances } })).rejects.toMatchObject({ code: "acceptance_required" });
    expect(requests).toEqual([]);
    expect(await fs.readdir(root)).toEqual([]);
  });
  it("only activates a version that is installed already, without a download", async () => {
    const first = manifest();
    await installPack(first, { root, download: local });
    expect(requests).toHaveLength(2);
    await installPack(manifest({ version: "2026.11" }), { root, download: local });
    requests = [];
    const steps: string[] = [];
    const again = await installPack(first, { root, download: local, onProgress: (p) => steps.push(p.phase) });
    expect(requests).toEqual([]);
    expect(steps).toEqual(["activating", "done"]);
    expect(again).toMatchObject({ version: first.version, active: true });
    expect((await readStoreIndex(root)).packs[first.id]?.version).toBe(first.version);
  });
  it("lets one download write a staging folder: a second one gets install_busy", async () => {
    const m = manifest();
    const one = await stagePack(m, { root, program: "study" });
    await expect(stagePack(m, { root })).rejects.toMatchObject({ code: "install_busy" });
    await expect(installPack(m, { root, download: local })).rejects.toMatchObject({ code: "install_busy" });
    const lockFile = path.join(one.staging, ".download.lock");
    expect(JSON.parse(await fs.readFile(lockFile, "utf8"))).toMatchObject({ pid: process.pid, hostname: lockHostname(), program: "study" });
    await one.close();
    await expect(fs.access(lockFile)).rejects.toThrow();
    // A download lock that a gone process left is taken over.
    await fs.writeFile(lockFile, JSON.stringify({ pid: 2 ** 22 + 12347, startedAt: "2026-10-26T00:00:00Z", hostname: lockHostname(), program: "study" }));
    await installPack(m, { root, download: local });
    expect((await resolvePack(m.id, { root }))?.active).toBe(true);
    expect(await fs.readdir(path.join(root, ...packFolder(m).split("/")))).not.toContain(".download.lock");
  });
  it("refuses a download lock of another process that runs", async () => {
    const m = manifest();
    const staging = path.join(root, ".staging", ...packFolder(m).split("/"));
    await fs.mkdir(staging, { recursive: true });
    await fs.writeFile(path.join(staging, ".download.lock"), JSON.stringify({ pid: process.ppid, startedAt: "2026-10-26T00:00:00Z", hostname: lockHostname(), program: "study" }));
    await expect(installPack(m, { root, download: local })).rejects.toMatchObject({ code: "install_busy" });
    expect(requests).toEqual([]);
  });
  it("keeps entries and keys of packs.json that it does not know", async () => {
    await fs.writeFile(path.join(root, "packs.json"), JSON.stringify({ format: "memex.packs/1", note: "x", packs: { other: { version: "1", digest: "a".repeat(64), folder: "other/1-aaaaaaaa", activatedAt: "2026-10-26T00:00:00Z", future: 1 } } }));
    await installPack(manifest(), { root, download: local });
    const doc = JSON.parse(await fs.readFile(path.join(root, "packs.json"), "utf8"));
    expect(doc.note).toBe("x");
    expect(doc.packs.other.future).toBe(1);
    expect(Object.keys(doc.packs)).toEqual(["other", "test-corpus"]);
  });
  it("keeps an installed version as it is, and resolves a pinned version that is not active", async () => {
    const first = manifest();
    await installPack(first, { root, download: local });
    const again = await stagePack(first, { root });
    for (const f of first.files) {
      await fs.mkdir(path.dirname(again.filePath(f)), { recursive: true });
      await fs.copyFile(path.join(root, ...packFolder(first).split("/"), ...f.path.split("/")), again.filePath(f));
    }
    await activatePack(again);
    const second = manifest({ version: "2026.11" });
    await installPack(second, { root, download: local });
    expect((await resolvePack(first.id, { root }))?.version).toBe("2026.11");
    const pinned = await resolvePack(first.id, { root, version: "2026.10" });
    expect(pinned).toMatchObject({ version: "2026.10", active: false, folder: packFolder(first) });
    expect(await resolvePack(first.id, { root, version: "2027.01" })).toBeNull();
    expect(await resolvePack("missing", { root })).toBeNull();
  });
  it("holds the store lock while it activates", async () => {
    const m = manifest();
    const staged = await stagePack(m, { root });
    for (const f of m.files) {
      await fs.mkdir(path.dirname(staged.filePath(f)), { recursive: true });
      await fs.writeFile(staged.filePath(f), f.path === "LICENSE" ? LICENSE : MODEL);
    }
    const lock = await acquireStoreLock(root, { program: "memex-node" });
    await expect(activatePack(staged, { lockWaitMs: 150 })).rejects.toMatchObject({ code: "store_busy" });
    await lock.release();
    await activatePack(staged);
    await staged.close();
  });
});
