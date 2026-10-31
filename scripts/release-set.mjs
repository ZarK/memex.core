import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { finalizePublishPlan, inspectRetryContents, readRegistryPackagesForPlan, readSetVersion, resolvePublishTag } from "./publish-packages.mjs";
import { inspectSetTag, planReleasePreparation, readReleaseChanges, resolveReleaseBaseline, resolveRepoRoot } from "./prepare-release.mjs";

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function parseReleaseArgs(argv) {
  const options = {
    help: false,
    json: false,
    dryRun: false,
    retry: false,
    repoRoot: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") options.help = true;
    else if (token === "--json") options.json = true;
    else if (token === "--dry-run") options.dryRun = true;
    else if (token === "--retry") options.retry = true;
    else if (token === "--") continue;
    else if (token === "--repo-root") {
      index += 1;
      const value = argv[index];
      if (!value || value.startsWith("-")) {
        throw Object.assign(new Error("--repo-root requires a value."), { reasonCode: "usage" });
      }
      options.repoRoot = value;
    } else {
      throw Object.assign(new Error(`Unknown argument: ${token}`), { reasonCode: "usage" });
    }
  }
  return options;
}

function runGit(args, cwd) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
  });
  if (result.status !== 0) {
    throw Object.assign(
      new Error((result.stderr ?? "").trim() || `git ${args.join(" ")} failed.`),
      { reasonCode: "git" }
    );
  }
  return (result.stdout ?? "").trim();
}

export function inspectReleaseCheckout(root, git = { run: runGit }) {
  const branch = git.run(["rev-parse", "--abbrev-ref", "HEAD"], root);
  if (branch !== "main") {
    throw Object.assign(new Error(`Release requires branch main, found ${branch}.`), {
      reasonCode: "not-main",
    });
  }
  const status = git.run(["status", "--porcelain", "--untracked-files=normal"], root);
  if (status.length > 0) {
    throw Object.assign(new Error("Release requires a clean tracked working tree on main."), {
      reasonCode: "dirty-worktree",
    });
  }
  const head = git.run(["rev-parse", "HEAD"], root);
  const originMain = git.run(["rev-parse", "origin/main"], root);
  if (head !== originMain) {
    throw Object.assign(new Error("Release requires HEAD to match origin/main."), {
      reasonCode: "main-stale",
    });
  }
  return { branch, head };
}

function lines(value) {
  return String(value).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}

function remoteTagCommit(output, tag) {
  const refs = new Map(lines(output).map(line => {
    const [sha, ref] = line.split(/\s+/, 2);
    return [ref, sha];
  }));
  return refs.get(`refs/tags/${tag}^{}`) ?? refs.get(`refs/tags/${tag}`) ?? null;
}

