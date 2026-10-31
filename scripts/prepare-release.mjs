import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  PUBLISH_PACKAGES,
  PUBLISH_SET_ORDER,
  SET_VERSION_FILE,
  readPublishedVersionsForPlan,
  resolvePublishTag,
} from "./publish-packages.mjs";

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SET_TAG = /^publish-set-v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
// A package is released again when one of these changes in a package it depends on.
const RUNTIME_FIELDS = Object.freeze(["dependencies", "optionalDependencies", "peerDependencies"]);
const ALL_FIELDS = Object.freeze([...RUNTIME_FIELDS, "devDependencies"]);

function fail(message, reasonCode) {
  throw Object.assign(new Error(message), { reasonCode });
}

function runGit(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true, timeout: 30_000 });
  if (result.status !== 0) fail((result.stderr ?? "").trim() || `git ${args.join(" ")} failed.`, "git");
  return result.stdout ?? "";
}

export function resolveRepoRoot(candidate, cwd = process.cwd()) {
  const resolved = path.resolve(cwd, candidate ?? DEFAULT_ROOT);
  const workspaceFile = path.join(resolved, "pnpm-workspace.yaml");
  if (!existsSync(workspaceFile) || !existsSync(path.join(resolved, SET_VERSION_FILE))) {
    throw Object.assign(new Error("The repository root must hold pnpm-workspace.yaml and package.json."), {
      reasonCode: "missing-root",
    });
  }
  return realpathSync.native(resolved);
}

export function bumpPatch(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(version));
  if (!match) {
    throw Object.assign(new Error(`Unsupported semver value: ${version}`), { reasonCode: "semver" });
  }
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

function readJson(root, relativePath) {
  return JSON.parse(readFileSync(resolveInside(root, relativePath), "utf8"));
}

function resolveInside(root, relativePath) {
  const resolved = path.resolve(root, relativePath);
  const realRoot = realpathSync.native(root);
  const realTarget = existsSync(resolved)
    ? realpathSync.native(resolved)
    : path.join(realpathSync.native(path.dirname(resolved)), path.basename(resolved));
  const relative = path.relative(realRoot, realTarget);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    fail(`${relativePath} escapes the repository root.`, "path-escape");
  }
  return resolved;
}

function replaceFile(filePath, contents) {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let temporaryExists = false;
  try {
    writeFileSync(temporaryPath, contents, { encoding: "utf8", flag: "wx" });
    temporaryExists = true;
    renameSync(temporaryPath, filePath);
    temporaryExists = false;
  } finally {
    if (temporaryExists) rmSync(temporaryPath, { force: true });
  }
}

function writeJson(root, relativePath, value) {
  replaceFile(resolveInside(root, relativePath), `${JSON.stringify(value, null, 2)}\n`);
}

export function parseChangedPaths(output) {
  const paths = String(output).split("\0").filter(Boolean);
  for (const changedPath of paths) {
    const normalized = changedPath.replaceAll("\\", "/");
    if (normalized.startsWith("/") || normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
      fail(`Git returned an unsafe changed path: ${changedPath}.`, "unsafe-changed-path");
    }
  }
  return paths.map(changedPath => changedPath.replaceAll("\\", "/"));
}

// The newest set tag reachable from HEAD. Before the first release there is none, and every
// package counts as changed: a version that is not on npm yet is kept as it is.
export function resolveReleaseBaseline(root, git = { run: runGit }, options = {}) {
  const tags = git.run(["tag", "--merged", "HEAD", "--list", "publish-set-v*", "--sort=-version:refname"], root)
    .split(/\r?\n/)
    .map(tag => tag.trim())
    .filter(Boolean);
  const baselineTag = tags.find(tag => SET_TAG.test(tag) && tag !== options.excludeTag && !/-retry\.\d+$/.test(tag));
  if (!baselineTag) return { baselineTag: null, baselineSha: null };
  const baselineSha = git.run(["rev-list", "-n", "1", baselineTag], root).trim();
  if (!/^[0-9a-f]{40}$/i.test(baselineSha)) fail(`Release baseline ${baselineTag} did not resolve to a commit.`, "release-baseline");
  return { baselineTag, baselineSha };
}

