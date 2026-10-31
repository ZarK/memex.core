import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const workflow = readFileSync(path.join(repoRoot, ".github/workflows/publish.yml"), "utf8").replace(/\r\n/g, "\n");

function job(name) {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  assert.ok(start >= 0, `job ${name}`);
  const rest = workflow.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z-]+:\n/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

describe("publish workflow", () => {
  it("runs only for publish tags, with no token permissions by default", () => {
    assert.match(workflow, /on:\n {2}push:\n {4}tags:\n {6}- "publish-\*"\n/);
    assert.doesNotMatch(workflow, /pull_request|workflow_dispatch|branches:/);
    assert.match(workflow, /\npermissions: \{\}\n/);
  });

  it("verifies the signed source before the publish job, which waits for the npm-publish environment", () => {
    const verify = job("verify-source");
    assert.match(verify, /contents: read/);
    assert.doesNotMatch(verify, /id-token/);
    assert.match(verify, /node scripts\/verify-release-source\.mjs/);
    const publish = job("publish");
    assert.match(publish, /needs: verify-source/);
    assert.match(publish, /environment: npm-publish/);
    assert.match(publish, /id-token: write/);
    assert.match(publish, /actions: read/);
    assert.doesNotMatch(publish, /contents: write|packages: write/);
  });

  it("uses trusted publishing with no npm token and no install scripts", () => {
    assert.doesNotMatch(workflow, /NPM_TOKEN|NODE_AUTH_TOKEN|secrets\./);
    assert.match(workflow, /pnpm install --frozen-lockfile --ignore-scripts/);
    assert.match(workflow, /npm install -g npm@\d+\.\d+\.\d+ --ignore-scripts/);
    const steps = [...workflow.matchAll(/run: (node scripts\/[^\n]+)/g)].map(match => match[1]);
    assert.deepEqual(steps, [
      "node scripts/verify-release-source.mjs",
      "node scripts/resolve-publish-tag.mjs \"${GITHUB_REF_NAME}\" > publish-plan.json",
      "node scripts/restore-stage-receipt.mjs publish-plan.json",
      "node scripts/run-publish-plan.mjs prepare publish-plan.json",
      "node scripts/run-publish-plan.mjs verify publish-plan.json",
      "node scripts/verify-installed-packages.mjs --plan publish-plan.json",
      "node scripts/run-publish-plan.mjs stage publish-plan.json",
    ]);
    const stageScript = readFileSync(path.join(repoRoot, "scripts/run-publish-plan.mjs"), "utf8");
    assert.match(stageScript, /\["stage", "publish", "\.", "--access", "public", "--ignore-scripts", "--json"\]/);
    assert.doesNotMatch(stageScript, /"publish", "\.", "--access", "public"(?!, "--ignore-scripts")/);
  });

  it("names the job and the staging step the checkpoint restore looks for", () => {
    assert.match(job("publish"), /- name: Stage selected packages\n/);
    assert.match(workflow, /\n  publish:\n/);
    const receipt = readFileSync(path.join(repoRoot, "scripts/release-receipt.mjs"), "utf8");
    assert.match(receipt, /STAGE_STEP_NAME = "Stage selected packages"/);
    assert.match(receipt, /PUBLISH_JOB_NAME = "publish"/);
    const restore = readFileSync(path.join(repoRoot, "scripts/restore-stage-receipt.mjs"), "utf8");
    assert.match(restore, /stageConclusionFromMetadata\(metadata\)/);
  });

  it("prints the npm token exchange lines from the npm debug log only when staging fails", () => {
    const publish = job("publish");
    assert.match(publish, /- name: Show the npm token exchange result\n {8}if: failure\(\)\n {8}run: grep -h -E "oidc\|token\/exchange" "\$HOME"\/\.npm\/_logs\/\*-debug-\*\.log \|\| true\n/);
  });

  it("pins every action to a full commit SHA and checks out without stored credentials", () => {
    const uses = [...workflow.matchAll(/uses: ([^\s]+)/g)].map(match => match[1]);
    assert.ok(uses.length >= 4);
    for (const action of uses) assert.match(action, /@[0-9a-f]{40}$/, action);
    const checkouts = workflow.split("actions/checkout@").length - 1;
    assert.equal((workflow.match(/persist-credentials: false/g) ?? []).length, checkouts);
  });
});
