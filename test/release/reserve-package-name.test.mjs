import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  RESERVE_TAG,
  RESERVE_VERSION,
  inspectRunner,
  parseReserveArgs,
  placeholderManifest,
  reservePackageName,
} from "../../scripts/reserve-package-name.mjs";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const interactive = { stdin: true, stdout: true };
const absent = async () => ({ status: 404, ok: false });

function fakeNpm(overrides = {}) {
  const calls = [];
  const npm = (args, options = {}) => {
    calls.push({ args, cwd: options.cwd, inherit: options.inherit === true });
    if (args[0] === "whoami") return overrides.whoami ?? "owner-login\n";
    if (args[0] === "access") return JSON.stringify(overrides.owned ?? {});
    if (args[0] === "pack") {
      const files = overrides.files ?? readdirSync(options.cwd).map(file => ({ path: file }));
      return JSON.stringify([{ files }]);
    }
    return "";
  };
  return { npm, calls };
}

function run(overrides = {}) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "memex-reserve-test-"));
  const lines = [];
  const fake = overrides.fake ?? fakeNpm();
  const promise = reservePackageName({
    key: "memex-sqlite",
    env: {},
    terminal: interactive,
    fetch: absent,
    prompt: async () => "@tjalve/memex-sqlite",
    root: repoRoot,
    tmpdir: tmp,
    attempts: 1,
    delay: async () => {},
    log: line => lines.push(line),
    npm: fake.npm,
    ...overrides,
  });
  return { promise, lines, calls: fake.calls, tmp };
}

