// ensureUser and the service launcher with the stand-in service of the node-client tests (a separate process that
// follows the drain rules of contracts/surfaces.md). The proof against the packaged Memex.User is in memex.user.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ServiceCopy } from "@tjalve/memex-node-client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureContacts, ensureUser } from "../src/index.js";

const fake = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../node-client/test/fixtures/fake-service.mjs");
let root: string;
let env: NodeJS.ProcessEnv;
const started: number[] = [];

const copy = (app: string, version: string): ServiceCopy => ({ app, version, command: process.execPath, args: [fake, "--app", app, "--version", version], source: "given" });
const options = (copies: ServiceCopy[]) => ({ apps: path.join(root, "apps"), state: path.join(root, "state"), services: path.join(root, "services"), copies, env });
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "memex-user-ensure-"));
  env = { ...process.env, MEMEX_APPS_DIR: path.join(root, "apps"), FAKE_STATE: path.join(root, "fake-state"), FAKE_LIFETIME_MS: "20000" };
});

afterEach(async () => {
  for (const pid of started.splice(0)) {
    try {
      process.kill(pid);
    } catch {
      // gone
    }
  }
  await new Promise((r) => setTimeout(r, 100));
});

describe("ensureUser", () => {
  it("lets a newer copy of Memex.User take over at once, and the client follows it", async () => {
    const user = await ensureUser(options([copy("user", "0.1.0")]));
    const first = user.launch!;
    expect(first.action).toBe("started");
    const pid1 = first.record.running!.pid;
    started.push(pid1);

    const newer = await ensureUser(options([copy("user", "0.1.0"), copy("user", "0.2.0")]));
    expect(newer.launch!.action).toBe("took-over");
    expect(newer.launch!.drained).toEqual({ pid: pid1, version: "0.1.0" });
    const pid2 = newer.launch!.record.running!.pid;
    started.push(pid2);
    expect(pid2).not.toBe(pid1);

    // The first client still has the endpoint of the older copy. A call there gets 503 draining, or finds the
    // older copy gone; either way the client finds the newer copy and sends the call there.
    await expect(user.changesList({})).rejects.toMatchObject({ code: "not_found" });
    expect(user.launch!.record.running!.pid).toBe(pid1);
    await expect(newer.changesList({})).rejects.toMatchObject({ code: "not_found" });
    await new Promise((r) => setTimeout(r, 300));
    expect(alive(pid1)).toBe(false);
  });

  it("does not start or drain with start: false", async () => {
    const user = await ensureUser(options([copy("user", "0.3.0")]));
    started.push(user.launch!.record.running!.pid);
    const found = await ensureUser({ ...options([copy("user", "0.3.0"), copy("user", "0.4.0")]), start: false });
    expect(found.launch!.action).toBe("found");
    expect(found.launch!.record.running!.pid).toBe(user.launch!.record.running!.pid);
  });
});

describe("ensureContacts", () => {
  it("uses a copy that runs as it is: Memex.Contacts has no drain yet", async () => {
    const contacts = await ensureContacts(options([copy("contacts", "0.1.0")]));
    const pid = contacts.launch!.record.running!.pid;
    started.push(pid);
    const again = await ensureContacts(options([copy("contacts", "0.1.0"), copy("contacts", "0.2.0")]));
    expect(again.launch!.action).toBe("found");
    expect(again.launch!.record.running!.pid).toBe(pid);
  });
});
