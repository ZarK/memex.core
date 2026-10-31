import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { AppLockedError, acquireAppLock } from "@tjalve/memex-storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as lib from "../src/index.js";
import {
  SurfaceError,
  appRecordPath,
  appsFolder,
  connect,
  discover,
  discoverAll,
  markStopped,
  parseAppRecord,
  readAppRecord,
  serveApp,
  writeAppRecord,
  type AppRecord,
} from "../src/index.js";
import { checkAccountOnly, parseDacl, restrictToAccount } from "../src/account-acl.js";
import { demoRegistry } from "./fixtures/demo-registry.mjs";

const fixtures = path.join(import.meta.dirname, "fixtures", "contracts");
const fixture = async (name: string) => JSON.parse(await fs.readFile(path.join(fixtures, name), "utf8")) as unknown;

let dir: string;
let apps: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "memex-surfaces-"));
  apps = path.join(dir, "apps");
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const stopped: AppRecord = {
  format: "memex.app/1",
  app: "contacts",
  name: "Memex Contacts",
  kind: "tool",
  version: "1.0.0",
  executable: path.join(os.tmpdir(), "memex-contacts"),
  mcp: { command: "memex-contacts", args: ["mcp"] },
  running: null,
};

describe("the contract fixtures", () => {
  it("parses every app record fixture", async () => {
    for (const name of ["app-photos.json", "app-node.json", "app-contacts-stopped.json"]) {
      const record = parseAppRecord(await fixture(name));
      expect(record.format).toBe("memex.app/1");
    }
  });

  it("matches the error body fixture", async () => {
    const body = (await fixture("error.json")) as lib.ErrorBody;
    const error = new SurfaceError(body.error.code, body.error.message, { field: body.error.field, hint: body.error.hint });
    expect(error.body).toEqual(body);
    expect(error.status).toBe(400);
  });
});

describe("parseAppRecord", () => {
  it("refuses another format first", () => {
    expect(() => parseAppRecord({ ...stopped, format: "memex.app/2" })).toThrow(/memex.app\/2/);
  });

  it("refuses a wrong endpoint, an unknown field, and a non-loopback url", () => {
    const running = { pid: 1, startedAt: "2026-11-10T08:00:00Z" };
    expect(() => parseAppRecord({ ...stopped, running })).toThrow(/url and tokenFile, or socket/);
    expect(() => parseAppRecord({ ...stopped, running: { ...running, url: "http://127.0.0.1:1", socket: "s" } })).toThrow();
    expect(() => parseAppRecord({ ...stopped, running: { ...running, url: "http://0.0.0.0:80", tokenFile: "t" } })).toThrow(/running.url/);
    expect(() => parseAppRecord({ ...stopped, extra: true })).toThrow();
    expect(() => parseAppRecord({ ...stopped, kind: "daemon" })).toThrow(/kind/);
    expect(parseAppRecord({ ...stopped, running: { ...running, socket: "\\\\.\\pipe\\memex-node-3f9c2a7d41b0e865" } }).running?.socket).toBeDefined();
    expect(parseAppRecord({ ...stopped, running: { ...running, socket: "/home/alex/.local/state/memex/node/node.sock" } }).running?.socket).toBeDefined();
  });

  it("refuses a socket that is not a local named pipe or an absolute path", () => {
    const running = { pid: 1, startedAt: "2026-11-10T08:00:00Z" };
    for (const socket of ["node.sock", "\\\\server\\pipe\\memex-node", "\\\\.\\pipe\\", "\\\\.\\pipe\\a\\b", "http://127.0.0.1:1"]) {
      expect(() => parseAppRecord({ ...stopped, running: { ...running, socket } }), socket).toThrow(/running.socket/);
    }
  });
});

