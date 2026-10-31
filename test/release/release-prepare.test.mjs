import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { PUBLISH_PACKAGES, PUBLISH_SET_ORDER } from "../../scripts/publish-packages.mjs";
import {
  applyReleasePreparation,
  bumpPatch,
  compareVersions,
  inspectSetTag,
  parseChangedPaths,
  planReleasePreparation,
  prepareRelease,
  readReleaseChanges,
  readWorkspaceManifestPaths,
  resolveReleaseBaseline,
} from "../../scripts/prepare-release.mjs";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const baseline = { baselineTag: "publish-set-v0.1.0", baselineSha: "a".repeat(40) };

function writeJson(root, relativePath, value) {
  const filePath = path.join(root, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

// A copy of the workspace manifests where every package is public at its current version.
function createFixture(options = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "memex-release-prepare-"));
  const publishedByName = new Map();
  for (const packageKey of PUBLISH_SET_ORDER) {
    const catalog = PUBLISH_PACKAGES.get(packageKey);
    const target = path.join(root, catalog.packageJson);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(path.join(repoRoot, catalog.packageJson), target);
    const manifest = JSON.parse(readFileSync(target, "utf8"));
    publishedByName.set(manifest.name, (options.unpublished ?? []).includes(packageKey) ? [] : [manifest.version]);
  }
  writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n  - packages/desktop/examples/*\n");
  writeJson(root, "package.json", { name: "memex-core", version: "0.1.0", private: true });
  writeJson(root, "packages/desktop/examples/hello/package.json", {
    name: "memex-desktop-hello",
    version: "0.1.0",
    private: true,
    dependencies: { "@tjalve/memex-desktop": "workspace:*", "@tjalve/memex-storage": "1.0.0" },
  });
  return { root, publishedByName };
}

function planFixture(fixture, changedPaths, options = {}) {
  return planReleasePreparation(fixture.root, {
    ...baseline,
    changedPaths,
    publishedByName: fixture.publishedByName,
    ...options,
  });
}

function report(plan, key) {
  return plan.reports.find(entry => entry.packageKey === key);
}

describe("release preparation", () => {
  it("reports a stable prepared workspace without writing files", () => {
    const fixture = createFixture();
    try {
      const sqlitePath = path.join(fixture.root, "packages/sqlite/package.json");
      const before = readFileSync(sqlitePath, "utf8");
      const plan = planFixture(fixture, []);
      assert.equal(plan.needsWrite, false);
      assert.deepEqual(plan.versionChanges, []);
      assert.deepEqual(plan.stageOrder, []);
      const applied = applyReleasePreparation(fixture.root, plan, {
        runner: () => { throw new Error("a stable preparation must not touch the lockfile"); },
      });
      assert.equal(applied.wrote, false);
      assert.equal(readFileSync(sqlitePath, "utf8"), before);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("keeps unpublished first versions and counts every package as changed before the first release", () => {
    const fixture = createFixture({ unpublished: PUBLISH_SET_ORDER });
    try {
      const changedPaths = readReleaseChanges(fixture.root, null);
      assert.equal(changedPaths.length, PUBLISH_SET_ORDER.length);
      const plan = planReleasePreparation(fixture.root, {
        baselineTag: null,
        baselineSha: null,
        changedPaths,
        publishedByName: fixture.publishedByName,
      });
      assert.equal(plan.needsWrite, false);
      assert.deepEqual(plan.versionChanges, []);
      assert.deepEqual(plan.stageOrder.map(entry => entry.packageKey), PUBLISH_SET_ORDER);
      assert.equal(plan.setTag, "publish-set-v0.1.0");
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("bumps a changed package once and every package that depends on it at run time", () => {
    const fixture = createFixture();
    try {
      const plan = planFixture(fixture, ["packages/sqlite/src/index.ts"]);
      const sqlite = report(plan, "memex-sqlite");
      assert.equal(sqlite.direct, true);
      assert.equal(sqlite.toVersion, bumpPatch(sqlite.fromVersion));
      for (const key of ["memex-schema", "memex-facts", "memex-import", "memex-user-client"]) {
        assert.equal(report(plan, key).propagated, true, key);
        assert.equal(report(plan, key).toVersion, bumpPatch(report(plan, key).fromVersion), key);
      }
      for (const key of ["memex-storage", "memex-archive", "memex-handles", "memex-desktop"]) {
        assert.equal(report(plan, key).toVersion, report(plan, key).fromVersion, key);
      }
      assert.deepEqual(plan.stageOrder.map(entry => entry.packageKey), [
        "memex-sqlite", "memex-schema", "memex-import", "memex-facts", "memex-user-client",
      ]);
      assert.equal(plan.needsWrite, true);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("does not release a package again for a change in a development dependency", () => {
    const fixture = createFixture();
    try {
      // memex-archive uses memex-storage only in its tests.
      const plan = planFixture(fixture, ["packages/storage/src/index.ts"]);
      assert.equal(report(plan, "memex-storage").toVersion, bumpPatch(report(plan, "memex-storage").fromVersion));
      assert.equal(report(plan, "memex-archive").propagated, false);
      assert.equal(report(plan, "memex-archive").toVersion, report(plan, "memex-archive").fromVersion);
      assert.equal(report(plan, "memex-desktop").propagated, true);
      assert.deepEqual(plan.workspaceChanges.map(change => change.packageJson), ["packages/desktop/examples/hello/package.json"]);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("advances the set version once when its tag is on an older commit and something is new", () => {
    const fixture = createFixture();
    try {
      const current = planFixture(fixture, ["packages/handles/src/index.ts"], {
        setTagState: { status: "current", tag: "publish-set-v0.1.0" },
      });
      assert.equal(current.setVersion, "0.1.0");
      assert.equal(current.setVersionChange, null);

      const occupied = planFixture(fixture, ["packages/handles/src/index.ts"], {
        setTagState: { status: "occupied", tag: "publish-set-v0.1.0" },
      });
      assert.equal(occupied.setTag, "publish-set-v0.1.1");
      assert.equal(occupied.replacesSetTag, "publish-set-v0.1.0");
      assert.deepEqual(occupied.setVersionChange, { from: "0.1.0", to: "0.1.1" });

      const nothingNew = planFixture(fixture, [], { setTagState: { status: "occupied", tag: "publish-set-v0.1.0" } });
      assert.equal(nothingNew.setVersionChange, null);
      assert.equal(nothingNew.needsWrite, false);

      assert.throws(() => planFixture(fixture, [], {
        setTagState: { status: "occupied", tag: "publish-set-v9.9.9" },
      }), { reasonCode: "set-tag-state" });
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("writes the manifests and the set version, then skips the lockfile update when asked", () => {
    const fixture = createFixture();
    try {
      const plan = planFixture(fixture, ["packages/sqlite/src/index.ts"], {
        setTagState: { status: "occupied", tag: "publish-set-v0.1.0" },
      });
      applyReleasePreparation(fixture.root, plan, { updateLockfile: false });
      const sqlite = JSON.parse(readFileSync(path.join(fixture.root, "packages/sqlite/package.json"), "utf8"));
      const schema = JSON.parse(readFileSync(path.join(fixture.root, "packages/schema/package.json"), "utf8"));
      const rootManifest = JSON.parse(readFileSync(path.join(fixture.root, "package.json"), "utf8"));
      assert.equal(sqlite.version, report(plan, "memex-sqlite").toVersion);
      assert.equal(schema.version, report(plan, "memex-schema").toVersion);
      assert.equal(schema.dependencies["@tjalve/memex-sqlite"], "workspace:*");
      assert.equal(rootManifest.version, "0.1.1");
      const again = planFixture(fixture, [], { setTagState: { status: "absent", tag: null } });
      assert.equal(again.needsWrite, false);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("ignores the name placeholder when it reads the latest public version", () => {
    const fixture = createFixture({ unpublished: PUBLISH_SET_ORDER });
    try {
      fixture.publishedByName.set("@tjalve/memex-sqlite", ["0.0.0-reserve"]);
      const plan = planFixture(fixture, ["packages/sqlite/src/index.ts"]);
      assert.equal(report(plan, "memex-sqlite").toVersion, report(plan, "memex-sqlite").fromVersion);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("fails closed for incomplete registry evidence and version drift", () => {
    const missing = createFixture();
    const drift = createFixture();
    try {
      missing.publishedByName.delete("@tjalve/memex-sqlite");
      assert.throws(() => planFixture(missing, ["packages/sqlite/src/index.ts"]), { reasonCode: "registry-lookup" });

      const sqlite = JSON.parse(readFileSync(path.join(drift.root, "packages/sqlite/package.json"), "utf8"));
      drift.publishedByName.set(sqlite.name, [sqlite.version, bumpPatch(sqlite.version)]);
      assert.throws(() => planFixture(drift, ["packages/sqlite/src/index.ts"]), { reasonCode: "registry-version-drift" });
    } finally {
      rmSync(missing.root, { recursive: true, force: true });
      rmSync(drift.root, { recursive: true, force: true });
    }
  });

  it("rolls every generated file back when the lockfile update fails", () => {
    const fixture = createFixture();
    try {
      writeFileSync(path.join(fixture.root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
      const tracked = ["packages/sqlite/package.json", "packages/schema/package.json", "package.json", "pnpm-lock.yaml"];
      const before = new Map(tracked.map(relativePath => [relativePath, readFileSync(path.join(fixture.root, relativePath))]));
      const plan = planFixture(fixture, ["packages/sqlite/src/index.ts"], {
        setTagState: { status: "occupied", tag: "publish-set-v0.1.0" },
      });
      let invocation;
      assert.throws(
        () => applyReleasePreparation(fixture.root, plan, {
          runner: (command, args) => {
            invocation = { command, args };
            return { status: 1 };
          },
        }),
        { reasonCode: "workspace-install" },
      );
      assert.ok(invocation.args.join(" ").includes("install --lockfile-only --ignore-scripts"));
      for (const [relativePath, contents] of before) {
        assert.deepEqual(readFileSync(path.join(fixture.root, relativePath)), contents, relativePath);
      }
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("reports a complete dry run without changing files", async () => {
    const fixture = createFixture();
    try {
      const sqlitePath = path.join(fixture.root, "packages/sqlite/package.json");
      const before = readFileSync(sqlitePath);
      const result = await prepareRelease({
        repoRoot: fixture.root,
        baseline,
        changedPaths: ["packages/sqlite/src/index.ts"],
        publishedByName: fixture.publishedByName,
        setTagState: { status: "absent", tag: null },
      });
      assert.equal(result.dryRun, true);
      assert.equal(result.baselineTag, "publish-set-v0.1.0");
      assert.ok(result.versionChanges.some(change => change.packageKey === "memex-sqlite"));
      assert.equal(result.reports, undefined);
      assert.deepEqual(readFileSync(sqlitePath), before);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("validates baseline tags, changed paths and semantic version order", () => {
    const git = {
      run(args) {
        if (args[0] === "tag") return "publish-set-v0.1.1-retry.1\npublish-set-v0.1.1\npublish-set-not-a-version\n";
        if (args[0] === "rev-list") return "b".repeat(40);
        return "";
      },
    };
    assert.deepEqual(resolveReleaseBaseline(repoRoot, git), { baselineTag: "publish-set-v0.1.1", baselineSha: "b".repeat(40) });
    assert.deepEqual(resolveReleaseBaseline(repoRoot, git, { excludeTag: "publish-set-v0.1.1" }), { baselineTag: null, baselineSha: null });
    assert.deepEqual(resolveReleaseBaseline(repoRoot, { run: () => "" }), { baselineTag: null, baselineSha: null });
    assert.throws(() => parseChangedPaths("../escape\0"), { reasonCode: "unsafe-changed-path" });
    assert.deepEqual(parseChangedPaths("packages/sqlite/src/a.ts\0README.md\0"), ["packages/sqlite/src/a.ts", "README.md"]);
    assert.equal(compareVersions("0.2.8-rc.1", "0.2.8"), -1);
    assert.equal(compareVersions("0.2.10", "0.2.9"), 1);
    assert.equal(compareVersions("1.0.0-B", "1.0.0-a"), -1);
  });

  it("reads the workspace package list of this repository", () => {
    const manifests = readWorkspaceManifestPaths(repoRoot);
    for (const packageKey of PUBLISH_SET_ORDER) {
      assert.ok(manifests.includes(PUBLISH_PACKAGES.get(packageKey).packageJson), packageKey);
    }
    assert.ok(manifests.includes("packages/desktop/examples/hello/package.json"));
  });

  it("distinguishes absent, current, occupied, conflicting and unreadable set tags", () => {
    const head = "a".repeat(40);
    const older = "b".repeat(40);
    const tagObject = "c".repeat(40);
    const tag = "publish-set-v0.1.9";
    const inspect = overrides => inspectSetTag(repoRoot, "0.1.9", {
      run(args) {
        if (args[0] === "rev-parse" && args[1] !== "--verify") return head;
        if (args[0] === "rev-parse" && args[1] === "--verify") {
          if (args[2] === `${tag}^{commit}`) return overrides.localSha ?? head;
          return overrides.remotePeeled ?? overrides.remoteDirect ?? head;
        }
        if (args[0] === "tag") return overrides.localName ?? "";
        if (args[0] === "ls-remote") return overrides.remote ?? "";
        return "";
      },
    });
    assert.equal(inspect({}).status, "absent");
    assert.equal(inspect({
      localName: tag,
      localSha: head,
      remote: `${tagObject}\trefs/tags/${tag}\n${head}\trefs/tags/${tag}^{}\n`,
      remotePeeled: head,
    }).status, "current");
    assert.equal(inspect({ remote: `${older}\trefs/tags/${tag}\n`, remoteDirect: older }).status, "occupied");
    assert.throws(() => inspect({
      localName: tag,
      localSha: head,
      remote: `${older}\trefs/tags/${tag}\n`,
      remoteDirect: older,
    }), { reasonCode: "set-tag-conflict" });
    assert.throws(() => inspectSetTag(repoRoot, "0.1.9", { run() { throw new Error("unreadable"); } }), { reasonCode: "set-tag-state" });
  });
});
