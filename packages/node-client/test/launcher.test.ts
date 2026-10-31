import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compareVersions, ensureNode, ensureService, installedCopies, newestCopy, probe, servicesFolder, withLaunchLock, type ServiceCopy } from "../src/index.js";
import { recordCopy } from "../src/launcher.js";
import type { AppRecord } from "@tjalve/memex-surfaces";

const fake = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-service.mjs");
let root: string;
let env: NodeJS.ProcessEnv;
let started: number[];

const copy = (version: string): ServiceCopy => ({ app: "node", version, command: process.execPath, args: [fake, "--version", version], source: "given" });
const options = (copies: ServiceCopy[]) => ({
  apps: path.join(root, "apps"),
  state: path.join(root, "state"),
  services: path.join(root, "services"),
  copies,
  env,
});
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const waitFor = async (check: () => boolean, ms = 5000) => {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "memex-launcher-"));
  env = { ...process.env, MEMEX_APPS_DIR: path.join(root, "apps"), FAKE_STATE: path.join(root, "fake-state"), FAKE_LIFETIME_MS: "20000" };
  started = [];
});

afterEach(async () => {
  for (const pid of started) {
    try {
      process.kill(pid);
    } catch {
      // gone
    }
  }
  await new Promise((r) => setTimeout(r, 100));
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

describe("versions", () => {
  it("orders semantic versions with pre-releases first", () => {
    const sorted = ["1.0.0", "1.0.0-rc.1", "0.9.10", "1.0.0-alpha", "0.10.0", "1.0.0-rc.10", "1.0.0-rc.2"].sort(compareVersions);
    expect(sorted).toEqual(["0.9.10", "0.10.0", "1.0.0-alpha", "1.0.0-rc.1", "1.0.0-rc.2", "1.0.0-rc.10", "1.0.0"]);
    expect(compareVersions("1.2.3+build.5", "1.2.3")).toBe(0);
    expect(() => compareVersions("1.2", "1.2.0")).toThrow(/Not a version/);
  });

  it("picks the newest copy, and a services copy of the same version first", () => {
    const a: ServiceCopy = { app: "node", version: "0.2.0", command: "a", args: [], source: "record" };
    const b: ServiceCopy = { app: "node", version: "0.2.0", command: "b", args: [], source: "services" };
    const c: ServiceCopy = { app: "node", version: "0.1.9", command: "c", args: [], source: "services" };
    expect(newestCopy([a, c, b])?.command).toBe("b");
    expect(newestCopy([])).toBeNull();
  });
});

describe("services folder", () => {
  it("is in the per-user programs folder of each OS, and MEMEX_SERVICES_DIR overrides it", () => {
    expect(servicesFolder({ platform: "win32", env: { LOCALAPPDATA: "C:\\Users\\alex\\AppData\\Local" }, home: "C:\\Users\\alex" })).toBe(
      "C:\\Users\\alex\\AppData\\Local\\Programs\\Memex\\Services",
    );
    expect(servicesFolder({ platform: "darwin", env: {}, home: "/Users/alex" })).toBe("/Users/alex/Library/Application Support/Memex/Services");
    expect(servicesFolder({ platform: "linux", env: {}, home: "/home/alex" })).toBe("/home/alex/.local/share/memex/services");
    expect(servicesFolder({ platform: "linux", env: { XDG_DATA_HOME: "relative" }, home: "/home/alex" })).toBe("/home/alex/.local/share/memex/services");
    expect(servicesFolder({ platform: "linux", env: { MEMEX_SERVICES_DIR: "/opt/memex" }, home: "/home/alex" })).toBe("/opt/memex");
    expect(() => servicesFolder({ platform: "linux", env: { MEMEX_SERVICES_DIR: "opt" }, home: "/home/alex" })).toThrow(/absolute/);
  });

  it("reads the version folders that have a valid service.json, and says why it leaves the others out", async () => {
    const services = path.join(root, "services");
    const folder = (version: string, manifest: unknown, program = "memex-node.exe") => {
      const dir = path.join(services, "node", version);
      fs.mkdirSync(dir, { recursive: true });
      if (manifest !== undefined) fs.writeFileSync(path.join(dir, "service.json"), JSON.stringify(manifest));
      if (program) fs.writeFileSync(path.join(dir, program), "");
      return dir;
    };
    const good = (version: string, extra = {}) => ({ format: "memex.service/1", app: "node", version, command: "memex-node.exe", args: [], ...extra });
    folder("0.1.0", good("0.1.0"));
    folder("0.2.0", good("0.2.0", { args: ["--x"] }));
    folder("0.3.0", good("0.2.0"));
    folder("0.4.0", undefined);
    folder("0.5.0", good("0.5.0", { command: "../0.1.0/memex-node.exe" }));
    folder("0.6.0", good("0.6.0", { command: "missing.exe" }));
    folder("0.7.0", { ...good("0.7.0"), format: "memex.service/2" });
    folder("not-a-version", good("not-a-version"));
    const log: string[] = [];
    const copies = await installedCopies("node", { services, log: (l) => log.push(l) });
    expect(copies.map((c) => [c.version, c.args])).toEqual([
      ["0.1.0", []],
      ["0.2.0", ["--x"]],
    ]);
    expect(copies[0]!.command).toBe(path.join(services, "node", "0.1.0", "memex-node.exe"));
    expect(log.join("\n")).toMatch(/0\.3\.0.*names node 0\.2\.0/);
    expect(log.join("\n")).toMatch(/0\.4\.0.*service\.json cannot be read/);
    expect(log.join("\n")).toMatch(/0\.5\.0.*not inside the version folder/);
    expect(log.join("\n")).toMatch(/0\.6\.0.*missing/);
    expect(log.join("\n")).toMatch(/0\.7\.0.*memex\.service\/2/);
    expect(await installedCopies("user", { services })).toEqual([]);
  });

  it("takes the args of the record's program from the service.json beside it, and leaves out a copy that service.json does not name", async () => {
    const dir = path.join(root, "copy", "0.3.0");
    fs.mkdirSync(dir, { recursive: true });
    const program = path.join(dir, "memex-user.exe");
    fs.writeFileSync(program, "");
    const record = (executable: string, version = "0.3.0") =>
      ({ format: "memex.app/1", app: "user", name: "Memex User", kind: "service", version, executable, mcp: { command: executable, args: [] }, running: null }) as AppRecord;
    // A single program without service.json starts without args.
    expect(await recordCopy(record(program))).toMatchObject({ command: program, args: [], source: "record" });
    // A runtime with a script: the args come from service.json.
    fs.writeFileSync(path.join(dir, "service.json"), JSON.stringify({ format: "memex.service/1", app: "user", version: "0.3.0", command: "memex-user.exe", args: ["app/dist/bin.js", "serve"] }));
    expect(await recordCopy(record(program))).toMatchObject({ version: "0.3.0", command: program, args: ["app/dist/bin.js", "serve"], source: "record" });
    // service.json of another version, or one that names another command: the record's copy is left out.
    expect(await recordCopy(record(program, "0.4.0"))).toBeNull();
    const other = path.join(dir, "node.exe");
    fs.writeFileSync(other, "");
    expect(await recordCopy(record(other))).toBeNull();
  });
});

describe("launch lock", () => {
  it("lets one launcher in at a time", async () => {
    const state = path.join(root, "state");
    const order: string[] = [];
    const slow = withLaunchLock(state, 5000, async () => {
      order.push("a in");
      await new Promise((r) => setTimeout(r, 300));
      order.push("a out");
    });
    await new Promise((r) => setTimeout(r, 50));
    await withLaunchLock(state, 5000, async () => {
      order.push("b in");
    });
    await slow;
    expect(order).toEqual(["a in", "a out", "b in"]);
    expect(fs.existsSync(path.join(state, "launch.lock"))).toBe(false);
  });

  it("takes over a lock whose process is gone, and gives up after the timeout on a live one", async () => {
    const state = path.join(root, "state");
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, "launch.lock"), JSON.stringify({ pid: 2 ** 22 + 7, hostname: os.hostname(), startedAt: new Date().toISOString() }));
    expect(await withLaunchLock(state, 1000, async () => "ran")).toBe("ran");
    fs.writeFileSync(path.join(state, "launch.lock"), JSON.stringify({ pid: process.ppid, hostname: os.hostname(), startedAt: new Date().toISOString() }));
    await expect(withLaunchLock(state, 300, async () => "ran")).rejects.toThrow(/Another launcher holds/);
  });
});

