#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

import { PUBLISH_PACKAGES, PUBLISH_SET_ORDER, SET_VERSION_FILE, parseSetPublishTag, registryPackageUrl } from "./publish-packages.mjs";
import { findCompleteReceipt, planApprovals, validateReceipt } from "./release-receipt.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_TAG = /^publish-(.+)-v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;
const STAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function commandError(command, args, result) {
  const detail = String(result.stderr ?? "").trim()
    || (result.error instanceof Error ? result.error.message : "");
  return Object.assign(new Error(detail || `${command} ${args.join(" ")} failed.`), { reasonCode: "command" });
}

export function npmStageCommand(args, options = {}) {
  const stageList = args.length === 3 && args[0] === "stage" && args[1] === "list" && args[2] === "--json";
  const stageApprove = args.length === 3 && args[0] === "stage" && args[1] === "approve" && STAGE_ID.test(args[2]);
  if (!stageList && !stageApprove) {
    throw Object.assign(new Error("Unsupported npm stage command."), { reasonCode: "command" });
  }
  if ((options.platform ?? process.platform) !== "win32") return { command: "npm", args };
  return {
    command: options.comspec ?? process.env.ComSpec ?? process.env.COMSPEC ?? "cmd.exe",
    args: ["/d", "/s", "/c", "npm.cmd", ...args],
  };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    encoding: "utf8",
    shell: false,
    stdio: options.inherit ? "inherit" : "pipe",
    windowsHide: true,
  });
  if (result.status !== 0) throw commandError(command, args, result);
  return options.inherit ? "" : String(result.stdout ?? "").trim();
}

function runNpm(args, options = {}) {
  const invocation = npmStageCommand(args);
  return run(invocation.command, invocation.args, options);
}

function parseJson(output, label) {
  try {
    return JSON.parse(output);
  } catch (error) {
    throw Object.assign(new Error(`${label} did not return valid JSON.`), { reasonCode: "command", cause: error });
  }
}

export function parseApprovalArgs(argv) {
  const options = { tag: undefined, help: false };
  for (const token of argv) {
    if (token === "--help" || token === "-h") options.help = true;
    else if (token === "--") continue;
    else if (!options.tag && !token.startsWith("-")) options.tag = token;
    else throw Object.assign(new Error(`Unknown argument: ${token}`), { reasonCode: "usage" });
  }
  if (!options.help && !options.tag) {
    throw Object.assign(new Error("A publish tag is required."), { reasonCode: "usage" });
  }
  return options;
}

function inspectTag(receipt, git = { run: (args) => run("git", args) }) {
  const tagSha = git.run(["rev-parse", `${receipt.tag}^{commit}`]);
  if (tagSha !== receipt.headSha) throw Object.assign(new Error("The local release tag does not match the receipt commit."), { reasonCode: "tag-mismatch" });
  git.run(["merge-base", "--is-ancestor", receipt.headSha, "origin/main"]);

  const indexes = [];
  for (const entry of receipt.expectedPackages) {
    const allowed = PUBLISH_PACKAGES.get(entry.packageKey);
    if (!allowed) throw Object.assign(new Error(`Unknown receipt package ${entry.packageKey}.`), { reasonCode: "tag-mismatch" });
    const manifest = parseJson(git.run(["show", `${receipt.headSha}:${allowed.packageJson}`]), allowed.packageJson);
    if (manifest.name !== entry.packageName || manifest.version !== entry.version || allowed.filter !== entry.packageName) {
      throw Object.assign(new Error(`Receipt package ${entry.packageKey} does not match the release commit.`), { reasonCode: "tag-mismatch" });
    }
    indexes.push(PUBLISH_SET_ORDER.indexOf(entry.packageKey));
  }
  if (new Set(indexes).size !== indexes.length || indexes.some((value, index) => value < 0 || (index > 0 && value <= indexes[index - 1]))) {
    throw Object.assign(new Error("Receipt packages are not in dependency order."), { reasonCode: "tag-mismatch" });
  }

  if (receipt.tag.startsWith("publish-set-v")) {
    const manifest = parseJson(git.run(["show", `${receipt.headSha}:${SET_VERSION_FILE}`]), SET_VERSION_FILE);
    const setTag = parseSetPublishTag(receipt.tag, manifest.version);
    if (!setTag) throw Object.assign(new Error("Set tag version does not match the release commit."), { reasonCode: "tag-mismatch" });
    if (setTag.retry !== null) {
      const originalCommit = git.run(["rev-parse", `${setTag.originalTag}^{commit}`]);
      git.run(["merge-base", "--is-ancestor", originalCommit, receipt.headSha]);
    }
    return;
  }
  const packageMatch = PACKAGE_TAG.exec(receipt.tag);
  if (!packageMatch || receipt.expectedPackages.length !== 1
    || receipt.expectedPackages[0].packageKey !== packageMatch[1]
    || receipt.expectedPackages[0].version !== packageMatch[2]) {
    throw Object.assign(new Error("Package tag does not match the receipt plan."), { reasonCode: "tag-mismatch" });
  }
}

