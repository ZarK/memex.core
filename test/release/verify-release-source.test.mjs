import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { verifyReleaseSource } from "../../scripts/verify-release-source.mjs";

const commitSha = "1".repeat(40);
const tagObjectSha = "2".repeat(40);
const tagName = "publish-set-v0.1.12";

function response(value, status = 200) {
  return { ok: status >= 200 && status < 300, status, async json() { return value; } };
}

function validResponses(overrides = {}) {
  const values = {
    ref: {
      ref: `refs/tags/${tagName}`,
      object: { type: "tag", sha: tagObjectSha },
    },
    tag: {
      sha: tagObjectSha,
      tag: tagName,
      object: { type: "commit", sha: commitSha },
      verification: { verified: true, reason: "valid" },
    },
    commit: {
      sha: commitSha,
      commit: { verification: { verified: true, reason: "valid" } },
    },
    ...overrides,
  };
  return async url => {
    if (url.includes("/git/ref/tags/")) return response(values.ref);
    if (url.includes("/git/tags/")) return response(values.tag);
    if (url.includes("/commits/")) return response(values.commit);
    return response({}, 404);
  };
}

function validGit(overrides = {}) {
  const commands = [];
  return {
    commands,
    run(args) {
      commands.push(args);
      if (args[0] === "rev-parse") return overrides.checkoutSha ?? commitSha;
      if (args[0] === "merge-base" && overrides.outsideMain) throw new Error("not an ancestor");
      return "";
    },
  };
}

function options(overrides = {}) {
  return {
    repository: "ZarK/memex.core",
    tagName,
    eventSha: commitSha,
    token: "test-token",
    root: "/repo",
    fetchImpl: validResponses(),
    git: validGit(),
    ...overrides,
  };
}

describe("signed release-source verification", () => {
  it("accepts a verified annotated tag for a verified main commit", async () => {
    const git = validGit();
    const result = await verifyReleaseSource(options({ git }));
    assert.equal(result.commitSha, commitSha);
    assert.equal(result.tagObjectSha, tagObjectSha);
    assert.deepEqual(git.commands, [
      ["rev-parse", "HEAD"],
      ["fetch", "--no-tags", "origin", "main"],
      ["merge-base", "--is-ancestor", commitSha, "origin/main"],
    ]);
  });

  it("rejects lightweight and unsigned tags", async () => {
    await assert.rejects(
      () => verifyReleaseSource(options({
        fetchImpl: validResponses({ ref: { ref: `refs/tags/${tagName}`, object: { type: "commit", sha: commitSha } } }),
      })),
      { reasonCode: "release-source-tag" },
    );
    await assert.rejects(
      () => verifyReleaseSource(options({
        fetchImpl: validResponses({
          tag: {
            sha: tagObjectSha,
            tag: tagName,
            object: { type: "commit", sha: commitSha },
            verification: { verified: false, reason: "unsigned" },
          },
        }),
      })),
      { reasonCode: "release-source-signature" },
    );
  });

  it("rejects unsigned commits and mismatched tag targets", async () => {
    await assert.rejects(
      () => verifyReleaseSource(options({
        fetchImpl: validResponses({
          commit: { sha: commitSha, commit: { verification: { verified: false, reason: "unsigned" } } },
        }),
      })),
      { reasonCode: "release-source-signature" },
    );
    await assert.rejects(
      () => verifyReleaseSource(options({ eventSha: "3".repeat(40) })),
      { reasonCode: "release-source-mismatch" },
    );
    await assert.rejects(
      () => verifyReleaseSource(options({ git: validGit({ checkoutSha: "4".repeat(40) }) })),
      { reasonCode: "release-source-mismatch" },
    );
  });

  it("rejects commits outside main and malformed GitHub responses", async () => {
    await assert.rejects(
      () => verifyReleaseSource(options({ git: validGit({ outsideMain: true }) })),
      { reasonCode: "release-source-branch" },
    );
    await assert.rejects(
      () => verifyReleaseSource(options({ fetchImpl: async () => response([], 200) })),
      { reasonCode: "release-source-api" },
    );
    await assert.rejects(
      () => verifyReleaseSource(options({ fetchImpl: async () => response({}, 503) })),
      { reasonCode: "release-source-api" },
    );
  });
});