describe("ensureService", () => {
  it("says that a service without a copy is not installed", async () => {
    await expect(ensureService("node", options([]))).rejects.toThrow(/node is not installed/);
  });

  it("starts the newest copy, finds it the second time, and lets a newer copy take over while the older one drains", async () => {
    const first = await ensureService("node", options([copy("1.0.0"), copy("0.9.0")]));
    expect(first.action).toBe("started");
    expect(first.started?.version).toBe("1.0.0");
    const pid1 = first.record.running!.pid;
    started.push(pid1);
    expect(first.record.version).toBe("1.0.0");

    const again = await ensureService("node", options([copy("1.0.0")]));
    expect(again.action).toBe("found");
    expect(again.record.running!.pid).toBe(pid1);

    // The older copy holds work, so it drains instead of stopping at once.
    const node = await ensureNode(options([copy("1.0.0")]));
    const holder = await (node as unknown as { send(op: unknown): Promise<unknown> }).send({
      operation: "hold", method: "POST", path: "/v1/hold?ms=1500", response: "json", status: 200,
    });
    expect(holder).toEqual({ held: 1 });

    const newer = await ensureService("node", options([copy("1.0.0"), copy("1.1.0")]));
    expect(newer.action).toBe("took-over");
    expect(newer.drained).toEqual({ pid: pid1, version: "1.0.0" });
    const pid2 = newer.record.running!.pid;
    started.push(pid2);
    expect(pid2).not.toBe(pid1);
    expect(newer.record.version).toBe("1.1.0");
    expect(alive(pid1)).toBe(true);
    await waitFor(() => !alive(pid1));

    // The client follows Node to the newer copy.
    const status = (await node.getStatus()) as unknown as { version: string; pid: number };
    expect(status.version).toBe("1.1.0");
    expect(status.pid).toBe(pid2);
    expect((await probe("node", { apps: path.join(root, "apps") })).state).toBe("running");
  });

  it("keeps the calls on a lease at the Node that granted it after a takeover, and moves other calls to the newer copy", async () => {
    const node = await ensureNode(options([copy("4.0.0")]));
    const pid1 = node.launch!.record.running!.pid;
    started.push(pid1);
    const lease = (await node.createLease({ app: "photos", lane: "interactive", device: "gpu:0" } as never)) as unknown as { lease: { id: string; pid: number } };
    expect(lease.lease.pid).toBe(pid1);

    const newer = await ensureService("node", options([copy("4.0.0"), copy("4.1.0")]));
    expect(newer.action).toBe("took-over");
    const pid2 = newer.record.running!.pid;
    started.push(pid2);

    // The old Node drains and refuses new work with 503 draining: the client finds the newer copy and sends it again.
    const second = (await node.createLease({ app: "photos", lane: "interactive", device: "gpu:0" } as never)) as unknown as { lease: { id: string; pid: number } };
    expect(second.lease.pid).toBe(pid2);
    expect((await node.getStatus()) as unknown).toMatchObject({ version: "4.1.0", pid: pid2, leases: 1 });
    expect((await node.releaseLease(second.lease.id)) as unknown).toMatchObject({ lease: { pid: pid2, state: "ended" } });

    // The lease stays at the draining Node, which still serves it.
    const renewed = (await node.renewLease(lease.lease.id)) as unknown as { lease: { pid: number; state: string } };
    expect(renewed.lease).toMatchObject({ pid: pid1, state: "granted" });
    const released = (await node.releaseLease(lease.lease.id)) as unknown as { lease: { pid: number; state: string } };
    expect(released.lease).toMatchObject({ pid: pid1, state: "ended" });
    await waitFor(() => !alive(pid1));
    await expect(node.renewLease(lease.lease.id)).rejects.toMatchObject({ code: "not_found" });
  });

  it("starts the newest copy again when the record names a draining copy", async () => {
    const first = await ensureService("node", options([copy("2.0.0")]));
    started.push(first.record.running!.pid);
    const node = await ensureNode(options([copy("2.0.0")]));
    const drained = await node.drain();
    expect(drained.draining).toBe(true);
    await waitFor(() => !alive(first.record.running!.pid));
    const next = await ensureService("node", options([copy("2.0.0")]));
    started.push(next.record.running!.pid);
    expect(next.action).toBe("started");
  });

  it("fails when the copy does not start", async () => {
    const broken: ServiceCopy = { app: "node", version: "3.0.0", command: process.execPath, args: ["-e", "process.exit(3)"], source: "given" };
    await expect(ensureService("node", { ...options([broken]), timeoutMs: 3000 })).rejects.toThrow(/exit code 3/);
  });
});
