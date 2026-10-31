import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  approvePackages,
  commandError,
  npmStageCommand,
  prepareApproval,
  readPublishedShasums,
} from "../../scripts/approve-staged-release.mjs";
import {
  CHECKPOINT_MARKER,
  RECEIPT_MARKER,
  STAGE_INTENT_MARKER,
  createReceipt,
  encodeReceipt,
  findCompleteReceipt,
  findResumeReceipt,
  parseStageOutput,
  planApprovals,
  restoreReceiptAttempt,
  resumeReceipt,
  validateReceipt,
  writeStageIntent,
} from "../../scripts/release-receipt.mjs";

const headSha = "a".repeat(40);
const firstStage = "11111111-1111-4111-8111-111111111111";
const secondStage = "22222222-2222-4222-8222-222222222222";
const firstShasum = "1".repeat(40);
const secondShasum = "2".repeat(40);
const planned = [
  { packageKey: "memex-sqlite", packageName: "@tjalve/memex-sqlite", version: "0.2.1" },
  { packageKey: "memex-schema", packageName: "@tjalve/memex-schema", version: "0.4.1" },
];
const staged = [
  { ...planned[0], tag: "latest", stageId: firstStage, shasum: firstShasum },
  { ...planned[1], tag: "latest", stageId: secondStage, shasum: secondShasum },
];

function receipt(complete = true) {
  return createReceipt({
    repository: "ZarK/memex.core",
    tag: "publish-set-v0.1.7",
    headSha,
    runId: "99",
    runAttempt: "1",
  }, planned, staged, complete);
}

function stages() {
  return staged.map(entry => ({
    id: entry.stageId,
    packageName: entry.packageName,
    version: entry.version,
    tag: entry.tag,
    shasum: entry.shasum,
  }));
}