function readTagState(git, args, root, tag) {
  try {
    return git.run(args, root);
  } catch (error) {
    throw Object.assign(new Error(`Cannot inspect immutable set tag ${tag}; verify local and origin tag access before preparing a release.`), {
      reasonCode: "set-tag-state",
      cause: error,
    });
  }
}

function commitSha(value, label) {
  const sha = String(value ?? "").trim();
  if (!/^[0-9a-f]{40}$/i.test(sha)) fail(`${label} did not resolve to a commit.`, "set-tag-state");
  return sha;
}

function remoteTagRefs(output, tag) {
  const directRef = `refs/tags/${tag}`;
  const peeledRef = `${directRef}^{}`;
  let direct = null;
  let peeled = null;
  for (const line of String(output).split(/\r?\n/).map(value => value.trim()).filter(Boolean)) {
    const match = /^([0-9a-f]{40})\s+(refs\/tags\/[^\s]+)$/i.exec(line);
    if (!match || (match[2] !== directRef && match[2] !== peeledRef)) {
      fail(`Origin returned an invalid reference while inspecting ${tag}.`, "set-tag-state");
    }
    const field = match[2] === peeledRef ? "peeled" : "direct";
    const current = field === "peeled" ? peeled : direct;
    if (current && current !== match[1]) fail(`Origin returned conflicting references for ${tag}.`, "set-tag-state");
    if (field === "peeled") peeled = match[1];
    else direct = match[1];
  }
  if (peeled && !direct) fail(`Origin returned a peeled reference without ${directRef}.`, "set-tag-state");
  return { direct, peeled };
}

function resolveCommit(git, root, tag, revision, label) {
  return commitSha(
    readTagState(git, ["rev-parse", "--verify", `${revision}^{commit}`], root, tag),
    label,
  );
}

export function inspectSetTag(root, version, git = { run: runGit }) {
  const tag = `publish-set-v${version}`;
  const headSha = commitSha(readTagState(git, ["rev-parse", "HEAD"], root, tag), "HEAD");
  const localName = String(readTagState(git, ["tag", "--list", tag], root, tag)).trim();
  if (localName && localName !== tag) fail(`Local tag lookup returned an invalid reference for ${tag}.`, "set-tag-state");
  const localSha = localName
    ? resolveCommit(git, root, tag, tag, `Local tag ${tag}`)
    : null;
  const remoteOutput = readTagState(git, ["ls-remote", "--tags", "origin", `refs/tags/${tag}`, `refs/tags/${tag}^{}`], root, tag);
  const remoteRefs = remoteTagRefs(remoteOutput, tag);
  let remoteSha = null;
  if (remoteRefs.direct) {
    readTagState(git, ["fetch", "--no-tags", "--no-write-fetch-head", "origin", `refs/tags/${tag}`], root, tag);
    remoteSha = resolveCommit(git, root, tag, remoteRefs.direct, `Origin tag ${tag}`);
    const advertisedSha = remoteRefs.peeled ?? remoteRefs.direct;
    if (remoteSha !== advertisedSha) fail(`Origin returned conflicting object state for ${tag}.`, "set-tag-state");
  }
  if (localSha && remoteSha && localSha !== remoteSha) {
    fail(`${tag} resolves to different commits locally and on origin.`, "set-tag-conflict");
  }
  const tagSha = remoteSha ?? localSha;
  return {
    tag,
    headSha,
    localSha,
    remoteSha,
    tagSha,
    status: tagSha === null ? "absent" : tagSha === headSha ? "current" : "occupied",
  };
}

export function readReleaseChanges(root, baselineTag, git = { run: runGit }) {
  if (baselineTag === null) {
    return PUBLISH_SET_ORDER.map(packageKey => PUBLISH_PACKAGES.get(packageKey).path);
  }
  return parseChangedPaths(git.run(["diff", "--name-only", "-z", `${baselineTag}...HEAD`, "--"], root));
}

function ownsPath(entry, changedPath) {
  return changedPath === entry.path || changedPath.startsWith(`${entry.path}/`);
}

function publishedVersions(publishedByName, packageName) {
  const versions = publishedByName.get(packageName);
  if (!Array.isArray(versions)) fail(`Registry versions are unavailable for ${packageName}.`, "registry-lookup");
  return versions;
}

