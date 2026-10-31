import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  PUBLISH_SET_ORDER,
  RELEASE_PACKAGES,
  SET_PREPARE,
  SET_VERIFY,
  finalizePublishPlan,
  inspectRetryContents,
  parseSetPublishTag,
  readPublishedVersions,
  readPublishedVersionsForPlan,
  readRegistryPackage,
  registryPackageUrl,
  resolvePublishTag,
} from "../../scripts/publish-packages.mjs";
import { resolvePublishPlan } from "../../scripts/resolve-publish-tag.mjs";
import { allowlistedEntry, expectedCommand } from "../../scripts/run-publish-plan.mjs";
import { packagesToCheck } from "../../scripts/verify-installed-packages.mjs";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

function readVersion(relativePath) {
  return JSON.parse(readFileSync(path.join(repoRoot, relativePath), "utf8")).version;
}

const setVersion = readVersion("package.json");

function publishedExcept(resolved, unpublishedKeys) {
  return new Map(resolved.packages.map(entry => [
    entry.packageName,
    unpublishedKeys.includes(entry.packageKey) ? [] : [entry.version],
  ]));
}

describe("publish tag resolution", () => {
  it("maps a set tag to every package in release order with the set commands", async () => {
    const plan = await resolvePublishTag(`publish-set-v${setVersion}`, repoRoot);
    assert.equal(plan.mode, "set");
    assert.equal(plan.setVersion, setVersion);
    assert.equal(plan.retry, null);
    assert.deepEqual(plan.packages.map(entry => entry.packageKey), PUBLISH_SET_ORDER);
    assert.equal(plan.packages[0].packageName, "@tjalve/memex-sqlite");
    assert.ok(PUBLISH_SET_ORDER.indexOf("memex-sqlite") < PUBLISH_SET_ORDER.indexOf("memex-schema"));
    assert.ok(PUBLISH_SET_ORDER.indexOf("memex-schema") < PUBLISH_SET_ORDER.indexOf("memex-facts"));
    assert.ok(PUBLISH_SET_ORDER.indexOf("memex-storage") < PUBLISH_SET_ORDER.indexOf("memex-desktop"));
    assert.ok(PUBLISH_SET_ORDER.indexOf("memex-node-client") < PUBLISH_SET_ORDER.indexOf("memex-user-client"));
    assert.equal(plan.prepare, SET_PREPARE);
    assert.equal(plan.verify, SET_VERIFY);
    for (const entry of plan.packages) {
      assert.equal(entry.version, readVersion(entry.packageJson));
    }
  });

  it("maps the emergency single-package tag to one package and its own commands", async () => {
    const version = readVersion("packages/node-client/package.json");
    const plan = await resolvePublishTag(`publish-memex-node-client-v${version}`, repoRoot);
    assert.equal(plan.mode, "package");
    assert.equal(plan.packages.length, 1);
    assert.deepEqual({
      packageKey: plan.packages[0].packageKey,
      packageName: plan.packages[0].packageName,
      path: plan.packages[0].path,
    }, {
      packageKey: "memex-node-client",
      packageName: "@tjalve/memex-node-client",
      path: "packages/node-client",
    });
    assert.equal(plan.prepare, "pnpm --filter @tjalve/memex-node-client... run build");
    assert.match(plan.verify, /pnpm --filter @tjalve\/memex-node-client run typecheck/);
    assert.match(plan.verify, /check-release-manifests/);
  });

  it("rejects unknown, mismatched and malformed tags before anything is staged", async () => {
    await assert.rejects(() => resolvePublishTag("publish-missing-v1.2.3", repoRoot), /Unknown package key/);
    await assert.rejects(() => resolvePublishTag("publish-memex-sqlite-v9.9.9", repoRoot), /does not match/);
    await assert.rejects(() => resolvePublishTag("publish-set-v0.0.0-not-the-set", repoRoot), /does not match the set version/);
    await assert.rejects(() => resolvePublishTag("publish-set-vx", repoRoot), { reasonCode: "publish-tag" });
    await assert.rejects(() => resolvePublishTag("v1.0.0", repoRoot), /Invalid publish tag/);
  });

  it("does not confuse a semver prerelease with a retry suffix", () => {
    assert.deepEqual(parseSetPublishTag("publish-set-v1.2.3-retry.1", "1.2.3-retry.1"), {
      setVersion: "1.2.3-retry.1",
      retry: null,
      originalTag: "publish-set-v1.2.3-retry.1",
    });
    assert.deepEqual(parseSetPublishTag("publish-set-v1.2.3-retry.2", "1.2.3"), {
      setVersion: "1.2.3",
      retry: 2,
      originalTag: "publish-set-v1.2.3",
    });
    assert.equal(parseSetPublishTag("publish-set-v1.2.3-retry.0", "1.2.3"), null);
  });

  it("keeps the staging allowlist bound to the catalog", async () => {
    const plan = await resolvePublishTag(`publish-set-v${setVersion}`, repoRoot);
    assert.equal(expectedCommand(plan, "prepare"), SET_PREPARE);
    assert.equal(expectedCommand(plan, "verify"), SET_VERIFY);
    assert.equal(allowlistedEntry(plan.packages[0]).filter, "@tjalve/memex-sqlite");
    assert.throws(() => allowlistedEntry({ ...plan.packages[0], path: "packages/storage" }), { reasonCode: "plan" });
    assert.throws(() => allowlistedEntry({ ...plan.packages[0], packageKey: "memex-unknown" }), { reasonCode: "plan" });
  });
});

