import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  CHECKPOINT_MARKER,
  createReceipt,
  encodeReceipt,
  restoreReceiptAttempt,
  stageConclusionFromMetadata,
} from "../../scripts/release-receipt.mjs";
import {
  installArguments,
  MIN_RELEASE_AGE_DAYS,
  packagesToCheck,
  scratchEnvironment,
  verifyInstalledPackages,
} from "../../scripts/verify-installed-packages.mjs";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const headSha = "b".repeat(40);
const planned = [
  { packageKey: "memex-sqlite", packageName: "@tjalve/memex-sqlite", version: "0.1.0", tag: "latest" },
];
const context = { repository: "ZarK/memex.core", tag: "publish-set-v0.1.0", headSha, runId: "77", runAttempt: "2" };

const verifySourceFailed = {
  attempt: 1,
  headSha,
  jobs: [
    { name: "verify-source", conclusion: "failure", steps: [{ name: "Verify signed release source", conclusion: "failure" }] },
    { name: "publish", conclusion: "skipped", steps: [] },
  ],
};
const approvalRejected = {
  attempt: 1,
  headSha,
  jobs: [
    { name: "verify-source", conclusion: "success", steps: [{ name: "Verify signed release source", conclusion: "success" }] },
    { name: "publish", conclusion: "failure", steps: [] },
  ],
};
const installFailed = {
  attempt: 1,
  headSha,
  jobs: [
    { name: "verify-source", conclusion: "success", steps: [] },
    {
      name: "publish",
      conclusion: "failure",
      steps: [
        { name: "Install dependencies", conclusion: "failure" },
        { name: "Stage selected packages", conclusion: "skipped" },
      ],
    },
  ],
};