export async function readPublishedShasums(packages, fetchImpl = globalThis.fetch) {
  const published = new Map();
  for (const entry of packages) {
    const response = await fetchImpl(registryPackageUrl(entry.packageName), { headers: { accept: "application/json" } });
    if (response.status === 404) {
      published.set(entry.packageName, new Map());
      continue;
    }
    if (!response.ok) throw Object.assign(new Error(`Registry lookup for ${entry.packageName} failed (${response.status}).`), { reasonCode: "registry-lookup" });
    const packument = await response.json();
    const versions = new Map();
    const manifest = packument.versions?.[entry.version];
    if (manifest) {
      const shasum = String(manifest.dist?.shasum ?? "").toLowerCase();
      if (!/^[0-9a-f]{40}$/.test(shasum)) {
        throw Object.assign(new Error(`Registry lookup for ${entry.packageName}@${entry.version} returned an invalid shasum.`), {
          reasonCode: "registry-lookup",
        });
      }
      versions.set(entry.version, shasum);
    }
    published.set(entry.packageName, versions);
  }
  return published;
}

function findWorkflowRun(tag, headSha, commands) {
  const runs = parseJson(commands.gh([
    "run", "list", "--workflow", "publish.yml", "--branch", tag, "--event", "push", "--limit", "20",
    "--json", "databaseId,headSha,headBranch,status,conclusion,createdAt,url",
  ]), "GitHub workflow run list");
  const matches = runs.filter(item => item.headBranch === tag && item.headSha === headSha
    && item.status === "completed" && item.conclusion === "success")
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
  if (matches.length === 0) throw Object.assign(new Error(`No successful publish workflow run matches ${tag} at ${headSha}.`), { reasonCode: "workflow-run" });
  return matches[0];
}

export async function prepareApproval(tag, options = {}) {
  const commands = options.commands ?? {
    git: args => run("git", args),
    gh: args => run("gh", args),
    npm: (args, commandOptions) => runNpm(args, commandOptions),
  };
  const repository = parseJson(commands.gh(["repo", "view", "--json", "nameWithOwner"]), "GitHub repository").nameWithOwner;
  const headSha = commands.git(["rev-parse", `${tag}^{commit}`]);
  const workflowRun = findWorkflowRun(tag, headSha, commands);
  const receipt = findCompleteReceipt(commands.gh(["run", "view", String(workflowRun.databaseId), "--log"]));
  validateReceipt(receipt, { repository, tag, headSha, runId: workflowRun.databaseId });
  inspectTag(receipt, { run: commands.git });
  const stages = parseJson(commands.npm(["stage", "list", "--json"]), "npm stage list");
  const published = await readPublishedShasums(receipt.packages, options.fetch);
  return { receipt, workflowRun, approvals: planApprovals(receipt, stages, published), commands };
}

export function approvePackages(approvals, npmCommand, output = process.stdout) {
  const pending = approvals.filter(entry => entry.action === "approve");
  for (const entry of pending) {
    output.write(`Approving ${entry.packageName}@${entry.version}\n`);
    npmCommand(["stage", "approve", entry.stageId], { inherit: true });
  }
  return pending.length;
}

export async function approveRelease(tag, options = {}) {
  const prepared = await prepareApproval(tag, options);
  const pending = prepared.approvals.filter(entry => entry.action === "approve");
  const completed = prepared.approvals.filter(entry => entry.action === "skip-published");

  process.stdout.write(`Release ${tag}\n`);
  process.stdout.write(`Commit ${prepared.receipt.headSha}\n`);
  for (const entry of prepared.approvals) {
    process.stdout.write(`- ${entry.packageName}@${entry.version} ${entry.shasum} [${entry.action === "approve" ? "staged" : "already approved"}]\n`);
  }
  if (pending.length === 0) {
    process.stdout.write("All packages in this release are already public with matching shasums.\n");
    return { approved: 0, completed: completed.length };
  }

  const prompt = options.prompt ?? (async question => {
    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    try { return await terminal.question(question); } finally { terminal.close(); }
  });
  const answer = await prompt(`Type ${tag} to approve this release: `);
  if (answer.trim() !== tag) throw Object.assign(new Error("Release approval cancelled."), { reasonCode: "cancelled" });

  const approved = approvePackages(prepared.approvals, prepared.commands.npm);
  process.stdout.write(`Approved ${approved} package${approved === 1 ? "" : "s"}.\n`);
  return { approved, completed: completed.length };
}

function printHelp() {
  process.stdout.write("Usage: node scripts/approve-staged-release.mjs <publish-tag>\n\nValidate and approve one staged release set. npm authentication and proof-of-presence remain required.\n");
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const parsed = parseApprovalArgs(argv);
    if (parsed.help) return printHelp();
    await approveRelease(parsed.tag, parsed);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = error?.reasonCode === "usage" ? 2 : 1;
  }
}

const invoked = process.argv[1] && path.normalize(process.argv[1]) === path.normalize(fileURLToPath(import.meta.url));
if (invoked) await main();