describe("installed check plan", () => {
  it("checks every package of the set with the catalog's imports and commands", async () => {
    const resolved = await resolvePublishTag(`publish-set-v${setVersion}`, repoRoot);
    const plan = finalizePublishPlan(resolved, publishedExcept(resolved, ["memex-desktop"]));
    const checked = packagesToCheck(plan);
    assert.equal(checked.length, RELEASE_PACKAGES.length);
    const desktop = checked.find(entry => entry.packageKey === "memex-desktop");
    assert.deepEqual(desktop.imports, ["./server", "./build"]);
    assert.deepEqual(desktop.commands, ["memex-desktop"]);
    assert.throws(() => packagesToCheck({ packages: [{ ...plan.packages[0], packageName: "@tjalve/other" }] }), { reasonCode: "plan" });
    assert.throws(() => packagesToCheck({ packages: [] }), { reasonCode: "plan" });
  });
});

describe("publish set finalization", () => {
  it("stages only unpublished versions and keeps the full set for the installed check", async () => {
    const resolved = await resolvePublishTag(`publish-set-v${setVersion}`, repoRoot);
    const plan = finalizePublishPlan(resolved, publishedExcept(resolved, ["memex-schema", "memex-facts"]));
    assert.deepEqual(plan.packages.map(entry => entry.packageKey), ["memex-schema", "memex-facts"]);
    assert.equal(plan.verifyPackages.length, RELEASE_PACKAGES.length);
    assert.equal(plan.skipped.length, RELEASE_PACKAGES.length - 2);
    assert.equal(plan.skipped.every(entry => entry.skipReason === "already-published"), true);
  });

  it("fails when the set has nothing to publish and when a single package is already public", async () => {
    const resolved = await resolvePublishTag(`publish-set-v${setVersion}`, repoRoot);
    assert.throws(() => finalizePublishPlan(resolved, publishedExcept(resolved, [])), { reasonCode: "nothing-to-publish" });
    const single = await resolvePublishTag(`publish-memex-sqlite-v${readVersion("packages/sqlite/package.json")}`, repoRoot);
    assert.throws(
      () => finalizePublishPlan(single, new Map([["@tjalve/memex-sqlite", [single.packages[0].version]]])),
      { reasonCode: "already-published" },
    );
  });

  it("treats a missing registry package as absent and fails closed on registry errors", async () => {
    assert.deepEqual(await readPublishedVersions("@tjalve/missing", { fetch: async () => ({ status: 404, ok: false }) }), []);
    assert.equal((await readRegistryPackage("@tjalve/missing", { fetch: async () => ({ status: 404, ok: false }) })).exists, false);
    await assert.rejects(
      () => readPublishedVersions("@tjalve/memex-sqlite", { fetch: async () => ({ status: 500, ok: false }) }),
      { reasonCode: "registry-lookup" },
    );
    await assert.rejects(
      () => readPublishedVersions("@tjalve/memex-sqlite", { fetch: async () => { throw new Error("offline"); } }),
      { reasonCode: "registry-lookup" },
    );
    assert.equal(registryPackageUrl("@tjalve/memex-sqlite"), "https://registry.npmjs.org/@tjalve%2fmemex-sqlite");
  });

  it("reads registry packages concurrently and once per name", async () => {
    let calls = 0;
    const versions = await readPublishedVersionsForPlan({
      packages: [
        { packageName: "@tjalve/one" },
        { packageName: "@tjalve/two" },
        { packageName: "@tjalve/one" },
      ],
    }, {
      fetch: async () => {
        calls += 1;
        return { ok: true, status: 200, json: async () => ({ versions: { "1.0.0": {} } }) };
      },
    });
    assert.equal(calls, 2);
    assert.deepEqual(versions.get("@tjalve/one"), ["1.0.0"]);
  });

  it("rejects publishable input changes on a retry", async () => {
    const resolved = await resolvePublishTag(`publish-set-v${setVersion}-retry.1`, repoRoot);
    assert.throws(() => inspectRetryContents(resolved, "original-sha", repoRoot, {
      run() { throw new Error("changed"); },
    }), { reasonCode: "retry-content-drift" });
  });
});

