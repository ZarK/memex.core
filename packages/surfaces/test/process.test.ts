// The app lock and the call routing across real processes: the test app (fixtures/demo-app.mjs, built on dist) as a
// stdio MCP server and as a running app. `pnpm test` builds dist first.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { MemexPaths } from "@tjalve/memex-storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as lib from "../src/index.js";
import { connect, runCli } from "../src/index.js";
import { demoRegistry } from "./fixtures/demo-registry.mjs";

const demo = path.join(import.meta.dirname, "fixtures", "demo-app.mjs");
let dir: string;
let paths: MemexPaths;
let env: Record<string, string>;

beforeEach(async () => {
  await fs.access(path.join(import.meta.dirname, "..", "dist", "index.js"));
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "memex-surfaces-process-"));
  paths = {
    data: path.join(dir, "data"),
    cache: path.join(dir, "cache"),
    logs: path.join(dir, "logs"),
    state: path.join(dir, "state"),
    packs: path.join(dir, "packs"),
    apps: path.join(dir, "apps"),
    archive: path.join(dir, "archive"),
  };
  env = { ...(process.env as Record<string, string>), MEMEX_APPS_DIR: paths.apps, SURFACES_TEST_HOME: dir };
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function serve(): Promise<ChildProcess> {
  const app = spawn(process.execPath, [demo, "serve"], { env, stdio: ["pipe", "pipe", "inherit"] });
  await new Promise<void>((resolve, reject) => {
    app.stdout!.on("data", (chunk: Buffer) => {
      if (chunk.toString().startsWith("ready ")) resolve();
    });
    app.on("exit", (code) => reject(new Error(`The test app exited with ${code}.`)));
  });
  return app;
}

async function stop(app: ChildProcess): Promise<void> {
  if (app.exitCode !== null) return;
  const exited = new Promise((resolve) => app.on("exit", resolve));
  app.stdin!.end();
  await exited;
}

describe("memex-<app> mcp when the app does not run", () => {
  it("answers parallel tool calls, which share the app lock of the MCP server's process", async () => {
    const client = new Client({ name: "test", version: "1" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [demo, "mcp"], env, stderr: "inherit" }));
    try {
      const results = await Promise.all(Array.from({ length: 6 }, () => client.callTool({ name: "contacts_persons_count", arguments: {} })));
      for (const result of results) {
        expect(result.isError).toBeFalsy();
        expect(JSON.parse((result.content as Array<{ text: string }>)[0]!.text)).toEqual({ count: 3, origin: "agent" });
      }
      expect(await fs.readdir(path.join(paths.state, "locks"))).toEqual([]);
    } finally {
      await client.close();
    }
  }, 20_000);
});

describe("a running app built on serveApp", () => {
  it("holds the app lock, and gets a write that the CLI sends while it is busy", async () => {
    const app = await serve();
    try {
      // A long job keeps the app's event loop busy past the two seconds that the first GET /health waits.
      const job = (await connect("contacts", { apps: paths.apps })).call("contacts.jobs.run", { ms: 3500 });
      await new Promise((resolve) => setTimeout(resolve, 300));
      const out: string[] = [];
      const code = await runCli(["call", "contacts.notes.add", "--json"], {
        registry: demoRegistry(lib),
        license: "MIT",
        paths,
        apps: paths.apps,
        io: { stdout: (t) => out.push(t), stderr: (t) => out.push(t), stdin: async () => "" },
      });
      expect(code).toBe(0);
      // The write ran in the app's process, not in this one.
      expect(JSON.parse(out.join("\n")).pid).toBe(app.pid);
      expect(await job).toEqual({ ran: 3500 });
    } finally {
      await stop(app);
    }
  }, 30_000);

  it("keeps a CLI call in another process out while it serves and its record says stopped", async () => {
    const app = await serve();
    try {
      // A record that says stopped does not let a second process write the database: the app holds the lock.
      const record = JSON.parse(await fs.readFile(path.join(paths.apps, "contacts.json"), "utf8"));
      await fs.writeFile(path.join(paths.apps, "contacts.json"), JSON.stringify({ ...record, running: null }));
      const out: string[] = [];
      const code = await runCli(["call", "contacts.notes.add", "--json"], {
        registry: demoRegistry(lib),
        license: "MIT",
        paths,
        apps: paths.apps,
        io: { stdout: (t) => out.push(t), stderr: (t) => out.push(t), stdin: async () => "" },
      });
      expect(code).toBe(1);
      const { error } = JSON.parse(out.join("\n"));
      expect(error.code).toBe("unavailable");
      expect(error.message).toContain(`process ${app.pid}`);
    } finally {
      await stop(app);
    }
  }, 20_000);
});
