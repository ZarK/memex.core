import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { RELEASE_PACKAGES } from "../../scripts/publish-packages.mjs";
import { formatRelease, inspectReleaseCheckout, parseReleaseArgs, planRelease, planRetryTag, runRelease } from "../../scripts/release-set.mjs";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const setVersion = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")).version;
const prepared = Object.freeze({ needsWrite: false, baselineTag: "publish-set-v0.0.9" });

function publishedMap(unpublishedKeys = ["memex-desktop"]) {
  return new Map(RELEASE_PACKAGES.map(entry => {
    const version = JSON.parse(readFileSync(path.join(repoRoot, entry.packageJson), "utf8")).version;
    return [entry.name, unpublishedKeys.includes(entry.key) ? [] : [version]];
  }));
}

describe("release set", () => {
  it("prints the set tag and the unpublished packages in order without pushing", async () => {
    const report = await runRelease({ repoRoot, dryRun: true, publishedByName: publishedMap(["memex-sqlite", "memex-desktop"]), preparation: prepared });
    assert.equal(report.ok, true);
    assert.equal(report.dryRun, true);
    assert.equal(report.pushed, false);
    assert.equal(report.tag, `publish-set-v${setVersion}`);
    assert.deepEqual(report.packages.map(entry => entry.packageName), ["@tjalve/memex-sqlite", "@tjalve/memex-desktop"]);
    assert.match(formatRelease(report), /dry-run: tag not created, nothing pushed/);
  });

  it("lists brand-new names in a dry run and refuses them in a real release", async () => {
    const options = {
      repoRoot,
      publishedByName: publishedMap(["memex-desktop"]),
      missingPackageNames: ["@tjalve/memex-desktop"],
      preparation: prepared,
    };
    const dry = await runRelease({ ...options, dryRun: true });
    assert.equal(dry.ok, false);
    assert.deepEqual(dry.missingNames.map(entry => entry.packageName), ["@tjalve/memex-desktop"]);
    assert.match(formatRelease(dry), /reserve-package-name\.mjs/);
    await assert.rejects(
      () => planRelease(options),
      error => error.reasonCode === "package-bootstrap" && /memex-desktop/.test(error.message) && /first publish/.test(error.message),
    );
  });

  it("fails when every workspace version is already on npm", async () => {
    await assert.rejects(() => planRelease({ repoRoot, publishedByName: publishedMap([]), preparation: prepared }), { reasonCode: "nothing-to-publish" });
  });

  it("refuses an incomplete generated release preparation", async () => {
    await assert.rejects(
      () => planRelease({ repoRoot, publishedByName: publishedMap(), preparation: { needsWrite: true, baselineTag: null } }),
      { reasonCode: "release-unprepared" },
    );
  });

  it("selects a new immutable retry tag after the original set tag", () => {
    const originalTag = `publish-set-v${setVersion}`;
    const git = {
      run(args) {
        if (args[0] === "ls-remote" && args.at(-1) === `refs/tags/${originalTag}^{}`) {
          return `tag-object\trefs/tags/${originalTag}\nbase-sha\trefs/tags/${originalTag}^{}`;
        }
        if (args[0] === "tag" && args[2] === originalTag) return originalTag;
        if (args[0] === "rev-parse") return "base-sha";
        if (args[0] === "merge-base") return "";
        if (args[0] === "tag") return `${originalTag}-retry.1`;
        if (args[0] === "ls-remote") return `retry-object\trefs/tags/${originalTag}-retry.2`;
        return "";
      },
    };
    assert.deepEqual(planRetryTag(repoRoot, setVersion, git), {
      originalTag,
      originalCommit: "base-sha",
      retry: 3,
      tag: `${originalTag}-retry.3`,
    });
  });

  it("plans only unpublished versions for a partial set retry", async () => {
    const originalTag = `publish-set-v${setVersion}`;
    const git = {
      run(args) {
        if (args[0] === "ls-remote" && args.at(-1) === `refs/tags/${originalTag}^{}`) return `base-sha\trefs/tags/${originalTag}`;
        return "";
      },
    };
    const report = await planRelease({ repoRoot, retry: true, publishedByName: publishedMap(["memex-desktop"]), git });
    assert.equal(report.tag, `${originalTag}-retry.1`);
    assert.deepEqual(report.packages.map(entry => entry.packageName), ["@tjalve/memex-desktop"]);
    assert.equal(report.skipped.length, RELEASE_PACKAGES.length - 1);
  });

  it("refuses to tag from a dirty, stale or non-main checkout", () => {
    const answers = overrides => ({
      run(args) {
        if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return overrides.branch ?? "main";
        if (args[0] === "status") return overrides.status ?? "";
        if (args[0] === "rev-parse" && args[1] === "origin/main") return overrides.originMain ?? "abc";
        return "abc";
      },
    });
    assert.throws(() => inspectReleaseCheckout(repoRoot, answers({ branch: "w1/feature" })), { reasonCode: "not-main" });
    assert.throws(() => inspectReleaseCheckout(repoRoot, answers({ status: " M package.json" })), { reasonCode: "dirty-worktree" });
    assert.throws(() => inspectReleaseCheckout(repoRoot, answers({ status: "?? scratch.txt" })), { reasonCode: "dirty-worktree" });
    assert.throws(() => inspectReleaseCheckout(repoRoot, answers({ originMain: "def" })), { reasonCode: "main-stale" });
  });

  it("creates a signed annotated set tag and pushes only that tag from a clean current main", async () => {
    const commands = [];
    const git = {
      run(args) {
        commands.push(args.join(" "));
        if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return "main";
        if (args[0] === "status") return "";
        if (args[0] === "rev-parse") return "same-sha";
        if (args[0] === "tag" && args[1] === "--list") return "";
        return "";
      },
    };
    const report = await runRelease({ repoRoot, publishedByName: publishedMap(), preparation: prepared, git });
    assert.equal(report.pushed, true);
    assert.ok(commands.includes(`tag -s publish-set-v${setVersion} -m Publish set ${setVersion}`));
    assert.ok(commands.includes(`push origin publish-set-v${setVersion}`));
    assert.equal(commands.filter(line => line.startsWith("push")).length, 1);
  });

  it("refuses to move an existing set tag to another commit", async () => {
    const git = {
      run(args) {
        if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return "main";
        if (args[0] === "status") return "";
        if (args[0] === "rev-parse" && args[1]?.endsWith("^{}")) return "other-sha";
        if (args[0] === "rev-parse") return "same-sha";
        if (args[0] === "tag" && args[1] === "--list") return args[2];
        return "";
      },
    };
    await assert.rejects(() => runRelease({ repoRoot, publishedByName: publishedMap(), preparation: prepared, git }), { reasonCode: "tag-mismatch" });
  });

  it("parses the options and rejects unknown flags", () => {
    assert.deepEqual(parseReleaseArgs(["--retry", "--dry-run", "--json"]), {
      help: false,
      json: true,
      dryRun: true,
      retry: true,
      repoRoot: undefined,
    });
    assert.equal(parseReleaseArgs(["--", "--dry-run"]).dryRun, true);
    assert.throws(() => parseReleaseArgs(["--explode"]), { reasonCode: "usage" });
  });
});