describe("writeAppRecord", () => {
  it.skipIf(process.platform === "win32")("writes a record that only this account can read", async () => {
    const file = await writeAppRecord(stopped, { apps });
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(apps)).mode & 0o777).toBe(0o700);
  });

  it.runIf(process.platform === "win32")("gives the record an access list with only this account on Windows", async () => {
    const file = await writeAppRecord(stopped, { apps });
    expect(await checkAccountOnly(file)).toEqual({ ok: true, others: [], inherits: false });
    await writeAppRecord({ ...stopped, version: "2.0.0" }, { apps });
    expect(await checkAccountOnly(file)).toEqual({ ok: true, others: [], inherits: false });
  });

  it.runIf(process.platform === "win32")("removes entries for other accounts that are not marked as inherited", async () => {
    // A folder whose access list is from before automatic inheritance (the user profile's Temp folder on a GitHub
    // runner is one) gives a new file copies of its entries that are not marked as inherited, so removing only the
    // inherited entries leaves SYSTEM and Administrators in place. "icacls /inheritance:d" makes the same copies.
    const icacls = (args: string[]) => promisify(execFile)(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe"), args);
    await fs.mkdir(apps);
    const file = path.join(apps, "copied.json");
    await fs.writeFile(file, "{}");
    await icacls([file, "/grant", "*S-1-5-32-544:F", "*S-1-5-18:F", "/q"]);
    await icacls([file, "/inheritance:d", "/q"]);
    await icacls([file, "/inheritance:r", "/q"]);
    expect(await checkAccountOnly(file)).toMatchObject({ ok: false, inherits: false, others: expect.arrayContaining(["BA"]) });
    await restrictToAccount(file);
    expect(await checkAccountOnly(file)).toEqual({ ok: true, others: [], inherits: false });
    const saved = path.join(dir, "saved-acl.txt");
    await icacls([file, "/save", saved, "/q"]);
    expect((await fs.readFile(saved)).toString("utf16le")).toMatch(/D:PAI?\(A;;FA;;;[^)]+\)\s*$/);
  });

  it("reads the DACL of an SDDL string", () => {
    const sid = "S-1-5-21-1-2-3-1001";
    const me = { sid, ofThisComputer: true };
    expect(parseDacl(`O:${sid}G:${sid}D:PAI(A;;FA;;;${sid})`, me)).toEqual({ ok: true, others: [], inherits: false });
    expect(parseDacl(`D:PAI(A;;FA;;;${sid})(A;;FA;;;SY)`, me).ok).toBe(true);
    expect(parseDacl(`D:AI(A;ID;FA;;;${sid})(A;ID;FA;;;BA)`, me)).toEqual({ ok: false, others: ["BA"], inherits: true });
    expect(parseDacl(`D:PAI(A;;FA;;;${sid})(A;;FR;;;S-1-5-32-545)`, me)).toEqual({ ok: false, others: ["S-1-5-32-545"], inherits: false });
    expect(parseDacl(`D:PAI(D;;FA;;;WD)(A;;FA;;;${sid})`, me).ok).toBe(true);
    expect(parseDacl("", me).ok).toBe(false);
  });

  it("reads LA as this account only for the local Administrator account", () => {
    const admin = "S-1-5-21-1-2-3-500";
    expect(parseDacl("D:PAI(A;;FA;;;LA)", { sid: admin, ofThisComputer: true })).toEqual({ ok: true, others: [], inherits: false });
    expect(parseDacl("D:PAI(A;;FA;;;LA)", { sid: admin, ofThisComputer: false })).toEqual({ ok: false, others: ["LA"], inherits: false });
    expect(parseDacl("D:PAI(A;;FA;;;LA)", { sid: "S-1-5-21-1-2-3-1001", ofThisComputer: true }).others).toEqual(["LA"]);
    expect(parseDacl("D:PAI(A;;FA;;;LG)", { sid: "S-1-5-21-1-2-3-501", ofThisComputer: true }).ok).toBe(true);
    expect(parseDacl("D:PAI(A;;FA;;;LA)(A;;FA;;;BA)", { sid: admin, ofThisComputer: true }).others).toEqual(["BA"]);
  });
});

