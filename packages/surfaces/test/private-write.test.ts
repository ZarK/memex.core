import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Each restrictToAccount call records the state of its file when it returns: the size and who can read it. The real
// function still runs.
const seen = vi.hoisted(() => [] as { size: number; mode: number; check: unknown }[]);
vi.mock("../src/account-acl.js", async (original) => {
  const actual = await original<typeof import("../src/account-acl.js")>();
  return {
    ...actual,
    restrictToAccount: async (file: string) => {
      await actual.restrictToAccount(file);
      const stat = await fs.stat(file);
      seen.push({
        size: stat.size,
        mode: stat.mode & 0o777,
        check: process.platform === "win32" ? await actual.checkAccountOnly(file) : null,
      });
    },
  };
});

const { writeAppRecord, writeTokenFile } = await import("../src/index.js");
const { checkAccountOnly } = await import("../src/account-acl.js");

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "memex-surfaces-private-"));
  seen.length = 0;
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function expectPrivateBeforeContent(): void {
  expect(seen).toHaveLength(1);
  expect(seen[0]!.size).toBe(0);
  if (process.platform === "win32") expect(seen[0]!.check).toEqual({ ok: true, others: [], inherits: false });
  else expect(seen[0]!.mode).toBe(0o600);
}

describe("private files", () => {
  it("sets the access list of the record while the file is still empty, then writes the content", async () => {
    const apps = path.join(dir, "apps");
    const file = await writeAppRecord(
      {
        format: "memex.app/1",
        app: "contacts",
        name: "Memex Contacts",
        kind: "tool",
        version: "1.0.0",
        executable: path.join(os.tmpdir(), "memex-contacts"),
        mcp: { command: "memex-contacts", args: ["mcp"] },
        running: null,
      },
      { apps },
    );
    expectPrivateBeforeContent();
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toMatchObject({ app: "contacts", version: "1.0.0" });
    if (process.platform === "win32") expect(await checkAccountOnly(file)).toEqual({ ok: true, others: [], inherits: false });
    expect((await fs.readdir(apps)).filter((name) => name.endsWith(".partial"))).toEqual([]);
  });

  it("sets the access list of the token file while the file is still empty, then writes the token", async () => {
    const file = path.join(dir, "token");
    await writeTokenFile(file, "a-test-token-value");
    expectPrivateBeforeContent();
    expect(await fs.readFile(file, "utf8")).toBe("a-test-token-value");
    if (process.platform === "win32") expect(await checkAccountOnly(file)).toEqual({ ok: true, others: [], inherits: false });
  });
});

describe("currentAccount", () => {
  it.runIf(process.platform === "win32")("finds an account of this computer also without COMPUTERNAME", async () => {
    const real = await (await import("../src/account-acl.js")).currentAccount();
    const saved = process.env.COMPUTERNAME;
    delete process.env.COMPUTERNAME;
    try {
      vi.resetModules();
      const fresh = await vi.importActual<typeof import("../src/account-acl.js")>("../src/account-acl.js");
      expect(await fresh.currentAccount()).toEqual(real);
    } finally {
      process.env.COMPUTERNAME = saved;
    }
  });
});