describe("staged release receipts", () => {
  it("parses npm stage JSON and rejects an untrusted result shape", () => {
    const output = JSON.stringify({
      "@tjalve/memex-schema": {
        name: "@tjalve/memex-schema",
        version: "0.4.1",
        stageId: secondStage,
        shasum: secondShasum,
      },
    });
    assert.deepEqual(parseStageOutput(output, planned[1]), staged[1]);
    assert.throws(() => parseStageOutput("{}", planned[1]), { reasonCode: "stage-output" });
    assert.throws(() => parseStageOutput("not-json", planned[1]), { reasonCode: "stage-output" });
  });

  it("extracts exactly one complete receipt from prefixed workflow logs", () => {
    const expected = receipt();
    const log = `publish\tStage\t2026-08-18 ${RECEIPT_MARKER}${encodeReceipt(expected)}\n`;
    assert.deepEqual(findCompleteReceipt(log), expected);
    assert.throws(() => findCompleteReceipt("no marker"), { reasonCode: "invalid-receipt" });
    assert.throws(() => findCompleteReceipt(`${log}${log}`), { reasonCode: "invalid-receipt" });
  });

  it("restores the latest confirmed cross-attempt checkpoint and detects an in-flight stage", () => {
    const context = {
      repository: "ZarK/memex.core",
      tag: "publish-set-v0.1.7",
      headSha,
      runId: "99",
      runAttempt: "1",
    };
    const empty = createReceipt(context, planned, [], false);
    const checkpoint = createReceipt(context, planned, staged.slice(0, 1), false);
    let intentLine = "";
    writeStageIntent(context, planned[0], { write(value) { intentLine += value; } });
    assert.match(intentLine, new RegExp(STAGE_INTENT_MARKER));

    const confirmedLog = [
      `${CHECKPOINT_MARKER}${encodeReceipt(empty)}`,
      intentLine.trim(),
      `${CHECKPOINT_MARKER}${encodeReceipt(checkpoint)}`,
    ].join("\n");
    assert.deepEqual(findResumeReceipt(confirmedLog), { receipt: checkpoint, pendingIntent: null });

    const interrupted = findResumeReceipt(`${CHECKPOINT_MARKER}${encodeReceipt(empty)}\n${intentLine}`);
    assert.deepEqual(interrupted.receipt, empty);
    assert.equal(interrupted.pendingIntent.packageName, planned[0].packageName);
  });

  it("rebinds a prior workflow checkpoint and fails closed on ambiguous retries", () => {
    const priorContext = {
      repository: "ZarK/memex.core",
      tag: "publish-set-v0.1.7",
      headSha,
      runId: "99",
      runAttempt: "1",
    };
    const retryContext = { ...priorContext, runAttempt: "2" };
    const checkpoint = createReceipt(priorContext, planned, staged.slice(0, 1), false);
    const restored = restoreReceiptAttempt({
      attempt: 1,
      headSha,
      stageConclusion: "failure",
      log: `${CHECKPOINT_MARKER}${encodeReceipt(checkpoint)}`,
    }, retryContext, planned);
    assert.equal(restored.runAttempt, "2");
    assert.deepEqual(restored.packages, staged.slice(0, 1));

    let intentLine = "";
    writeStageIntent(priorContext, planned[1], { write(value) { intentLine += value; } });
    assert.throws(() => restoreReceiptAttempt({
      attempt: 1,
      headSha,
      stageConclusion: "failure",
      log: `${CHECKPOINT_MARKER}${encodeReceipt(checkpoint)}\n${intentLine}`,
    }, retryContext, planned), { reasonCode: "invalid-receipt" });
    assert.equal(restoreReceiptAttempt({
      attempt: 1,
      headSha,
      stageConclusion: "skipped",
      log: "",
    }, retryContext, planned), null);
    assert.throws(() => restoreReceiptAttempt({
      attempt: 1,
      headSha,
      stageConclusion: "failure",
      log: "",
    }, retryContext, planned), { reasonCode: "invalid-receipt" });
  });

  it("requires a complete, ordered, unique receipt bound to its run", () => {
    const valid = receipt();
    assert.equal(validateReceipt(valid, {
      repository: "ZarK/memex.core",
      tag: "publish-set-v0.1.7",
      headSha,
      runId: 99,
    }), valid);
    assert.throws(() => validateReceipt(receipt(false)), { reasonCode: "invalid-receipt" });

    const reordered = structuredClone(valid);
    reordered.packages.reverse();
    assert.throws(() => validateReceipt(reordered), { reasonCode: "invalid-receipt" });

    const duplicate = structuredClone(valid);
    duplicate.packages[1].stageId = duplicate.packages[0].stageId;
    assert.throws(() => validateReceipt(duplicate), { reasonCode: "invalid-receipt" });
    const { runAttempt: _runAttempt, ...missingAttempt } = structuredClone(valid);
    assert.throws(() => validateReceipt(missingAttempt), { reasonCode: "invalid-receipt" });
    assert.throws(() => validateReceipt(valid, { headSha: "b".repeat(40) }), { reasonCode: "invalid-receipt" });
  });

  it("resumes a partial approval without restaging already-public packages", () => {
    const published = new Map([
      ["@tjalve/memex-sqlite", new Map([["0.2.1", firstShasum]])],
      ["@tjalve/memex-schema", new Map()],
    ]);
    const actions = planApprovals(receipt(), stages(), published);
    assert.deepEqual(actions.map(entry => entry.action), ["skip-published", "approve"]);
    assert.deepEqual(actions.map(entry => entry.packageKey), ["memex-sqlite", "memex-schema"]);
    const calls = [];
    const output = { write() {} };
    assert.equal(approvePackages(actions, args => calls.push(args), output), 1);
    assert.deepEqual(calls, [["stage", "approve", secondStage]]);
  });

  it("uses cmd on Windows and keeps POSIX npm invocation direct and unchanged", () => {
    assert.deepEqual(npmStageCommand(["stage", "list", "--json"], {
      platform: "win32",
      comspec: "system\\cmd.exe",
    }), {
      command: "system\\cmd.exe",
      args: ["/d", "/s", "/c", "npm.cmd", "stage", "list", "--json"],
    });
    assert.deepEqual(npmStageCommand(["stage", "approve", firstStage], { platform: "linux" }), {
      command: "npm",
      args: ["stage", "approve", firstStage],
    });
    assert.deepEqual(npmStageCommand(["stage", "list", "--json"], { platform: "darwin" }), {
      command: "npm",
      args: ["stage", "list", "--json"],
    });
  });

  it("rejects unexpected npm arguments before a command shell starts", () => {
    assert.throws(() => npmStageCommand(["stage", "approve", "not-a-uuid"], { platform: "win32" }), {
      reasonCode: "command",
      message: "Unsupported npm stage command.",
    });
    assert.throws(() => npmStageCommand(["publish", "."], { platform: "win32" }), {
      reasonCode: "command",
      message: "Unsupported npm stage command.",
    });
  });

  it("reports an operating-system command start failure", () => {
    const error = commandError("npm.cmd", ["stage", "list", "--json"], {
      stderr: "",
      error: new Error("spawnSync npm.cmd EINVAL"),
    });
    assert.equal(error.reasonCode, "command");
    assert.match(error.message, /spawnSync npm\.cmd EINVAL/);
  });

  it("resumes only an exact staged prefix from the same release run", () => {
    const checkpoint = createReceipt({
      repository: "ZarK/memex.core",
      tag: "publish-set-v0.1.7",
      headSha,
      runId: "99",
      runAttempt: "1",
    }, planned, staged.slice(0, 1), false);
    assert.deepEqual(resumeReceipt(checkpoint, {
      repository: "ZarK/memex.core",
      tag: "publish-set-v0.1.7",
      headSha,
      runId: "99",
    }, planned), staged.slice(0, 1));
    assert.throws(() => resumeReceipt(checkpoint, {
      repository: "ZarK/memex.core",
      tag: "publish-set-v0.1.8",
      headSha,
      runId: "99",
    }, planned), { reasonCode: "invalid-receipt" });
    assert.throws(() => resumeReceipt(checkpoint, {
      repository: "ZarK/memex.core",
      tag: "publish-set-v0.1.7-retry.1",
      headSha,
      runId: "100",
    }, planned.slice(1)), { reasonCode: "invalid-receipt" });
    assert.throws(() => resumeReceipt(checkpoint, {
      repository: "ZarK/memex.core",
      tag: "publish-set-v0.1.7",
      headSha,
      runId: "99",
    }, planned.slice().reverse()), { reasonCode: "invalid-receipt" });
  });

  it("fails closed on registry and active-stage mismatches", () => {
    const wrongPublished = new Map([
      ["@tjalve/memex-sqlite", new Map([["0.2.1", "f".repeat(40)]])],
    ]);
    assert.throws(() => planApprovals(receipt(), stages(), wrongPublished), { reasonCode: "invalid-receipt" });
    const missingPublishedShasum = new Map([
      ["@tjalve/memex-sqlite", new Map([["0.2.1", ""]])],
    ]);
    assert.throws(() => planApprovals(receipt(), stages(), missingPublishedShasum), { reasonCode: "invalid-receipt" });

    const wrongStages = stages();
    wrongStages[0].shasum = "f".repeat(40);
    assert.throws(() => planApprovals(receipt(), wrongStages, new Map()), { reasonCode: "invalid-receipt" });
  });

  it("rejects a published target version without a valid registry shasum", async () => {
    await assert.rejects(() => readPublishedShasums([planned[0]], async () => ({
      status: 200,
      ok: true,
      async json() {
        return { versions: { "0.2.1": { dist: {} } } };
      },
    })), { reasonCode: "registry-lookup" });
  });

  it("binds approval to the successful workflow, tag commit, and package manifests", async () => {
    const valid = receipt();
    const stageList = stages();
    const calls = [];
    const commands = {
      gh(args) {
        if (args[0] === "repo") return JSON.stringify({ nameWithOwner: "ZarK/memex.core" });
        if (args[1] === "list") return JSON.stringify([{
          databaseId: 99,
          headSha,
          headBranch: valid.tag,
          status: "completed",
          conclusion: "success",
          createdAt: "2026-08-18T10:00:00Z",
          url: "https://example.invalid/run/99",
        }]);
        return `${RECEIPT_MARKER}${encodeReceipt(valid)}`;
      },
      git(args) {
        calls.push(args.join(" "));
        if (args[0] === "rev-parse") return headSha;
        if (args[0] === "merge-base") return "";
        if (args[0] === "show" && args[1].endsWith("packages/sqlite/package.json")) {
          return JSON.stringify({ name: "@tjalve/memex-sqlite", version: "0.2.1" });
        }
        if (args[0] === "show" && args[1].endsWith(":package.json")) {
          return JSON.stringify({ name: "memex-core", private: true, version: "0.1.7" });
        }
        return JSON.stringify({ name: "@tjalve/memex-schema", version: "0.4.1" });
      },
      npm(args) {
        assert.deepEqual(args, ["stage", "list", "--json"]);
        return JSON.stringify(stageList);
      },
    };
    const prepared = await prepareApproval(valid.tag, {
      commands,
      fetch: async () => ({ status: 404, ok: false }),
    });
    assert.deepEqual(prepared.approvals.map(entry => entry.action), ["approve", "approve"]);
    assert.equal(calls.some(call => call === `merge-base --is-ancestor ${headSha} origin/main`), true);
  });

  it("binds retry approval to both immutable tags", async () => {
    const retryTag = "publish-set-v0.1.7-retry.1";
    const retryReceipt = createReceipt({
      repository: "ZarK/memex.core",
      tag: retryTag,
      headSha,
      runId: "100",
      runAttempt: "1",
    }, planned.slice(1), staged.slice(1), true);
    const calls = [];
    const commands = {
      gh(args) {
        if (args[0] === "repo") return JSON.stringify({ nameWithOwner: "ZarK/memex.core" });
        if (args[1] === "list") return JSON.stringify([{
          databaseId: 100,
          headSha,
          headBranch: retryTag,
          status: "completed",
          conclusion: "success",
          createdAt: "2026-08-18T11:00:00Z",
        }]);
        return `${RECEIPT_MARKER}${encodeReceipt(retryReceipt)}`;
      },
      git(args) {
        calls.push(args.join(" "));
        if (args[0] === "rev-parse" && args[1] === "publish-set-v0.1.7^{commit}") return "b".repeat(40);
        if (args[0] === "rev-parse") return headSha;
        if (args[0] === "merge-base") return "";
        if (args[0] === "show" && args[1].endsWith(":package.json")) {
          return JSON.stringify({ name: "memex-core", private: true, version: "0.1.7" });
        }
        return JSON.stringify({ name: "@tjalve/memex-schema", version: "0.4.1" });
      },
      npm() { return JSON.stringify(stages().slice(1)); },
    };
    await prepareApproval(retryTag, {
      commands,
      fetch: async () => ({ status: 404, ok: false }),
    });
    assert.equal(calls.includes(`rev-parse ${retryTag}^{commit}`), true);
    assert.equal(calls.includes("rev-parse publish-set-v0.1.7^{commit}"), true);
    assert.equal(calls.includes(`merge-base --is-ancestor ${"b".repeat(40)} ${headSha}`), true);
  });

  it("rejects a successful run from another commit before reading npm stages", async () => {
    let npmCalled = false;
    const commands = {
      gh(args) {
        if (args[0] === "repo") return JSON.stringify({ nameWithOwner: "ZarK/memex.core" });
        return JSON.stringify([{
          databaseId: 99,
          headSha: "b".repeat(40),
          headBranch: "publish-set-v0.1.7",
          status: "completed",
          conclusion: "success",
          createdAt: "2026-08-18T10:00:00Z",
        }]);
      },
      git() { return headSha; },
      npm() { npmCalled = true; return "[]"; },
    };
    await assert.rejects(() => prepareApproval("publish-set-v0.1.7", { commands }), { reasonCode: "workflow-run" });
    assert.equal(npmCalled, false);
  });
});
