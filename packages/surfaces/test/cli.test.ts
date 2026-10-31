import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { MemexPaths } from "@tjalve/memex-storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as lib from "../src/index.js";
import { invokeAnywhere, runCli, serveApp, writeAppRecord, type CliOptions } from "../src/index.js";
import { demoRegistry } from "./fixtures/demo-registry.mjs";

let dir: string;
let paths: MemexPaths;
let out: string[];
let err: string[];
let stdin: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "memex-surfaces-cli-"));
  paths = {
    data: path.join(dir, "data"),
    cache: path.join(dir, "cache"),
    logs: path.join(dir, "logs"),
    state: path.join(dir, "state"),
    packs: path.join(dir, "packs"),
    apps: path.join(dir, "apps"),
    archive: path.join(dir, "archive"),
  };
  out = [];
  err = [];
  stdin = "";
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function options(extra: Partial<CliOptions> = {}): CliOptions {
  return {
    registry: demoRegistry(lib),
    license: "MIT",
    notices: "zod: MIT",
    paths,
    apps: paths.apps,
    io: { stdout: (t) => out.push(t), stderr: (t) => err.push(t), stdin: async () => stdin },
    ...extra,
  };
}

const cli = (argv: string[], extra?: Partial<CliOptions>) => runCli(argv, options(extra));

describe("memex-<app> call", () => {
  it("runs a capability in this process when the app does not run, and prints JSON", async () => {
    expect(await cli(["call", "contacts.persons.get", '{"id":"p3"}'])).toBe(0);
    expect(JSON.parse(out.join("\n"))).toEqual({ id: "p3", name: "Grace Hopper" });
  });

  it("reads the input from standard input with -", async () => {
    stdin = '{"q":"Al"}';
    expect(await cli(["call", "contacts.persons.list", "-"])).toBe(0);
    expect(JSON.parse(out.join("\n")).items).toEqual([{ id: "p2", name: "Alan Turing" }]);
  });

  it("calls with the origin cli and an empty input", async () => {
    expect(await cli(["call", "contacts.persons.count"])).toBe(0);
    expect(JSON.parse(out.join("\n"))).toEqual({ count: 3, origin: "cli" });
  });

  it("takes the app lock, and fails while another process holds it", async () => {
    const holder = spawn(process.execPath, [path.join(import.meta.dirname, "fixtures", "hold-lock.mjs"), paths.data, paths.state], {
      stdio: ["pipe", "pipe", "inherit"],
    });
    try {
      const pid = await new Promise<string>((resolve, reject) => {
        holder.stdout!.on("data", (chunk: Buffer) => {
          const match = /^locked (\d+)/.exec(chunk.toString());
          if (match) resolve(match[1]!);
        });
        holder.on("exit", (code) => reject(new Error(`The lock holder exited with ${code}.`)));
      });
      expect(await cli(["call", "contacts.persons.count", "--json"])).toBe(1);
      const { error } = JSON.parse(out.join("\n"));
      expect(error.code).toBe("unavailable");
      expect(error.message).toContain(`process ${pid}`);
    } finally {
      const exited = new Promise((resolve) => holder.on("exit", resolve));
      holder.stdin!.end();
      await exited;
    }
    out = [];
    expect(await cli(["call", "contacts.persons.count"])).toBe(0);
    expect(await fs.readdir(path.join(paths.state, "locks"))).toEqual([]);
  });

  it("runs parallel calls in one process under one app lock", async () => {
    const codes = await Promise.all(Array.from({ length: 6 }, () => cli(["call", "contacts.notes.add"])));
    expect(codes).toEqual([0, 0, 0, 0, 0, 0]);
    expect(out.map((o) => JSON.parse(o).pid)).toEqual(Array(6).fill(process.pid));
    expect(await fs.readdir(path.join(paths.state, "locks"))).toEqual([]);
    // The lock is free again for the next call.
    expect(await cli(["call", "contacts.notes.add"])).toBe(0);
  });

  it("sends the call to the running app through its record", async () => {
    const registry = demoRegistry(lib, { version: "1.0.0" });
    const running = await serveApp({ registry, kind: "tool", data: paths.data, state: paths.state, apps: paths.apps });
    try {
      // The call keeps its origin through the running app: cli for call, agent for mcp.
      expect(await cli(["call", "contacts.persons.count"])).toBe(0);
      expect(JSON.parse(out.join("\n"))).toEqual({ count: 3, origin: "cli" });
      expect(await invokeAnywhere(options(), "contacts.persons.count", {}, "agent")).toEqual({ count: 3, origin: "agent" });
      out = [];
      expect(await cli(["call", "contacts.persons.get", '{"id":"zz"}', "--json"])).toBe(1);
      expect(JSON.parse(out.join("\n")).error).toMatchObject({ code: "not_found", field: "id" });
    } finally {
      await running.stop();
    }
  });

  it("prints a failure on standard error, or the error body with --json, and exits 1", async () => {
    expect(await cli(["call", "contacts.nobody.here"])).toBe(1);
    expect(err.join("\n")).toMatch(/There is no capability contacts.nobody.here/);
    expect(out).toEqual([]);
    expect(await cli(["call", "contacts.persons.get", "{bad", "--json"])).toBe(1);
    expect(JSON.parse(out.join("\n")).error.code).toBe("invalid_json");
  });
});

