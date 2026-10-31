import assert from "node:assert/strict";
import { copyFileSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { collectPublishManifestFailures } from "../../scripts/check-publish-manifest.mjs";
import { collectReleaseManifestFailures } from "../../scripts/check-release-manifests.mjs";
import { RELEASE_PACKAGES } from "../../scripts/publish-packages.mjs";
import { resolvePublishDependencies } from "../../scripts/resolve-publish-dependencies.mjs";
import { restorePublishDependencies } from "../../scripts/restore-publish-dependencies.mjs";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

describe("publish manifest safety", () => {
  it("retries transient file-operation failures before reporting restore success", async () => {
    let accessAttempts = 0;
    let copyAttempts = 0;
    let unlinkAttempts = 0;
    const result = await restorePublishDependencies("fixture/package.json", {
      access: async () => {
        accessAttempts += 1;
        if (accessAttempts < 3) throw Object.assign(new Error("locked"), { code: "EPERM" });
      },
      copyFile: async () => {
        copyAttempts += 1;
        if (copyAttempts < 3) throw Object.assign(new Error("locked"), { code: "EPERM" });
      },
      unlink: async () => {
        unlinkAttempts += 1;
        if (unlinkAttempts < 2) throw Object.assign(new Error("busy"), { code: "EBUSY" });
      },
      attempts: 4,
      delayMs: 0,
      delay: async () => {},
    });
    assert.equal(result.restored, true);
    assert.equal(accessAttempts, 3);
    assert.equal(copyAttempts, 3);
    assert.equal(unlinkAttempts, 2);
  });

  it("treats only a missing backup as a successful no-op", async () => {
    let accessAttempts = 0;
    const result = await restorePublishDependencies("fixture/package.json", {
      access: async () => {
        accessAttempts += 1;
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      },
      attempts: 4,
      delayMs: 0,
      delay: async () => {},
    });
    assert.equal(result.restored, false);
    assert.equal(accessAttempts, 1);
  });

  for (const entry of RELEASE_PACKAGES) {
    it(`stages ${entry.name} with exact versions and restores the manifest byte for byte`, async () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "memex-manifest-"));
      const tempPath = path.join(tempDir, "package.json");
      try {
        copyFileSync(path.join(repoRoot, entry.packageJson), tempPath);
        const before = readFileSync(tempPath, "utf8");
        const source = JSON.parse(before);
        const usesWorkspace = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]
          .some(field => Object.values(source[field] ?? {}).some(version => String(version).startsWith("workspace:")));
        if (usesWorkspace) assert.notDeepEqual(collectPublishManifestFailures(source), []);

        const resolved = await resolvePublishDependencies(tempPath, { root: repoRoot });
        assert.equal(resolved.name, entry.name);
        const staged = JSON.parse(readFileSync(tempPath, "utf8"));
        assert.deepEqual(collectPublishManifestFailures(staged, entry.packageJson), []);
        for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
          for (const [name, version] of Object.entries(staged[field] ?? {})) {
            assert.ok(!String(version).startsWith("workspace:"), `${entry.name} ${field}.${name} keeps ${version}`);
          }
        }
        for (const dependency of resolved.resolved) {
          const target = RELEASE_PACKAGES.find(candidate => candidate.name === dependency.name);
          const version = JSON.parse(readFileSync(path.join(repoRoot, target.packageJson), "utf8")).version;
          assert.equal(staged[dependency.field][dependency.name], version);
        }

        await restorePublishDependencies(tempPath);
        assert.equal(readFileSync(tempPath, "utf8"), before);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  }

  it("requires exact dependency versions but allows a peer dependency range", () => {
    assert.deepEqual(collectPublishManifestFailures({
      dependencies: { zod: "4.6.6" },
      peerDependencies: { electron: ">=44.7.0" },
    }), []);
    assert.equal(collectPublishManifestFailures({ dependencies: { zod: "^4.6.6" } }).length, 1);
    assert.equal(collectPublishManifestFailures({ peerDependencies: { "@tjalve/memex-storage": "workspace:*" } }).length, 1);
    assert.equal(collectPublishManifestFailures({ devDependencies: { "@tjalve/memex-facts": "workspace:*" } }).length, 1);
    assert.deepEqual(collectPublishManifestFailures({ devDependencies: { typescript: "^6.0.0" } }), []);
  });
});

describe("release catalog", () => {
  it("matches the workspace of this repository", () => {
    assert.deepEqual(collectReleaseManifestFailures(repoRoot), []);
  });

  it("reports a public package missing from the catalog, a wrong order and a lifecycle script", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "memex-release-catalog-"));
    try {
      cpSync(path.join(repoRoot, "package.json"), path.join(root, "package.json"));
      cpSync(path.join(repoRoot, "pnpm-workspace.yaml"), path.join(root, "pnpm-workspace.yaml"));
      for (const entry of RELEASE_PACKAGES) {
        for (const file of ["package.json", "LICENSE", "README.md"]) {
          cpSync(path.join(repoRoot, entry.path, file), path.join(root, entry.path, file));
        }
      }
      const extraPath = path.join(root, "packages", "extra", "package.json");
      cpSync(path.join(repoRoot, "packages/handles/package.json"), extraPath);
      writeFileSync(extraPath, JSON.stringify({ name: "@tjalve/memex-extra", version: "0.1.0" }));
      const sqlitePath = path.join(root, "packages/sqlite/package.json");
      const sqlite = JSON.parse(readFileSync(sqlitePath, "utf8"));
      writeFileSync(sqlitePath, JSON.stringify({ ...sqlite, scripts: { ...sqlite.scripts, postinstall: "node x.js" } }));

      const swapped = [...RELEASE_PACKAGES];
      [swapped[0], swapped[1]] = [swapped[1], swapped[0]];
      const failures = collectReleaseManifestFailures(root, swapped);
      assert.ok(failures.some(line => line.includes("@tjalve/memex-extra") && line.includes("missing from the release catalog")), failures.join("\n"));
      assert.ok(failures.some(line => line.includes("@tjalve/memex-sqlite must come before @tjalve/memex-schema")), failures.join("\n"));
      assert.ok(failures.some(line => line.includes('lifecycle script "postinstall"')), failures.join("\n"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