describe("app records on disk", () => {
  it("uses MEMEX_APPS_DIR, or the given folder", () => {
    expect(appsFolder({ apps })).toBe(apps);
    expect(appRecordPath("contacts", { apps })).toBe(path.join(apps, "contacts.json"));
  });

  it("writes whole and reads back; a missing record is not installed", async () => {
    expect(await readAppRecord("contacts", { apps })).toBeNull();
    await writeAppRecord(stopped, { apps });
    expect(await readAppRecord("contacts", { apps })).toEqual(stopped);
    expect((await fs.readdir(apps)).sort()).toEqual(["contacts.json"]);
    expect(await discover("contacts", { apps })).toMatchObject({ state: "stopped", record: stopped });
    expect(await discover("photos", { apps })).toEqual({ app: "photos", state: "not-installed", record: null });
  });

  it("refuses a record whose app is not its file name", async () => {
    await fs.mkdir(apps, { recursive: true });
    await fs.writeFile(path.join(apps, "photos.json"), JSON.stringify(stopped));
    await expect(readAppRecord("photos", { apps })).rejects.toThrow(/names the app contacts/);
  });

  it("finds a record stale when the process is gone", async () => {
    const tokenFile = path.join(dir, "token");
    await writeAppRecord({ ...stopped, running: { pid: 999_999_999, startedAt: "2026-11-10T08:00:00Z", url: "http://127.0.0.1:9", tokenFile } }, { apps });
    const found = await discover("contacts", { apps });
    expect(found.state).toBe("stopped");
    expect(found.stale).toMatch(/999999999 is gone/);
    await expect(connect("contacts", { apps })).rejects.toMatchObject({ code: "unavailable" });
  });

  it("finds a record stale when /health names another app", async () => {
    const other: Server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", app: "photos", version: "1.0.0" }));
    });
    await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
    try {
      const url = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;
      await writeAppRecord({ ...stopped, running: { pid: process.pid, startedAt: "2026-11-10T08:00:00Z", url, tokenFile: "t" } }, { apps });
      const found = await discover("contacts", { apps });
      expect(found).toMatchObject({ state: "stopped", stale: "GET /health names the app photos." });
    } finally {
      await new Promise((resolve) => other.close(resolve));
    }
  });

  it("marks a record unresponsive when its process runs and /health does not answer in time", async () => {
    const silent: Server = createServer(() => {});
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    try {
      const url = `http://127.0.0.1:${(silent.address() as AddressInfo).port}`;
      await writeAppRecord({ ...stopped, running: { pid: process.pid, startedAt: "2026-11-10T08:00:00Z", url, tokenFile: "t" } }, { apps });
      expect(await discover("contacts", { apps, timeoutMs: 200 })).toMatchObject({ state: "stopped", unresponsive: true });
    } finally {
      silent.closeAllConnections();
      await new Promise((resolve) => silent.close(resolve));
    }
    // A refused connection is a stale record, not a busy app.
    expect((await discover("contacts", { apps })).unresponsive).toBeUndefined();
  });

  it("answers a body that is not JSON from the app as internal", async () => {
    const odd: Server = createServer((req, res) => {
      if (req.url === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ status: "ok", app: "contacts", version: "1.0.0" }));
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html>");
    });
    await new Promise<void>((resolve) => odd.listen(0, "127.0.0.1", resolve));
    try {
      const url = `http://127.0.0.1:${(odd.address() as AddressInfo).port}`;
      const tokenFile = path.join(dir, "token");
      await fs.writeFile(tokenFile, "t".repeat(43));
      await writeAppRecord({ ...stopped, running: { pid: process.pid, startedAt: "2026-11-10T08:00:00Z", url, tokenFile } }, { apps });
      const error = await (await connect("contacts", { apps })).call("contacts.persons.count").catch((e: unknown) => e);
      expect(error).toMatchObject({ code: "internal", status: 500 });
    } finally {
      await new Promise((resolve) => odd.close(resolve));
    }
  });

  it("holds the app lock while it serves, and releases it on stop", async () => {
    const data = path.join(dir, "data");
    const state = path.join(dir, "state");
    const running = await serveApp({ registry: demoRegistry(lib), kind: "tool", data, state, apps });
    try {
      await expect(acquireAppLock({ app: "contacts", data, state })).rejects.toBeInstanceOf(AppLockedError);
    } finally {
      await running.stop();
    }
    const lock = await acquireAppLock({ app: "contacts", data, state });
    // An app that took the lock itself passes it, and serveApp leaves it to the app.
    const again = await serveApp({ registry: demoRegistry(lib), kind: "tool", data, state, apps, lock });
    await again.stop();
    expect(await fs.readdir(path.join(state, "locks"))).toHaveLength(1);
    await lock.release();
    expect(await fs.readdir(path.join(state, "locks"))).toEqual([]);
  });

  it("serves an app, announces it, connects to it, and marks it stopped", async () => {
    const registry = demoRegistry(lib);
    const state = path.join(dir, "state");
    const running = await serveApp({ registry, kind: "tool", data: path.join(dir, "data"), state, apps, executable: path.join(dir, "memex-contacts") });
    try {
      expect(await fs.readFile(running.tokenFile, "utf8")).toBe(running.server.token);
      if (process.platform !== "win32") expect((await fs.stat(running.tokenFile)).mode & 0o777).toBe(0o600);
      const record = await readAppRecord("contacts", { apps });
      expect(record).toMatchObject({
        format: "memex.app/1",
        kind: "tool",
        mcp: { command: "memex-contacts", args: ["mcp"] },
        running: { pid: process.pid, url: running.server.url, tokenFile: running.tokenFile },
      });
      expect(record!.running!.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      expect((await discover("contacts", { apps })).state).toBe("running");
      expect((await discoverAll({ apps })).map((d) => [d.app, d.state])).toEqual([["contacts", "running"]]);

      const client = await connect("contacts", { apps });
      expect(await client.call("contacts.persons.get", { id: "p2" })).toEqual({ id: "p2", name: "Alan Turing" });
      expect((await client.capabilities()).capabilities.length).toBe(registry.capabilities.length);
      const error = await client.call("contacts.persons.get", { id: "nobody" }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SurfaceError);
      expect(error).toMatchObject({ code: "not_found", status: 404, field: "id" });
    } finally {
      await running.stop();
    }
    expect((await readAppRecord("contacts", { apps }))?.running).toBeNull();
    expect((await discover("contacts", { apps })).state).toBe("stopped");
  });

  it("leaves a record of another process alone on markStopped", async () => {
    const running = { pid: process.pid + 1, startedAt: "2026-11-10T08:00:00Z", url: "http://127.0.0.1:9", tokenFile: "t" };
    await writeAppRecord({ ...stopped, running }, { apps });
    await markStopped("contacts", { apps });
    expect((await readAppRecord("contacts", { apps }))?.running).toEqual(running);
  });
});