describe("the other commands", () => {
  it("lists the capabilities, with schemas under --json", async () => {
    expect(await cli(["capabilities"])).toBe(0);
    expect(out[0]).toMatch(/^contacts\.persons\.list\s+read\s+List persons$/);
    out = [];
    expect(await cli(["capabilities", "--json"])).toBe(0);
    const list = JSON.parse(out.join("\n"));
    expect(list[0]).toMatchObject({ id: "contacts.persons.list", kind: "read", mcp: true, input: { type: "object" }, output: { type: "object" } });
    expect(list.find((c: { id: string }) => c.id === "contacts.secrets.list").mcp).toBe(false);
  });

  it("shows about", async () => {
    expect(await cli(["about", "--json"])).toBe(0);
    expect(JSON.parse(out.join("\n"))).toEqual({
      name: "Memex Contacts",
      app: "contacts",
      version: "1.0.0",
      license: "MIT",
      data: paths.data,
      notices: "zod: MIT",
    });
    out = [];
    expect(await cli(["about"])).toBe(0);
    expect(out.join("\n")).toContain("Memex Contacts 1.0.0 (contacts)");
  });

  it("fails open with exit code 2 for a headless tool, and runs the app's open", async () => {
    expect(await cli(["open"])).toBe(2);
    expect(err.join("\n")).toMatch(/has no UI/);
    let opened = false;
    expect(await cli(["open"], { open: async () => void (opened = true) })).toBe(0);
    expect(opened).toBe(true);
  });

  it("runs doctor: folders, sync, app record, token file, and the app's own checks", async () => {
    expect(await cli(["doctor", "--json"], { doctor: async () => [{ name: "service node", status: "ok", detail: "runs" }] })).toBe(0);
    const { checks } = JSON.parse(out.join("\n"));
    expect(checks.map((c: { name: string }) => c.name)).toEqual([
      "folder data",
      "folder state",
      "folder cache",
      "folder logs",
      "sync",
      "app record",
      "service node",
    ]);
    expect(checks.find((c: { name: string }) => c.name === "app record").detail).toMatch(/not installed/);

    const running = await serveApp({ registry: demoRegistry(lib), kind: "tool", data: paths.data, state: paths.state, apps: paths.apps });
    try {
      out = [];
      expect(await cli(["doctor", "--json"])).toBe(0);
      const names = JSON.parse(out.join("\n")).checks.map((c: { name: string; status: string }) => `${c.name}:${c.status}`);
      expect(names).toContain("app record:ok");
      expect(names).toContain("token file:ok");
      await fs.writeFile(running.tokenFile, "wrong");
      out = [];
      expect(await cli(["doctor"])).toBe(1);
      expect(out.join("\n")).toMatch(/fail\s+token file/);
    } finally {
      await running.stop();
    }
  });

  it("reports a broken app record in doctor", async () => {
    await fs.mkdir(paths.apps, { recursive: true });
    await fs.writeFile(path.join(paths.apps, "contacts.json"), '{"format":"memex.app/0"}');
    expect(await cli(["doctor"])).toBe(1);
    expect(out.join("\n")).toMatch(/fail\s+app record/);
    // A broken record does not stop a local call.
    out = [];
    expect(await cli(["call", "contacts.persons.count"])).toBe(0);
  });

  it("warns about an old version in the record", async () => {
    await writeAppRecord(
      { format: "memex.app/1", app: "contacts", name: "Memex Contacts", kind: "tool", version: "0.9.0", executable: path.join(dir, "x"), running: null },
      { apps: paths.apps },
    );
    expect(await cli(["doctor"])).toBe(0);
    expect(out.join("\n")).toMatch(/warn\s+version: The record is from version 0.9.0/);
  });

  it("exits 2 on a usage error", async () => {
    expect(await cli([])).toBe(2);
    expect(await cli(["frobnicate"])).toBe(2);
    expect(await cli(["call"])).toBe(2);
    expect(await cli(["call", "a", "b", "c"])).toBe(2);
    expect(await cli(["about", "--bogus"])).toBe(2);
    expect(err.join("\n")).toContain("Usage:");
    expect(await cli(["--help"])).toBe(0);
    expect(out.join("\n")).toContain("memex-contacts mcp");
  });
});