function internalDependencies(manifest, packageByName, fields) {
  const dependencies = [];
  for (const field of fields) {
    for (const [name, specifier] of Object.entries(manifest[field] ?? {})) {
      if (packageByName.has(name)) dependencies.push({ field, name, specifier: String(specifier) });
    }
  }
  return dependencies;
}

export function readWorkspacePatterns(root) {
  const contents = readFileSync(path.join(root, "pnpm-workspace.yaml"), "utf8");
  const lines = contents.split(/\r?\n/);
  const start = lines.findIndex(line => /^packages:\s*$/.test(line));
  if (start < 0) fail("pnpm-workspace.yaml has no packages list.", "workspace-layout");
  const patterns = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const match = /^\s+-\s+["']?([^"']+?)["']?\s*$/.exec(line);
    if (match) patterns.push(match[1]);
  }
  if (patterns.length === 0) fail("pnpm-workspace.yaml has an empty packages list.", "workspace-layout");
  return patterns;
}

// Supports the pattern forms this workspace uses: a folder ("a/b") and the folders in a
// folder ("a/b/*").
export function readWorkspaceManifestPaths(root) {
  const paths = new Set();
  for (const pattern of readWorkspacePatterns(root)) {
    if (pattern.startsWith("!") || path.isAbsolute(pattern) || pattern.includes("..") || /[*?[{]/.test(pattern.replace(/\/\*$/, ""))) {
      fail(`Unsupported workspace package pattern: ${pattern}.`, "workspace-layout");
    }
    const folders = pattern.endsWith("/*")
      ? (existsSync(path.join(root, pattern.slice(0, -2)))
        ? readdirSync(path.join(root, pattern.slice(0, -2)), { withFileTypes: true })
          .filter(entry => entry.isDirectory())
          .map(entry => `${pattern.slice(0, -2)}/${entry.name}`)
        : [])
      : [pattern];
    for (const folder of folders) {
      if (existsSync(path.join(root, folder, "package.json"))) paths.add(`${folder}/package.json`);
    }
  }
  return [...paths].sort();
}

function readWorkspaceManifests(root) {
  return readWorkspaceManifestPaths(root).map(packageJson => ({ packageJson, manifest: readJson(root, packageJson) }));
}

function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(version));
  if (!match) fail(`Registry returned an unsupported semver value: ${version}.`, "registry-version");
  return {
    value: String(version),
    numbers: match.slice(1, 4).map(Number),
    prerelease: match[4]?.split(".") ?? [],
  };
}