export function planRetryTag(root, setVersion, git = { run: runGit }) {
  const originalTag = `publish-set-v${setVersion}`;
  const originalRemote = git.run([
    "ls-remote", "--tags", "origin", `refs/tags/${originalTag}`, `refs/tags/${originalTag}^{}`,
  ], root);
  const originalCommit = remoteTagCommit(originalRemote, originalTag);
  if (!originalCommit) {
    throw Object.assign(new Error(`Retry requires the immutable original tag ${originalTag} on origin.`), {
      reasonCode: "retry-base",
    });
  }
  const localOriginal = git.run(["tag", "--list", originalTag], root);
  if (localOriginal) {
    const localCommit = git.run(["rev-parse", `${originalTag}^{commit}`], root);
    if (localCommit !== originalCommit) {
      throw Object.assign(new Error(`${originalTag} differs between the local repository and origin.`), {
        reasonCode: "tag-mismatch",
      });
    }
  }
  try {
    git.run(["merge-base", "--is-ancestor", originalCommit, "origin/main"], root);
  } catch (error) {
    throw Object.assign(new Error(`${originalTag} is not an ancestor of origin/main.`), {
      reasonCode: "retry-base",
      cause: error,
    });
  }

  const prefix = `${originalTag}-retry.`;
  const localRetries = lines(git.run(["tag", "--list", `${prefix}*`], root));
  const remoteRetries = lines(git.run(["ls-remote", "--tags", "origin", `refs/tags/${prefix}*`], root))
    .map(line => line.split(/\s+/, 2)[1]?.replace("refs/tags/", "").replace(/\^\{\}$/, ""))
    .filter(Boolean);
  const retryPattern = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([1-9][0-9]*)$`);
  const used = new Set([...localRetries, ...remoteRetries].map(tag => retryPattern.exec(tag)?.[1]).filter(Boolean).map(Number));
  const retry = used.size === 0 ? 1 : Math.max(...used) + 1;
  return { originalTag, originalCommit, retry, tag: `${prefix}${retry}` };
}

function registryPackagesFromVersions(plan, publishedByName, missingPackageNames = []) {
  const missing = new Set(missingPackageNames);
  return new Map(plan.packages.map(entry => [entry.packageName, Object.freeze({
    packageName: entry.packageName,
    exists: !missing.has(entry.packageName),
    versions: Object.freeze([...(publishedByName.get(entry.packageName) ?? [])]),
  })]));
}

export function missingPackageNames(plan, registryPackages) {
  return plan.packages
    .filter(entry => registryPackages.get(entry.packageName)?.exists !== true)
    .map(entry => ({ packageKey: entry.packageKey, packageName: entry.packageName, path: entry.path, version: entry.version }));
}

export function bootstrapError(missing) {
  const details = missing.map(entry => `- ${entry.packageName} from ${entry.path} (target ${entry.version})`).join("\n");
  return Object.assign(new Error(
    `npm staged publishing cannot create a package name. For each package below, the owner runs the one-time first publish (node scripts/reserve-package-name.mjs ${missing[0]?.packageKey ?? "<package>"}), configures its stage-only trusted publisher, waits until npm registry lookup succeeds, and reruns the release:\n${details}`
  ), { reasonCode: "package-bootstrap", packages: missing });
}

export async function planRelease(options = {}) {
  const root = resolveRepoRoot(options.repoRoot ?? DEFAULT_ROOT);
  const setVersion = await readSetVersion(root);
  const originalTag = `publish-set-v${setVersion}`;
  const git = options.git ?? { run: runGit };
  const retryPlan = options.retry ? planRetryTag(root, setVersion, git) : null;
  const tag = retryPlan?.tag ?? originalTag;
  const resolved = await resolvePublishTag(tag, root);
  if (retryPlan) inspectRetryContents(resolved, retryPlan.originalCommit, root, git);
  const registryPackages = options.registryPackages
    ?? (options.publishedByName
      ? registryPackagesFromVersions(resolved, options.publishedByName, options.missingPackageNames)
      : await readRegistryPackagesForPlan(resolved, options));
  const missing = missingPackageNames(resolved, registryPackages);
  if (missing.length > 0 && !options.dryRun) throw bootstrapError(missing);
  const publishedByName = options.publishedByName ?? new Map(
    [...registryPackages].map(([packageName, entry]) => [packageName, entry.versions])
  );
  let preparation = options.preparation ?? null;
  let baseline = options.baseline ?? null;
  if (!options.retry) {
    baseline = baseline ?? (preparation ? null : resolveReleaseBaseline(root, git));
    preparation = preparation ?? planReleasePreparation(root, {
      ...baseline,
      changedPaths: options.changedPaths ?? readReleaseChanges(root, baseline.baselineTag, git),
      publishedByName,
      setTagState: options.setTagState ?? inspectSetTag(root, setVersion, git),
    });
    if (preparation.needsWrite) {
      throw Object.assign(new Error("Release preparation is incomplete. Run `pnpm release:prepare --write`, review and merge the generated changes, then release from clean current main."), {
        reasonCode: "release-unprepared",
      });
    }
  }
  const plan = finalizePublishPlan(resolved, publishedByName);
  if (options.retry && plan.skipped.length === 0) {
    throw Object.assign(new Error(`Retry is unnecessary because no versions from ${originalTag} are public.`), {
      reasonCode: "retry-unnecessary",
    });
  }
  return {
    tag,
    originalTag,
    retry: retryPlan?.retry ?? null,
    setVersion,
    baselineTag: preparation?.baselineTag ?? baseline?.baselineTag ?? retryPlan?.originalTag ?? null,
    packages: plan.packages.map(entry => ({
      packageKey: entry.packageKey,
      packageName: entry.packageName,
      version: entry.version,
    })),
    skipped: (plan.skipped ?? []).map(entry => ({
      packageKey: entry.packageKey,
      packageName: entry.packageName,
      version: entry.version,
      skipReason: entry.skipReason,
    })),
    missingNames: missing,
  };
}

export async function runRelease(options = {}) {
  if (options.dryRun) {
    const planned = await planRelease(options);
    return { ok: planned.missingNames.length === 0, dryRun: true, pushed: false, ...planned };
  }
  const root = resolveRepoRoot(options.repoRoot ?? DEFAULT_ROOT);
  const git = options.git ?? { run: runGit };
  const checkout = inspectReleaseCheckout(root, git);
  const planned = await planRelease({ ...options, repoRoot: root, git });
  const existing = git.run(["tag", "--list", planned.tag], root);
  if (!existing) {
    git.run(["tag", "-s", planned.tag, "-m", `Publish set ${planned.setVersion}`], root);
  } else {
    const tagCommit = git.run(["rev-parse", `${planned.tag}^{}`], root);
    if (tagCommit !== checkout.head) {
      throw Object.assign(new Error(`${planned.tag} already exists at ${tagCommit}; refusing to move an immutable release tag.`), {
        reasonCode: "tag-mismatch",
      });
    }
  }
  git.run(["push", "origin", planned.tag], root);
  return { ok: true, dryRun: false, pushed: true, ...planned };
}

function printHelp() {
  process.stdout.write(`Usage: node scripts/release-set.mjs [--retry] [--dry-run] [--json]

Create and push the signed tag publish-set-v<setVersion> from a clean current main.
The set version is the version in the root package.json.
Use --retry after part of an immutable set is public; it creates a new
publish-set-v<setVersion>-retry.<number> tag for only the remaining versions.
CI then stages every workspace version that is not already on npm. Run
pnpm run release:approve -- <tag> after the workflow succeeds.
`);
}

export function formatRelease(report) {
  const out = [];
  out.push(report.tag);
  if (report.retry) out.push(`retry ${report.retry} of ${report.originalTag}`);
  out.push(`baseline ${report.baselineTag ?? "none (first release)"}`);
  out.push(`stage (${report.packages.length}, in this order):`);
  report.packages.forEach((entry, index) => out.push(`  ${index + 1}. ${entry.packageName}@${entry.version}`));
  if (report.skipped.length > 0) {
    out.push(`skip ${report.skipped.map(entry => `${entry.packageName}@${entry.version}`).join(", ")}`);
  }
  if (report.missingNames?.length > 0) {
    out.push(`not on npm yet (${report.missingNames.length}); each needs its first publish (scripts/reserve-package-name.mjs) and its stage-only trusted publisher before this set can be tagged:`);
    for (const entry of report.missingNames) out.push(`  - ${entry.packageName}`);
  }
  out.push(report.dryRun ? "dry-run: tag not created, nothing pushed" : "pushed set tag");
  return `${out.join("\n")}\n`;
}

export async function main(argv = process.argv.slice(2)) {
  let parsed;
  try {
    parsed = parseReleaseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
    return;
  }
  if (parsed.help) {
    printHelp();
    return;
  }
  try {
    const report = await runRelease(parsed);
    process.stdout.write(parsed.json ? `${JSON.stringify(report)}\n` : formatRelease(report));
    // A dry run that a real release would refuse exits non-zero.
    if (!report.ok) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = error?.reasonCode === "usage" ? 2 : 1;
  }
}

const invoked = process.argv[1] && path.normalize(process.argv[1]) === path.normalize(fileURLToPath(import.meta.url));
if (invoked) {
  await main();
}
