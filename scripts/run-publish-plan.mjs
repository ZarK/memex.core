import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { collectPublishManifestFailures } from "./check-publish-manifest.mjs";
import { PUBLISH_PACKAGES, SET_PREPARE, SET_VERIFY } from "./publish-packages.mjs";
import { buildShellCommandPlan } from "./process-launch.mjs";
import { createReceipt, parseStageOutput, resumeReceipt, saveReceipt, writeStageIntent } from "./release-receipt.mjs";
import { resolvePublishDependencies } from "./resolve-publish-dependencies.mjs";
import { restorePublishDependencies } from "./restore-publish-dependencies.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PHASES = new Set(["prepare", "verify", "stage"]);

function fail(message, code = 1) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function runAllowlisted(command, cwd = ROOT) {
  const invocation = buildShellCommandPlan(command);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd,
    encoding: "utf8",
    shell: false,
    stdio: "inherit",
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    windowsHide: true,
  });
  if (result.status !== 0) {
    fail(`${command} failed with exit ${result.status ?? "unknown"}.`, result.status ?? 1);
  }
}

function runCaptured(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    throw Object.assign(new Error(`${command} ${args.join(" ")} failed with exit ${result.status ?? "unknown"}.`), {
      reasonCode: "stage-command",
      exitCode: result.status ?? 1,
    });
  }
  return result.stdout ?? "";
}

export function allowlistedEntry(entry) {
  const allowed = PUBLISH_PACKAGES.get(entry.packageKey);
  if (!allowed) throw Object.assign(new Error(`Unknown publish package "${entry.packageKey}".`), { reasonCode: "plan" });
  if (allowed.path !== entry.path || allowed.packageJson !== entry.packageJson || allowed.filter !== entry.filter) {
    throw Object.assign(new Error(`Publish plan for ${entry.packageKey} does not match the allowlist.`), { reasonCode: "plan" });
  }
  return allowed;
}

export function expectedCommand(plan, phase) {
  if (phase === "prepare") return plan.mode === "set" ? SET_PREPARE : allowlistedEntry(plan.packages[0]).prepare;
  return plan.mode === "set" ? SET_VERIFY : allowlistedEntry(plan.packages[0]).verify;
}

async function stage(plan) {
  const context = {
    repository: process.env.GITHUB_REPOSITORY,
    tag: process.env.GITHUB_REF_NAME,
    headSha: process.env.GITHUB_SHA,
    runId: process.env.GITHUB_RUN_ID,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT,
  };
  for (const [key, value] of Object.entries(context)) {
    if (!value) fail(`Required GitHub Actions context ${key} is missing.`);
  }
  const receiptPath = path.join(ROOT, "stage-receipt.json");
  let staged = [];
  try {
    const checkpoint = JSON.parse(await readFile(receiptPath, "utf8"));
    staged = resumeReceipt(checkpoint, context, plan.packages);
    await saveReceipt(createReceipt(context, plan.packages, staged, checkpoint.complete), receiptPath);
    if (checkpoint.complete) {
      process.exit(0);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    if (String(context.runAttempt) !== "1") {
      fail("A retry has no restored staging checkpoint. Refusing to restage packages.");
    }
    await saveReceipt(createReceipt(context, plan.packages, [], false), receiptPath);
  }
  for (const entry of plan.packages.slice(staged.length)) {
    const allowed = allowlistedEntry(entry);
    const manifestPath = path.join(ROOT, allowed.packageJson);
    try {
      await resolvePublishDependencies(manifestPath, { root: ROOT });
      const failures = collectPublishManifestFailures(JSON.parse(await readFile(manifestPath, "utf8")), allowed.packageJson);
      if (failures.length > 0) throw Object.assign(new Error(failures.join("\n")), { reasonCode: "publish-manifest" });
      writeStageIntent(context, entry);
      const stdout = runCaptured(
        "npm",
        ["stage", "publish", ".", "--access", "public", "--ignore-scripts", "--json"],
        path.join(ROOT, allowed.path)
      );
      staged.push(parseStageOutput(stdout, entry));
      await saveReceipt(createReceipt(context, plan.packages, staged, false), receiptPath);
    } finally {
      await restorePublishDependencies(manifestPath);
    }
  }
  await saveReceipt(createReceipt(context, plan.packages, staged, true), receiptPath);
}

async function run() {
  const phase = process.argv[2] ?? "";
  const planPath = path.resolve(process.argv[3] ?? "publish-plan.json");
  if (!PHASES.has(phase)) {
    fail("Usage: node scripts/run-publish-plan.mjs <prepare|verify|stage> <plan.json>");
  }

  const plan = JSON.parse(await readFile(planPath, "utf8"));
  if (!plan || !Array.isArray(plan.packages) || plan.packages.length === 0) {
    fail("Publish plan has no packages.");
  }
  try {
    for (const entry of plan.packages) allowlistedEntry(entry);
  } catch (error) {
    fail(error.message);
  }

  if (phase === "prepare" || phase === "verify") {
    const expected = expectedCommand(plan, phase);
    if (plan[phase] !== expected) fail(`Publish plan ${phase} command is not allowlisted.`);
    runAllowlisted(expected);
  } else {
    await stage(plan);
  }
}

const invoked = process.argv[1] && path.normalize(process.argv[1]) === path.normalize(fileURLToPath(import.meta.url));
if (invoked) {
  try {
    await run();
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error), error?.exitCode ?? 1);
  }
}
