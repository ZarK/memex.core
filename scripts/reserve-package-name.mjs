#!/usr/bin/env node
// The one-time first publish of a brand-new package name. npm staged publishing cannot
// create a name, so the owner runs this once per new name, from their own npm login and
// with their two-factor code. It publishes a placeholder version that holds only
// package.json, README.md and LICENSE. Every real version then goes through the staged
// pipeline (docs/release-controls.md). This script never runs in CI.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

import { buildArgvCommandPlan } from "./process-launch.mjs";
import { PUBLISH_PACKAGES, RELEASE_PACKAGES, readRegistryPackage } from "./publish-packages.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const RESERVE_VERSION = "0.0.0-reserve";
export const RESERVE_TAG = "reserve";
const CI_VARIABLES = Object.freeze([
  "CI", "GITHUB_ACTIONS", "GITLAB_CI", "BUILDKITE", "TF_BUILD", "JENKINS_URL", "TEAMCITY_VERSION",
  "CIRCLECI", "TRAVIS", "APPVEYOR", "BITBUCKET_BUILD_NUMBER", "CODEBUILD_BUILD_ID", "DRONE", "RUNNER_OS",
]);
const OTP = /^\d{6,8}$/;

function refuse(message, reasonCode) {
  throw Object.assign(new Error(message), { reasonCode });
}

export function parseReserveArgs(argv) {
  const options = { key: undefined, otp: undefined, dryRun: false, yes: false, noWait: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") options.help = true;
    else if (token === "--dry-run") options.dryRun = true;
    else if (token === "--yes" || token === "-y") options.yes = true;
    else if (token === "--no-wait") options.noWait = true;
    else if (token === "--") continue;
    else if (token === "--otp") {
      index += 1;
      const value = argv[index] ?? "";
      if (!OTP.test(value)) refuse("--otp requires the current code from your authenticator.", "usage");
      options.otp = value;
    } else if (!options.key && !token.startsWith("-")) options.key = token;
    else refuse(`Unknown argument: ${token}`, "usage");
  }
  if (!options.help && !options.key) refuse("Name one package, for example: node scripts/reserve-package-name.mjs memex-sqlite", "usage");
  return options;
}

// Any sign of an automated run refuses: a first publish is the owner's own act.
export function inspectRunner(env = process.env, terminal = { stdin: process.stdin.isTTY, stdout: process.stdout.isTTY }) {
  const markers = CI_VARIABLES.filter(name => {
    const value = env[name];
    return value !== undefined && value !== "" && value !== "0" && String(value).toLowerCase() !== "false";
  });
  if (markers.length > 0) {
    refuse(`This first publish runs only on the owner's own computer, never in CI (found ${markers.join(", ")}).`, "ci-refused");
  }
  if (!terminal.stdin || !terminal.stdout) {
    refuse("This first publish needs an interactive terminal: it asks you to confirm and npm asks for your two-factor code.", "not-interactive");
  }
}

export function placeholderManifest(entry) {
  return {
    name: entry.name,
    version: RESERVE_VERSION,
    description: `Reserves the npm name ${entry.name}. Real versions come from github.com/ZarK/memex.core through staged publishing.`,
    license: "MIT",
    repository: {
      type: "git",
      url: "git+https://github.com/ZarK/memex.core.git",
      directory: entry.path,
    },
    publishConfig: { access: "public" },
  };
}

export function placeholderReadme(entry) {
  return `# ${entry.name}

This version (${RESERVE_VERSION}) only reserves the package name on npm. It holds no code.

The package is developed in [ZarK/memex.core](https://github.com/ZarK/memex.core/tree/main/${entry.path}).
Its real versions are released through npm staged publishing and approved by the owner.
`;
}