describe("re-running a publish run", () => {
  it("counts an attempt whose publish job never started as nothing staged", () => {
    assert.equal(stageConclusionFromMetadata(verifySourceFailed), "skipped");
    assert.equal(stageConclusionFromMetadata(approvalRejected), "skipped");
    assert.equal(stageConclusionFromMetadata({ attempt: 1, headSha, jobs: [verifySourceFailed.jobs[0]] }), "skipped");
    assert.equal(stageConclusionFromMetadata(installFailed), "skipped");
    for (const metadata of [verifySourceFailed, approvalRejected]) {
      assert.equal(restoreReceiptAttempt({
        attempt: 1, headSha, stageConclusion: stageConclusionFromMetadata(metadata), log: "verify-source failed",
      }, context, planned), null);
    }
  });

  it("keeps an unknown or started stage step fail-closed", () => {
    const startedWithoutStage = {
      jobs: [{ name: "publish", steps: [{ name: "Check out repository", conclusion: "success" }] }],
    };
    assert.equal(stageConclusionFromMetadata(startedWithoutStage), null);
    assert.equal(stageConclusionFromMetadata({
      jobs: [{ name: "publish", steps: [{ name: "Stage selected packages", conclusion: "failure" }] }],
    }), "failure");
    assert.equal(stageConclusionFromMetadata({
      jobs: [{ name: "publish", steps: [{ name: "Stage selected packages", conclusion: null }] }],
    }), null);
    assert.throws(() => restoreReceiptAttempt({
      attempt: 1, headSha, stageConclusion: stageConclusionFromMetadata(startedWithoutStage), log: "",
    }, context, planned), { reasonCode: "invalid-receipt" });
  });

  // Runs the real restore step against a stand-in gh that answers with recorded attempt metadata.
  const posixOnly = process.platform === "win32" ? "the stand-in gh is a POSIX script" : false;
  for (const [label, attempts, expectStaged] of [
    ["after a failed verify-source", [verifySourceFailed], 0],
    ["after a rejected approval", [approvalRejected], 0],
    ["after two attempts that never staged", [verifySourceFailed, { ...approvalRejected, attempt: 2 }], 0],
    ["after an attempt that staged one package", [installFailed], 1],
  ]) {
    it(`restore-stage-receipt starts the next attempt correctly ${label}`, { skip: posixOnly }, () => {
      const work = mkdtempSync(path.join(os.tmpdir(), "memex-restore-stage-"));
      const bin = path.join(work, "bin");
      mkdirSync(bin);
      const currentAttempt = attempts.length + 1;
      const answers = {};
      for (const [index, metadata] of attempts.entries()) {
        const number = index + 1;
        let log = `${metadata.jobs[0].name}\tstep\tfinished`;
        if (expectStaged > 0) {
          const prior = { ...context, runAttempt: String(number) };
          const staged = [{
            ...planned[0],
            stageId: "33333333-3333-4333-8333-333333333333",
            shasum: "3".repeat(40),
          }];
          log = `${CHECKPOINT_MARKER}${encodeReceipt(createReceipt(prior, planned, staged, true))}`;
        }
        answers[number] = { metadata: { ...metadata, attempt: number }, log };
      }
      writeFileSync(path.join(work, "answers.json"), JSON.stringify(answers));
      const gh = path.join(bin, "gh");
      writeFileSync(gh, `#!/usr/bin/env node
const answers = JSON.parse(require("node:fs").readFileSync(${JSON.stringify(path.join(work, "answers.json"))}, "utf8"));
const args = process.argv.slice(2);
const answer = answers[args[args.indexOf("--attempt") + 1]];
if (!answer) process.exit(1);
process.stdout.write(args.includes("--log") ? answer.log : JSON.stringify(answer.metadata));
`);
      chmodSync(gh, 0o755);
      // A copy of the two scripts, so the receipt lands in the scratch folder, not the checkout.
      const scripts = path.join(work, "scripts");
      mkdirSync(scripts);
      for (const name of ["restore-stage-receipt.mjs", "release-receipt.mjs"]) {
        copyFileSync(path.join(repoRoot, "scripts", name), path.join(scripts, name));
      }
      const planPath = path.join(work, "publish-plan.json");
      writeFileSync(planPath, JSON.stringify({ packages: planned }));
      const result = spawnSync(process.execPath, [path.join(scripts, "restore-stage-receipt.mjs"), planPath], {
        cwd: work,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}${path.delimiter}${process.env.PATH}`,
          GITHUB_REPOSITORY: context.repository,
          GITHUB_REF_NAME: context.tag,
          GITHUB_SHA: headSha,
          GITHUB_RUN_ID: context.runId,
          GITHUB_RUN_ATTEMPT: String(currentAttempt),
        },
      });
      assert.equal(result.status, 0, result.stderr);
      const line = result.stdout.split("\n").find(text => text.startsWith(CHECKPOINT_MARKER));
      assert.ok(line, result.stdout);
      const receipt = JSON.parse(readFileSync(path.join(work, "stage-receipt.json"), "utf8"));
      assert.equal(receipt.runAttempt, String(currentAttempt));
      assert.equal(receipt.packages.length, expectStaged);
    });
  }
});

describe("installed check", () => {
  it("installs with the 14-day minimum release age and the packed files last", () => {
    assert.equal(MIN_RELEASE_AGE_DAYS, 14);
    const args = installArguments(["a.tgz", "b.tgz"]);
    assert.equal(args[0], "install");
    assert.ok(args.includes("--min-release-age=14"));
    assert.ok(args.includes("--ignore-scripts"));
    assert.deepEqual(args.slice(-2), ["a.tgz", "b.tgz"]);
  });

  it("gives child processes scratch homes and no OIDC token variables", () => {
    const base = mkdtempSync(path.join(os.tmpdir(), "memex-installed-env-"));
    const env = scratchEnvironment(base, {
      PATH: "/usr/bin",
      MEMEX_HOME: "/elsewhere",
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.example.test",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "placeholder",
    });
    assert.equal(env.PATH, "/usr/bin");
    assert.equal(env.MEMEX_HOME, path.join(base, "home"));
    assert.equal(env.MEMEX_ARCHIVE_HOME, path.join(base, "archive"));
    assert.equal(env.MEMEX_APPS_DIR, path.join(base, "apps"));
    assert.equal("ACTIONS_ID_TOKEN_REQUEST_URL" in env, false);
    assert.equal("ACTIONS_ID_TOKEN_REQUEST_TOKEN" in env, false);
  });

  it("refuses a plan entry that is not in the allowlist", () => {
    assert.throws(() => packagesToCheck({ packages: [] }), { reasonCode: "plan" });
    assert.throws(() => packagesToCheck({
      packages: [{ packageKey: "memex-sqlite", packageName: "@tjalve/other", path: "packages/sqlite" }],
    }), { reasonCode: "plan" });
  });

  it("refuses a check folder inside the checkout", async () => {
    const plan = { packages: [{ packageKey: "memex-sqlite", packageName: "@tjalve/memex-sqlite", path: "packages/sqlite" }] };
    const entry = packagesToCheck(plan)[0];
    assert.equal(entry.packageName, "@tjalve/memex-sqlite");
    const inside = path.join(repoRoot, "node_modules", ".cache");
    mkdirSync(inside, { recursive: true });
    await assert.rejects(verifyInstalledPackages(plan, { root: repoRoot, tmpdir: inside, log() {} }), { reasonCode: "installed-check" });
  });
});