describe("first publish of a new package name", () => {
  it("refuses to run in CI or without an interactive terminal", () => {
    assert.throws(() => inspectRunner({ CI: "true" }, interactive), { reasonCode: "ci-refused" });
    assert.throws(() => inspectRunner({ GITHUB_ACTIONS: "true" }, interactive), { reasonCode: "ci-refused" });
    assert.throws(() => inspectRunner({ RUNNER_OS: "Linux" }, interactive), { reasonCode: "ci-refused" });
    assert.throws(() => inspectRunner({}, { stdin: false, stdout: true }), { reasonCode: "not-interactive" });
    assert.doesNotThrow(() => inspectRunner({ CI: "false" }, interactive));
  });

  it("refuses in CI before it reads the registry or calls npm", async () => {
    let fetched = false;
    const { promise, calls, tmp } = run({ env: { CI: "1" }, fetch: async () => { fetched = true; return { status: 404, ok: false }; } });
    try {
      await assert.rejects(promise, { reasonCode: "ci-refused" });
      assert.equal(fetched, false);
      assert.deepEqual(calls, []);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("publishes a three-file placeholder under the reserve tag after the owner confirms", async () => {
    const { promise, lines, calls, tmp } = run({ fetch: (() => {
      let lookups = 0;
      return async () => (++lookups === 1 ? { status: 404, ok: false } : { status: 200, ok: true, json: async () => ({ versions: { [RESERVE_VERSION]: {} } }) });
    })() });
    try {
      const result = await promise;
      assert.equal(result.published, true);
      assert.equal(result.visible, true);
      assert.deepEqual(readdirSync(result.folder).sort(), ["LICENSE", "README.md", "package.json"]);
      const manifest = JSON.parse(readFileSync(path.join(result.folder, "package.json"), "utf8"));
      assert.deepEqual(manifest, placeholderManifest({ name: "@tjalve/memex-sqlite", path: "packages/sqlite" }));
      assert.equal(manifest.version, RESERVE_VERSION);
      assert.equal(manifest.scripts, undefined);
      assert.equal(readFileSync(path.join(result.folder, "LICENSE"), "utf8"), readFileSync(path.join(repoRoot, "LICENSE"), "utf8"));
      const publish = calls.find(call => call.args[0] === "publish");
      assert.deepEqual(publish.args, ["publish", result.folder, "--access", "public", "--tag", RESERVE_TAG, "--ignore-scripts"]);
      assert.equal(publish.inherit, true);
      for (let step = 1; step <= 8; step += 1) {
        assert.ok(lines.some(line => line.startsWith(`Step ${step} of 8:`)), `step ${step}`);
      }
      assert.ok(lines.some(line => line.includes("Allowed action: npm stage publish only")));
      assert.ok(lines.some(line => line.includes("logged in as owner-login")));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("passes the two-factor code only when given and never prints it", async () => {
    const { promise, lines, calls, tmp } = run({ otp: "123456" });
    try {
      await promise;
      const publish = calls.find(call => call.args[0] === "publish");
      assert.deepEqual(publish.args.slice(-2), ["--otp", "123456"]);
      assert.equal(lines.some(line => line.includes("123456")), false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("treats a name already in the account as reserved while the public registry lags", async () => {
    const lagging = run({ fake: fakeNpm({ owned: { "@tjalve/memex-sqlite": "read-write" } }) });
    try {
      const result = await lagging.promise;
      assert.equal(result.published, false);
      assert.equal(result.reason, "exists");
      assert.equal(lagging.calls.some(call => call.args[0] === "publish"), false);
    } finally {
      rmSync(lagging.tmp, { recursive: true, force: true });
    }
  });

  it("does not wait for the registry with --no-wait", async () => {
    let fetches = 0;
    const counting = async () => { fetches += 1; return { status: 404, ok: false }; };
    const quick = run({ yes: true, noWait: true, fetch: counting });
    try {
      const result = await quick.promise;
      assert.equal(result.published, true);
      assert.equal(result.visible, undefined);
      assert.equal(fetches, 1);
    } finally {
      rmSync(quick.tmp, { recursive: true, force: true });
    }
  });

  it("publishes without the typed confirmation when --yes is given", async () => {
    let prompted = false;
    const yes = run({ yes: true, prompt: async () => { prompted = true; return ""; } });
    try {
      await yes.promise;
      assert.equal(prompted, false);
      assert.ok(yes.calls.some(call => call.args[0] === "publish" && !call.args.includes("--dry-run")));
    } finally {
      rmSync(yes.tmp, { recursive: true, force: true });
    }
  });

  it("publishes nothing when the owner does not confirm, when the name exists, or in a dry run", async () => {
    const cancelled = run({ prompt: async () => "no" });
    try {
      await assert.rejects(cancelled.promise, { reasonCode: "cancelled" });
      assert.equal(cancelled.calls.some(call => call.args[0] === "publish"), false);
    } finally {
      rmSync(cancelled.tmp, { recursive: true, force: true });
    }

    const exists = run({ fetch: async () => ({ status: 200, ok: true, json: async () => ({ versions: { "0.1.0": {} } }) }) });
    try {
      const result = await exists.promise;
      assert.equal(result.published, false);
      assert.equal(result.reason, "exists");
      assert.deepEqual(exists.calls, []);
    } finally {
      rmSync(exists.tmp, { recursive: true, force: true });
    }

    let prompted = false;
    const dry = run({ dryRun: true, prompt: async () => { prompted = true; return ""; } });
    try {
      const result = await dry.promise;
      assert.equal(result.reason, "dry-run");
      assert.equal(prompted, false);
      assert.ok(dry.calls.find(call => call.args[0] === "publish").args.includes("--dry-run"));
    } finally {
      rmSync(dry.tmp, { recursive: true, force: true });
    }
  });

  it("stops when npm would publish anything other than the three files or when there is no login", async () => {
    const extra = run({ fake: fakeNpm({ files: [{ path: "LICENSE" }, { path: "README.md" }, { path: "package.json" }, { path: "index.js" }] }) });
    try {
      await assert.rejects(extra.promise, { reasonCode: "placeholder-contents" });
      assert.equal(extra.calls.some(call => call.args[0] === "publish"), false);
    } finally {
      rmSync(extra.tmp, { recursive: true, force: true });
    }
    const noLogin = run({ fake: fakeNpm({ whoami: "" }) });
    try {
      await assert.rejects(noLogin.promise, { reasonCode: "npm-login" });
    } finally {
      rmSync(noLogin.tmp, { recursive: true, force: true });
    }
  });

  it("accepts one known package and a well-formed code", async () => {
    assert.deepEqual(parseReserveArgs(["memex-schema", "--otp", "654321"]), { key: "memex-schema", otp: "654321", dryRun: false, yes: false, noWait: false, help: false });
    assert.equal(parseReserveArgs(["memex-schema", "--yes"]).yes, true);
    assert.equal(parseReserveArgs(["-y", "memex-schema"]).yes, true);
    assert.throws(() => parseReserveArgs([]), { reasonCode: "usage" });
    assert.throws(() => parseReserveArgs(["memex-schema", "--otp", "abc"]), { reasonCode: "usage" });
    assert.throws(() => parseReserveArgs(["memex-schema", "memex-sqlite"]), { reasonCode: "usage" });
    const unknown = run({ key: "memex-unknown" });
    try {
      await assert.rejects(unknown.promise, { reasonCode: "unknown-package" });
    } finally {
      rmSync(unknown.tmp, { recursive: true, force: true });
    }
  });
});