function compareIdentifiers(left, right) {
  const leftNumber = /^\d+$/.test(left);
  const rightNumber = /^\d+$/.test(right);
  if (leftNumber && rightNumber) return Number(left) - Number(right);
  if (leftNumber !== rightNumber) return leftNumber ? -1 : 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export function compareVersions(left, right) {
  const parsedLeft = parseVersion(left);
  const parsedRight = parseVersion(right);
  for (let index = 0; index < parsedLeft.numbers.length; index += 1) {
    const difference = parsedLeft.numbers[index] - parsedRight.numbers[index];
    if (difference !== 0) return difference;
  }
  if (parsedLeft.prerelease.length === 0 || parsedRight.prerelease.length === 0) {
    if (parsedLeft.prerelease.length === parsedRight.prerelease.length) return 0;
    return parsedLeft.prerelease.length === 0 ? 1 : -1;
  }
  const count = Math.max(parsedLeft.prerelease.length, parsedRight.prerelease.length);
  for (let index = 0; index < count; index += 1) {
    if (parsedLeft.prerelease[index] === undefined) return -1;
    if (parsedRight.prerelease[index] === undefined) return 1;
    const difference = compareIdentifiers(parsedLeft.prerelease[index], parsedRight.prerelease[index]);
    if (difference !== 0) return difference;
  }
  return 0;
}

// Placeholder versions from the first publish of a name (0.0.0-reserve) never count as the
// latest release of a package.
function releaseVersions(versions) {
  return versions.filter(version => !/-reserve(?:\.|$)/.test(version));
}

function nextVersion(packageName, currentVersion, allVersions) {
  const versions = releaseVersions(allVersions);
  const sorted = [...new Set(versions)].sort(compareVersions);
  const latest = sorted.at(-1);
  if (latest && compareVersions(currentVersion, latest) < 0) {
    fail(`${packageName}@${currentVersion} is behind the published registry version ${latest}.`, "registry-version-drift");
  }
  if (!versions.includes(currentVersion)) return currentVersion;
  if (latest !== currentVersion) {
    fail(`${packageName}@${currentVersion} is not the latest published version (${latest}).`, "registry-version-drift");
  }
  const candidate = bumpPatch(currentVersion);
  if (versions.includes(candidate)) {
    fail(`${packageName}@${candidate} is already published; refusing to skip a release version.`, "registry-version-drift");
  }
  return candidate;
}

export function planReleasePreparation(root, options) {
  const changedPaths = options.changedPaths ?? [];
  const publishedByName = options.publishedByName;
  if (!(publishedByName instanceof Map)) fail("Release preparation requires verified registry version sets.", "registry-lookup");

  const packages = PUBLISH_SET_ORDER.map(packageKey => {
    const catalog = PUBLISH_PACKAGES.get(packageKey);
    const manifest = readJson(root, catalog.packageJson);
    return { packageKey, catalog, manifest, originalVersion: manifest.version };
  });
  const packageByName = new Map(packages.map(entry => [entry.manifest.name, entry]));
  const directKeys = new Set(packages.filter(entry => changedPaths.some(changedPath => ownsPath(entry.catalog, changedPath))).map(entry => entry.packageKey));
  const plannedVersions = new Map(packages.map(entry => [entry.manifest.name, entry.originalVersion]));
  const setTagState = options.setTagState ?? { status: "absent", tag: null };
  if (!new Set(["absent", "current", "occupied"]).has(setTagState.status)) {
    fail("Release preparation received an invalid set tag state.", "set-tag-state");
  }
  const rootManifest = readJson(root, SET_VERSION_FILE);
  const currentSetVersion = rootManifest.version;
  const currentSetTag = `publish-set-v${currentSetVersion}`;
  if (setTagState.status !== "absent" && setTagState.tag !== currentSetTag) {
    fail(`Release preparation tag state does not match ${currentSetTag}.`, "set-tag-state");
  }
  const reports = [];

  for (const entry of packages) {
    const dependencyChanges = [];
    const manifest = structuredClone(entry.manifest);
    let propagated = false;
    for (const dependency of internalDependencies(manifest, packageByName, ALL_FIELDS)) {
      const plannedVersion = plannedVersions.get(dependency.name);
      const dependencyEntry = packageByName.get(dependency.name);
      const workspaceSpecifier = dependency.specifier.startsWith("workspace:");
      if (plannedVersion === dependencyEntry.originalVersion && (workspaceSpecifier || dependency.specifier === plannedVersion)) continue;
      dependencyChanges.push({ field: dependency.field, name: dependency.name, from: dependency.specifier, to: plannedVersion });
      if (!workspaceSpecifier) manifest[dependency.field][dependency.name] = plannedVersion;
      if (RUNTIME_FIELDS.includes(dependency.field)) propagated = true;
    }

    const direct = directKeys.has(entry.packageKey);
    let version = entry.originalVersion;
    if (direct || propagated) {
      version = nextVersion(entry.manifest.name, version, publishedVersions(publishedByName, entry.manifest.name));
    }
    manifest.version = version;
    plannedVersions.set(entry.manifest.name, version);
    reports.push({
      packageKey: entry.packageKey,
      packageName: entry.manifest.name,
      packageJson: entry.catalog.packageJson,
      direct,
      propagated,
      dependencyChanges,
      fromVersion: entry.originalVersion,
      toVersion: version,
      published: publishedVersions(publishedByName, entry.manifest.name).includes(entry.originalVersion),
      manifest,
    });
  }

  const stageOrder = reports
    .filter(entry => !publishedVersions(publishedByName, entry.packageName).includes(entry.toVersion))
    .map(entry => ({ packageKey: entry.packageKey, packageName: entry.packageName, version: entry.toVersion }));

  // A set tag never moves. When the tag of the current set version is already on an older
  // commit and there is something new to stage, the set version advances once.
  const setVersionAdvanced = setTagState.status === "occupied" && stageOrder.length > 0;
  const setVersion = setVersionAdvanced ? bumpPatch(currentSetVersion) : currentSetVersion;

  const versionChanges = reports.filter(entry => entry.fromVersion !== entry.toVersion);
  const publishPaths = new Set(reports.map(report => report.packageJson));
  const workspaceChanges = [];
  for (const workspaceEntry of readWorkspaceManifests(root)) {
    if (publishPaths.has(workspaceEntry.packageJson)) continue;
    if (workspaceEntry.packageJson === SET_VERSION_FILE) continue;
    const manifest = structuredClone(workspaceEntry.manifest);
    const dependencyChanges = [];
    for (const dependency of internalDependencies(manifest, packageByName, ALL_FIELDS)) {
      const plannedVersion = plannedVersions.get(dependency.name);
      if (dependency.specifier.startsWith("workspace:") || dependency.specifier === plannedVersion) continue;
      manifest[dependency.field][dependency.name] = plannedVersion;
      dependencyChanges.push({ field: dependency.field, name: dependency.name, from: dependency.specifier, to: plannedVersion });
    }
    if (dependencyChanges.length > 0) {
      workspaceChanges.push({ packageJson: workspaceEntry.packageJson, dependencyChanges, manifest });
    }
  }
  const manifestChanges = reports.filter(entry => (
    JSON.stringify(entry.manifest) !== JSON.stringify(readJson(root, entry.packageJson))
  ));
  return {
    baselineTag: options.baselineTag ?? null,
    baselineSha: options.baselineSha ?? null,
    setVersion,
    setTag: `publish-set-v${setVersion}`,
    replacesSetTag: setVersionAdvanced ? currentSetTag : null,
    setTagState: setTagState.status,
    changedPaths: [...changedPaths],
    directPackages: reports.filter(entry => entry.direct).map(entry => entry.packageKey),
    propagatedPackages: reports.filter(entry => entry.propagated).map(entry => entry.packageKey),
    versionChanges: versionChanges.map(entry => ({ packageKey: entry.packageKey, packageName: entry.packageName, from: entry.fromVersion, to: entry.toVersion })),
    setVersionChange: setVersionAdvanced ? { from: currentSetVersion, to: setVersion } : null,
    stageOrder,
    needsWrite: manifestChanges.length > 0 || workspaceChanges.length > 0 || setVersionAdvanced,
    reports,
    workspaceChanges,
  };
}

function updateLockfile(root, runner = spawnSync) {
  const pnpmArgs = ["install", "--lockfile-only", "--ignore-scripts", "--config.verify-deps-before-run=false"];
  const windows = process.platform === "win32";
  const command = windows ? "cmd.exe" : "pnpm";
  const args = windows ? ["/d", "/s", "/c", `pnpm.cmd ${pnpmArgs.join(" ")}`] : pnpmArgs;
  const result = runner(command, args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    const detail = result.error?.message ? ` (${result.error.message})` : "";
    fail(`The lockfile update failed${detail}; the generated release files were rolled back.`, "workspace-install");
  }
}

function snapshotFiles(root, relativePaths) {
  return new Map(relativePaths.map(relativePath => {
    const filePath = resolveInside(root, relativePath);
    return [relativePath, existsSync(filePath) ? readFileSync(filePath) : null];
  }));
}

function restoreFiles(root, snapshots) {
  for (const [relativePath, contents] of snapshots) {
    const filePath = resolveInside(root, relativePath);
    if (contents === null) rmSync(filePath, { force: true });
    else replaceFile(filePath, contents);
  }
}

export function applyReleasePreparation(root, plan, options = {}) {
  if (!plan.needsWrite) return { ...plan, wrote: false };
  const reportsByKey = new Map((plan.reports ?? []).map(report => [report.packageKey, report]));
  const reports = PUBLISH_SET_ORDER.map(packageKey => {
    const report = reportsByKey.get(packageKey);
    const catalog = PUBLISH_PACKAGES.get(packageKey);
    if (!report || report.packageJson !== catalog.packageJson) {
      fail(`Release preparation report is incomplete for ${packageKey}.`, "invalid-preparation");
    }
    return report;
  });
  const mutablePaths = [
    ...reports.map(report => report.packageJson),
    ...plan.workspaceChanges.map(change => change.packageJson),
    SET_VERSION_FILE,
    "pnpm-lock.yaml",
  ];
  const snapshots = snapshotFiles(root, [...new Set(mutablePaths)]);
  try {
    for (const report of reports) {
      if (JSON.stringify(report.manifest) !== JSON.stringify(readJson(root, report.packageJson))) {
        writeJson(root, report.packageJson, report.manifest);
      }
    }
    for (const change of plan.workspaceChanges) {
      writeJson(root, change.packageJson, change.manifest);
    }
    const rootManifest = readJson(root, SET_VERSION_FILE);
    if (rootManifest.version !== plan.setVersion) {
      writeJson(root, SET_VERSION_FILE, { ...rootManifest, version: plan.setVersion });
    }
    if (options.updateLockfile !== false) updateLockfile(root, options.runner);
  } catch (error) {
    try {
      restoreFiles(root, snapshots);
    } catch (restoreError) {
      throw Object.assign(new AggregateError([error, restoreError], "Release preparation failed and generated file rollback was incomplete."), {
        reasonCode: "rollback-failed",
      });
    }
    throw error;
  }
  return { ...plan, wrote: true };
}

function summarize(plan, extra) {
  return {
    ok: true,
    ...extra,
    ...plan,
    reports: undefined,
    workspaceChanges: plan.workspaceChanges.map(change => ({ packageJson: change.packageJson, dependencyChanges: change.dependencyChanges })),
  };
}

export async function prepareRelease(options = {}) {
  const root = resolveRepoRoot(options.repoRoot ?? DEFAULT_ROOT);
  const git = options.git ?? { run: runGit };
  const baseline = options.baseline ?? resolveReleaseBaseline(root, git, { excludeTag: options.excludeBaselineTag });
  const changedPaths = options.changedPaths ?? readReleaseChanges(root, baseline.baselineTag, git);
  const setVersion = readJson(root, SET_VERSION_FILE).version;
  const setTagState = options.setTagState ?? inspectSetTag(root, setVersion, git);
  const resolved = await resolvePublishTag(`publish-set-v${setVersion}`, root);
  const publishedByName = options.publishedByName ?? await readPublishedVersionsForPlan(resolved, options);
  const plan = planReleasePreparation(root, { ...baseline, changedPaths, publishedByName, setTagState });
  if (!options.write) return summarize(plan, { dryRun: true, wrote: false });
  return summarize(applyReleasePreparation(root, plan, options), { dryRun: false });
}

function parseArgs(argv) {
  const options = { write: false, json: false };
  for (const token of argv) {
    if (token === "--write") options.write = true;
    else if (token === "--dry-run") options.write = false;
    else if (token === "--json") options.json = true;
    else if (token === "--help" || token === "-h") options.help = true;
    else if (token === "--") continue;
    else fail(`Unknown argument: ${token}`, "usage");
  }
  return options;
}

export function formatReport(report) {
  const lines = [];
  lines.push(`${report.dryRun ? "Dry run" : report.wrote ? "Wrote the release preparation" : "Nothing to write"} for ${report.setTag}`);
  lines.push(`Baseline: ${report.baselineTag ?? "none (first release: every package counts as changed)"}`);
  lines.push(`Set tag state: ${report.setTagState}${report.replacesSetTag ? ` (replaces ${report.replacesSetTag})` : ""}`);
  if (report.setVersionChange) lines.push(`Set version: ${report.setVersionChange.from} -> ${report.setVersionChange.to}`);
  if (report.versionChanges.length === 0) lines.push("Version changes: none");
  for (const change of report.versionChanges) lines.push(`Version change: ${change.packageName} ${change.from} -> ${change.to}`);
  lines.push(`Stage order (${report.stageOrder.length}):`);
  report.stageOrder.forEach((entry, index) => lines.push(`  ${index + 1}. ${entry.packageName}@${entry.version}`));
  lines.push(report.needsWrite ? "Needs write: yes (run pnpm release:prepare --write, review and merge)" : "Needs write: no");
  return `${lines.join("\n")}\n`;
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArgs(argv);
    if (options.help) {
      process.stdout.write("Usage: node scripts/prepare-release.mjs [--dry-run|--write] [--json]\n");
      return;
    }
    const report = await prepareRelease(options);
    process.stdout.write(options.json ? `${JSON.stringify(report)}\n` : formatReport(report));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = error?.reasonCode === "usage" ? 2 : 1;
  }
}

const invoked = process.argv[1] && path.normalize(process.argv[1]) === path.normalize(fileURLToPath(import.meta.url));
if (invoked) await main();
