// The conformance check against real processes: the test app (fixtures/demo-app.mjs, built on dist) as a running
// app with an HTTP surface, a stdio MCP server, and a memex-contacts CLI. `pnpm test` builds dist first.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkApp, formatResults, writeAppRecord, type CheckResult } from "../src/index.js";
import { main } from "../src/check-cli.js";

const demo = path.join(import.meta.dirname, "fixtures", "demo-app.mjs");
let dir: string;
let apps: string;
let app: ChildProcess;
const saved = { apps: process.env.MEMEX_APPS_DIR, home: process.env.SURFACES_TEST_HOME, mcp: process.env.SURFACES_TEST_MCP };

const byId = (results: CheckResult[]) => Object.fromEntries(results.map((r) => [r.id, r.status]));

beforeAll(async () => {
  await fs.access(path.join(import.meta.dirname, "..", "dist", "index.js"));
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "memex-surfaces-check-"));
  apps = path.join(dir, "apps");
  const bin = path.join(dir, "bin");
  await fs.mkdir(bin);
  let shim: string;
  if (process.platform === "win32") {
    shim = path.join(bin, "memex-contacts.cmd");
    await fs.writeFile(shim, `@"${process.execPath}" "${demo}" %*\r\n`);
  } else {
    shim = path.join(bin, "memex-contacts");
    await fs.writeFile(shim, `#!/bin/sh\nexec "${process.execPath}" "${demo}" "$@"\n`, { mode: 0o755 });
  }
  process.env.MEMEX_APPS_DIR = apps;
  process.env.SURFACES_TEST_HOME = dir;
  process.env.SURFACES_TEST_MCP = shim;
  app = spawn(process.execPath, [demo, "serve"], { stdio: ["pipe", "pipe", "inherit"] });
  await new Promise<void>((resolve, reject) => {
    app.stdout!.on("data", (chunk: Buffer) => {
      if (chunk.toString().startsWith("ready ")) resolve();
    });
    app.on("exit", (code) => reject(new Error(`The test app exited with ${code}.`)));
  });
}, 30_000);

afterAll(async () => {
  if (app && app.exitCode === null) {
    const exited = new Promise((resolve) => app.on("exit", resolve));
    app.stdin!.end();
    await exited;
  }
  for (const [key, value] of [
    ["MEMEX_APPS_DIR", saved.apps],
    ["SURFACES_TEST_HOME", saved.home],
    ["SURFACES_TEST_MCP", saved.mcp],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (dir) await fs.rm(dir, { recursive: true, force: true });
});

describe("checkApp", () => {
  it("passes an app built on the library: record, HTTP, MCP, and CLI", async () => {
    const results = await checkApp("contacts", { apps, timeoutMs: 20_000 });
    const failed = results.filter((r) => r.status === "fail");
    expect(failed, formatResults(results)).toEqual([]);
    const ids = byId(results);
    for (const id of [
      "record",
      "health",
      "guard.host",
      "guard.token",
      "guard.cookie",
      "guard.origin",
      "guard.content-type",
      "guard.cors",
      "api.list",
      "api.ids",
      "api.openapi",
      "api.unknown",
      "mcp.start",
      "mcp.names",
      "mcp.capabilities",
      "mcp.readonly",
      "mcp.errors",
      "cli.capabilities",
      "cli.about",
      "cli.errors",
      "cli.usage",
    ]) {
      expect(ids[id], id).toBe("pass");
    }
  }, 60_000);

  it("runs as memex-surfaces check with --json and exit code 0", async () => {
    const out: string[] = [];
    expect(await main(["check", "contacts", "--apps", apps, "--skip-commands", "--json"], (t) => out.push(t))).toBe(0);
    const report = JSON.parse(out.join("\n"));
    expect(report.app).toBe("contacts");
    expect(report.results.find((r: CheckResult) => r.id === "mcp").status).toBe("skip");
  }, 30_000);

  it("fails a missing record and an app that skips the request checks", async () => {
    const missing = await checkApp("photos", { apps });
    expect(missing).toEqual([{ id: "record", status: "fail", message: expect.stringMatching(/missing/) }]);

    const other = path.join(dir, "other-apps");
    const loose: Server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
      res.end(JSON.stringify({ status: "ok", app: "health", version: "1.0.0" }));
    });
    await new Promise<void>((resolve) => loose.listen(0, "127.0.0.1", resolve));
    try {
      const tokenFile = path.join(dir, "loose-token");
      await fs.writeFile(tokenFile, "short");
      await writeAppRecord(
        {
          format: "memex.app/1",
          app: "health",
          name: "Memex Health",
          kind: "app",
          version: "1.0.0",
          executable: path.join(dir, "health"),
          running: { pid: process.pid, startedAt: "2026-11-10T08:00:00Z", url: `http://127.0.0.1:${(loose.address() as AddressInfo).port}`, tokenFile },
        },
        { apps: other },
      );
      const results = await checkApp("health", { apps: other, skipCommands: true });
      const ids = byId(results);
      expect(ids["record.mcp"]).toBe("fail");
      expect(ids["token.format"]).toBe("fail");
      expect(ids["health"]).toBe("pass");
      expect(ids["guard.host"]).toBe("fail");
      expect(ids["guard.token"]).toBe("fail");
      expect(ids["api.list"]).toBe("fail");
      const out: string[] = [];
      expect(await main(["check", "health", "--apps", other, "--skip-commands"], (t) => out.push(t))).toBe(1);
      expect(out.join("\n")).toMatch(/FAIL\s+guard.host/);
    } finally {
      await new Promise((resolve) => loose.close(resolve));
    }
  }, 30_000);

  it("fails a record that says the app runs when it does not", async () => {
    const other = path.join(dir, "stale-apps");
    await writeAppRecord(
      {
        format: "memex.app/1",
        app: "study",
        name: "Memex Study",
        kind: "app",
        version: "1.0.0",
        executable: path.join(dir, "study"),
        mcp: { command: "memex-study", args: ["mcp"] },
        running: { pid: 999_999_999, startedAt: "2026-11-10T08:00:00Z", url: "http://127.0.0.1:9", tokenFile: path.join(dir, "t") },
      },
      { apps: other },
    );
    const results = await checkApp("study", { apps: other, skipCommands: true });
    expect(results.find((r) => r.id === "http")).toMatchObject({ status: "fail", message: expect.stringMatching(/stale/) });
  });

  it("fails a record that other accounts can read", async () => {
    const other = path.join(dir, "open-apps");
    const record = {
      format: "memex.app/1",
      app: "study",
      name: "Memex Study",
      kind: "service",
      version: "1.0.0",
      executable: path.join(dir, "study"),
      running: null,
    };
    await fs.mkdir(other, { recursive: true });
    await fs.writeFile(path.join(other, "study.json"), JSON.stringify(record), { mode: 0o644 });
    const id = process.platform === "win32" ? "record.acl" : "record.mode";
    const open = await checkApp("study", { apps: other, skipCommands: true });
    expect(open.find((r) => r.id === id), formatResults(open)).toMatchObject({ status: "fail" });
    await writeAppRecord(record as Parameters<typeof writeAppRecord>[0], { apps: other });
    const closed = await checkApp("study", { apps: other, skipCommands: true });
    expect(closed.find((r) => r.id === id), formatResults(closed)).toMatchObject({ status: "pass" });
  });

  it("exits 2 on a usage error", async () => {
    expect(await main(["check"], () => undefined)).toBe(2);
    expect(await main(["inspect", "contacts"], () => undefined)).toBe(2);
    expect(await main(["check", "Bad-Id"], () => undefined)).toBe(2);
  });
});