export function writePlaceholder(entry, options = {}) {
  const folder = mkdtempSync(path.join(options.tmpdir ?? os.tmpdir(), "memex-reserve-"));
  writeFileSync(path.join(folder, "package.json"), `${JSON.stringify(placeholderManifest(entry), null, 2)}\n`, "utf8");
  writeFileSync(path.join(folder, "README.md"), placeholderReadme(entry), "utf8");
  copyFileSync(path.join(options.root ?? ROOT, "LICENSE"), path.join(folder, "LICENSE"));
  return folder;
}

function runNpm(args, options = {}) {
  const plan = buildArgvCommandPlan("npm", args);
  const result = spawnSync(plan.command, plan.args, {
    cwd: options.cwd ?? ROOT,
    encoding: "utf8",
    shell: false,
    stdio: options.inherit ? "inherit" : "pipe",
    windowsHide: true,
    windowsVerbatimArguments: plan.windowsVerbatimArguments,
  });
  if (result.status !== 0) {
    refuse(`npm ${args.filter(arg => !OTP.test(arg)).join(" ")} failed.${options.inherit ? "" : `\n${String(result.stderr ?? "").trim()}`}`, "npm");
  }
  return options.inherit ? "" : String(result.stdout ?? "");
}

export function trustedPublisherSteps(entry) {
  return [
    `Open https://www.npmjs.com/package/${entry.name}/access and add a trusted publisher:`,
    "  Publisher: GitHub Actions",
    "  Organization or user: ZarK",
    "  Repository: memex.core",
    "  Workflow filename: publish.yml",
    "  Environment: npm-publish",
    "  Allowed action: npm stage publish only (no direct publish)",
    "Do not create an npm token for this package.",
  ];
}