describe("publish plan in the workflow", () => {
  it("refuses a set whose names are not on npm yet", async () => {
    const tag = `publish-set-v${setVersion}`;
    const resolved = await resolvePublishTag(tag, repoRoot);
    await assert.rejects(
      () => resolvePublishPlan(tag, {
        root: repoRoot,
        publishedByName: publishedExcept(resolved, ["memex-desktop"]),
        missingPackageNames: ["@tjalve/memex-desktop"],
        prepareRelease: async () => ({ needsWrite: false }),
      }),
      error => error.reasonCode === "package-bootstrap" && /memex-desktop/.test(error.message),
    );
  });

  it("enforces the generated preparation even when a set tag is pushed by hand", async () => {
    const tag = `publish-set-v${setVersion}`;
    const resolved = await resolvePublishTag(tag, repoRoot);
    const publishedByName = publishedExcept(resolved, ["memex-desktop"]);
    let preparationOptions;
    const plan = await resolvePublishPlan(tag, {
      root: repoRoot,
      publishedByName,
      prepareRelease: async options => {
        preparationOptions = options;
        return { needsWrite: false };
      },
    });
    assert.deepEqual(plan.packages.map(entry => entry.packageKey), ["memex-desktop"]);
    assert.equal(preparationOptions.excludeBaselineTag, tag);
    assert.deepEqual(preparationOptions.setTagState, { status: "current", tag });
    await assert.rejects(
      () => resolvePublishPlan(tag, { root: repoRoot, publishedByName, prepareRelease: async () => ({ needsWrite: true }) }),
      { reasonCode: "release-unprepared" },
    );
  });

  it("creates a fresh partial plan for a valid retry tag without re-running preparation", async () => {
    const tag = `publish-set-v${setVersion}-retry.1`;
    const resolved = await resolvePublishTag(tag, repoRoot);
    let prepared = false;
    const gitCalls = [];
    const plan = await resolvePublishPlan(tag, {
      root: repoRoot,
      publishedByName: publishedExcept(resolved, ["memex-desktop"]),
      prepareRelease: async () => { prepared = true; return { needsWrite: false }; },
      git: {
        run(args) {
          gitCalls.push(args.join(" "));
          return args[0] === "rev-parse" ? "original-sha" : "";
        },
      },
    });
    assert.equal(prepared, false);
    assert.deepEqual(plan.packages.map(entry => entry.packageKey), ["memex-desktop"]);
    assert.ok(gitCalls.includes(`rev-parse publish-set-v${setVersion}^{commit}`));
    assert.ok(gitCalls.includes("merge-base --is-ancestor original-sha HEAD"));
    await assert.rejects(
      () => resolvePublishPlan(tag, {
        root: repoRoot,
        publishedByName: publishedExcept(resolved, PUBLISH_SET_ORDER),
        git: { run: args => args[0] === "rev-parse" ? "original-sha" : "" },
      }),
      { reasonCode: "retry-unnecessary" },
    );
  });

  it("stages a single package only when the packages it depends on are public at the exact version", async () => {
    const version = readVersion("packages/schema/package.json");
    const sqliteVersion = readVersion("packages/sqlite/package.json");
    const tag = `publish-memex-schema-v${version}`;
    await assert.rejects(
      () => resolvePublishPlan(tag, {
        root: repoRoot,
        publishedByName: new Map([["@tjalve/memex-schema", []], ["@tjalve/memex-sqlite", []]]),
      }),
      error => error.reasonCode === "dependency-unpublished" && error.message.includes(`@tjalve/memex-sqlite@${sqliteVersion}`),
    );
    const plan = await resolvePublishPlan(tag, {
      root: repoRoot,
      publishedByName: new Map([["@tjalve/memex-schema", []], ["@tjalve/memex-sqlite", [sqliteVersion]]]),
    });
    assert.equal(plan.mode, "package");
    assert.deepEqual(plan.packages.map(entry => `${entry.packageName}@${entry.version}`), [`@tjalve/memex-schema@${version}`]);
  });
});
