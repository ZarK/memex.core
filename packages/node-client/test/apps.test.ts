import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeAppRecord } from "@tjalve/memex-surfaces";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureApp, type AppConnection } from "../src/index.js";

// The demo app of @tjalve/memex-surfaces (Memex Contacts with a few capabilities), run from its built package.
const demoApp = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "surfaces", "test", "fixtures", "demo-app.mjs");
let root: string;
let apps: string;
let open: AppConnection[];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "memex-ensure-app-"));
  apps = path.join(root, "apps");
  open = [];
});

afterEach(async () => {
  for (const c of open) await c.close();
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

const env = () => ({ ...process.env, MEMEX_APPS_DIR: apps, SURFACES_TEST_HOME: path.join(root, "home") });

const record = (mcp?: { command: string; args: string[] }, kind: "tool" | "service" = "tool") =>
  writeAppRecord(
    { format: "memex.app/1", app: "contacts", name: "Memex Contacts", kind, version: "1.0.0", executable: process.execPath, ...(mcp ? { mcp } : {}), running: null },
    { apps },
  );

describe("ensureApp", () => {
  it("starts the MCP server of the app record, lists its tools, and runs a capability", async () => {
    await record({ command: process.execPath, args: [demoApp, "mcp"] });
    const contacts = await ensureApp("contacts", { apps, env: env() });
    open.push(contacts);
    expect(contacts.pid).toBeGreaterThan(0);
    const tools = await contacts.listTools();
    expect(tools.map((t) => t.name)).toContain("contacts_persons_list");
    const page = await contacts.call<{ items: Array<{ name: string }> }>("contacts.persons.list", { q: "Grace" });
    expect(page.items.map((p) => p.name)).toEqual(["Grace Hopper"]);
    await expect(contacts.call("contacts.persons.get", { id: "nobody" })).rejects.toMatchObject({ code: "not_found" });

    const again = await ensureApp("contacts", { apps, env: env() });
    expect(again).toBe(contacts);
    await contacts.close();
    const fresh = await ensureApp("contacts", { apps, env: env() });
    open.push(fresh);
    expect(fresh).not.toBe(contacts);
    expect(fresh.pid).not.toBe(contacts.pid);
  });

  it("fails a pending call at once when the MCP server stops, and starts a new one on the next call", async () => {
    const crash = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "crash-mcp.mjs");
    await record({ command: process.execPath, args: [crash] });
    const contacts = await ensureApp("contacts", { apps, env: env() });
    expect((await contacts.listTools()).map((t) => t.name)).toEqual(["contacts_people_list"]);
    const before = Date.now();
    await expect(contacts.callTool("contacts_people_list")).rejects.toThrow(/Connection closed/);
    expect(Date.now() - before).toBeLessThan(5000);
    const fresh = await ensureApp("contacts", { apps, env: env() });
    open.push(fresh);
    expect(fresh).not.toBe(contacts);
  });

  it("takes the command from the caller when there is no record", async () => {
    await expect(ensureApp("contacts", { apps })).rejects.toThrow(/not installed/);
    const contacts = await ensureApp("contacts", { apps, env: env(), command: { command: process.execPath, args: [demoApp, "mcp"] } });
    open.push(contacts);
    expect((await contacts.listTools()).length).toBeGreaterThan(0);
  });

  it("refuses a service and a record without a command, and reports a server that does not start", async () => {
    await record(undefined);
    await expect(ensureApp("contacts", { apps })).rejects.toThrow(/names no MCP command/);
    await record({ command: process.execPath, args: ["-e", "process.exit(4)"] });
    await expect(ensureApp("contacts", { apps, timeoutMs: 3000 })).rejects.toThrow(/memex-contacts mcp/);
    await record({ command: process.execPath, args: [] }, "service");
    await expect(ensureApp("contacts", { apps })).rejects.toThrow(/is a service/);
  });
});