export async function reservePackageName(options) {
  const log = options.log ?? (line => process.stdout.write(`${line}\n`));
  const npm = options.npm ?? runNpm;
  const prompt = options.prompt ?? (async question => {
    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    try { return await terminal.question(question); } finally { terminal.close(); }
  });

  log("Step 1 of 8: check that this is an interactive run on your own computer, not CI.");
  inspectRunner(options.env, options.terminal);
  log("  ok");

  log("Step 2 of 8: find the package in the release catalog (scripts/publish-packages.mjs).");
  const allowed = PUBLISH_PACKAGES.get(options.key);
  const entry = RELEASE_PACKAGES.find(candidate => candidate.key === options.key);
  if (!allowed || !entry) {
    refuse(`Unknown package "${options.key}". Valid keys: ${RELEASE_PACKAGES.map(candidate => candidate.key).join(", ")}.`, "unknown-package");
  }
  log(`  ${entry.name} from ${entry.path}`);

  log("Step 3 of 8: check that the name is not on npm yet.");
  const registry = await readRegistryPackage(entry.name, { fetch: options.fetch });
  if (registry.exists) {
    log(`  ${entry.name} already exists on npm (${registry.versions.length} versions). Nothing to publish.`);
    for (const line of trustedPublisherSteps(entry)) log(`  ${line}`);
    return { published: false, reason: "exists", packageName: entry.name };
  }
  log("  the name is free");

  log("Step 4 of 8: check your npm login (npm whoami).");
  const login = String(npm(["whoami"])).trim();
  if (!login) refuse("npm whoami returned no login. Run npm login first.", "npm-login");
  log(`  logged in as ${login}; this account must own the npm scope @tjalve`);
  // The public registry can lag minutes behind a publish; the account's own package list does not.
  let owned = {};
  try { owned = JSON.parse(String(npm(["access", "list", "packages", entry.name.split("/")[0], "--json"]) || "{}")); } catch { owned = {}; }
  if (owned && Object.prototype.hasOwnProperty.call(owned, entry.name)) {
    log(`  ${entry.name} is already in your account; the public registry has not caught up yet. Nothing to publish.`);
    for (const line of trustedPublisherSteps(entry)) log(`  ${line}`);
    return { published: false, reason: "exists", packageName: entry.name };
  }

  log(`Step 5 of 8: write the placeholder ${entry.name}@${RESERVE_VERSION} (package.json, README.md, LICENSE).`);
  const folder = writePlaceholder(entry, { tmpdir: options.tmpdir, root: options.root });
  log(`  ${folder}`);

  log("Step 6 of 8: list what npm would publish (npm pack --dry-run).");
  const listing = JSON.parse(npm(["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: folder }));
  const files = (listing[0]?.files ?? []).map(file => file.path).sort();
  for (const file of files) log(`  ${file}`);
  if (JSON.stringify(files) !== JSON.stringify(["LICENSE", "README.md", "package.json"])) {
    refuse(`The placeholder must hold exactly LICENSE, README.md and package.json; npm lists ${files.join(", ")}.`, "placeholder-contents");
  }

  const publishArgs = ["publish", folder, "--access", "public", "--tag", RESERVE_TAG, "--ignore-scripts"];
  if (options.dryRun) publishArgs.push("--dry-run");
  if (options.otp) publishArgs.push("--otp", options.otp);

  log(`Step 7 of 8: ${options.dryRun ? "show the publish without sending it" : "publish the placeholder from your login"} (npm ${publishArgs.filter(arg => !OTP.test(arg)).join(" ").replace(" --otp", " --otp <code>")}).`);
  if (!options.dryRun) {
    // --yes skips only this typed confirmation; npm still asks for two-factor approval of every publish.
    if (options.yes) log(`  confirmed with --yes: publish ${entry.name}@${RESERVE_VERSION} from ${login}`);
    else {
      const answer = await prompt(`Type ${entry.name} to publish ${RESERVE_VERSION} from ${login}: `);
      if (String(answer).trim() !== entry.name) refuse("First publish cancelled. Nothing was published.", "cancelled");
    }
    if (!options.otp) log("  npm asks for your two-factor code next.");
  }
  npm(publishArgs, { cwd: folder, inherit: true });

  if (options.dryRun) {
    log("Step 8 of 8: dry run, nothing was published.");
    return { published: false, reason: "dry-run", packageName: entry.name, folder };
  }
  if (options.noWait) {
    log("Step 8 of 8: skipped with --no-wait; check all names at the end with npm view and npm trust list.");
    return { published: true, visible: undefined, packageName: entry.name, folder };
  }
  log("Step 8 of 8: check that the registry shows the name, then set up the stage-only trusted publisher.");
  let visible = false;
  for (let attempt = 0; attempt < (options.attempts ?? 12) && !visible; attempt += 1) {
    visible = (await readRegistryPackage(entry.name, { fetch: options.fetch })).exists;
    if (!visible) await (options.delay ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(5_000);
  }
  log(visible ? `  ${entry.name} is on npm` : `  ${entry.name} is not readable yet; check again with: npm view ${entry.name} versions`);
  for (const line of trustedPublisherSteps(entry)) log(`  ${line}`);
  log(`  Optional: mark the placeholder so nobody installs it: npm deprecate ${entry.name}@${RESERVE_VERSION} "Placeholder that reserves the name; install a release version."`);
  return { published: true, visible, packageName: entry.name, folder };
}

function printHelp() {
  process.stdout.write(`Usage: node scripts/reserve-package-name.mjs <package> [--otp <code>] [--dry-run] [--yes]

The one-time first publish of one brand-new npm package name, run by the owner from their
own npm login. It publishes ${RESERVE_VERSION} (package.json, README.md and LICENSE only) under
the dist-tag "${RESERVE_TAG}", then prints how to set up the stage-only trusted publisher.
It refuses to run in CI or without an interactive terminal.

Packages, in release order: ${RELEASE_PACKAGES.map(entry => entry.key).join(", ")}.
`);
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const options = parseReserveArgs(argv);
    if (options.help) return printHelp();
    await reservePackageName(options);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = error?.reasonCode === "usage" ? 2 : 1;
  }
}

const invoked = process.argv[1] && path.normalize(process.argv[1]) === path.normalize(fileURLToPath(import.meta.url));
if (invoked) await main();
