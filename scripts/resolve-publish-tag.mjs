import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  finalizePublishPlan,
  inspectRetryContents,
  internalRuntimeDependencies,
  readRegistryPackage,
  readRegistryPackagesForPlan,
  repoRootFrom,
  resolvePublishTag,
} from "./publish-packages.mjs";
import { prepareRelease } from "./prepare-release.mjs";

function runGit(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true, timeout: 30_000 });
  if (result.status !== 0) {
    throw Object.assign(new Error((result.stderr ?? "").trim() || `git ${args.join(" ")} failed.`), {
      reasonCode: "retry-base",
    });
  }
  return String(result.stdout ?? "").trim();
}

export function inspectRetryPublishTag(resolved, root, git = { run: runGit }) {
  if (!resolved.retry) return null;
  const originalTag = `publish-set-v${resolved.setVersion}`;
  let originalCommit;
  try {
    originalCommit = git.run(["rev-parse", `${originalTag}^{commit}`], root);
    git.run(["merge-base", "--is-ancestor", originalCommit, "HEAD"], root);
  } catch (error) {
    throw Object.assign(new Error(`Retry tag requires ${originalTag} as an immutable ancestor.`), {
      reasonCode: "retry-base",
      cause: error,
    });
  }
  return { originalTag, originalCommit };
}

// A single-package tag stages one package against versions of the other packages that are
// already public: every workspace package it depends on must be on npm at the exact version.
export async function requirePublishedDependencies(entry, root, options = {}) {
  const dependencies = await internalRuntimeDependencies(entry, root);
  const missing = [];
  for (const dependency of dependencies) {
    const versions = options.publishedByName?.get(dependency.name)
      ?? (await readRegistryPackage(dependency.name, options)).versions;
    if (!versions.includes(dependency.version)) missing.push(`${dependency.name}@${dependency.version}`);
  }
  if (missing.length > 0) {
    throw Object.assign(new Error(`${entry.packageName}@${entry.version} depends on versions that are not on npm: ${missing.join(", ")}. Release them first, or use a set tag.`), {
      reasonCode: "dependency-unpublished",
    });
  }
}

export async function resolvePublishPlan(tag, options = {}) {
  const root = options.root ?? repoRootFrom(import.meta.url);
  const resolved = await resolvePublishTag(tag, root);
  const registryPackages = options.registryPackages ?? (options.publishedByName
    ? new Map(resolved.packages.map(entry => [entry.packageName, {
      packageName: entry.packageName,
      exists: !(options.missingPackageNames ?? []).includes(entry.packageName),
      versions: options.publishedByName.get(entry.packageName) ?? [],
    }]))
    : await readRegistryPackagesForPlan(resolved, options));
  const missing = resolved.packages.filter(entry => registryPackages.get(entry.packageName)?.exists !== true);
  if (missing.length > 0) {
    throw Object.assign(new Error(`npm staged publishing cannot create package names: ${missing.map(entry => entry.packageName).join(", ")}. Complete the one-time first publish (scripts/reserve-package-name.mjs) first.`), {
      reasonCode: "package-bootstrap",
    });
  }
  const publishedByName = options.publishedByName ?? new Map(
    [...registryPackages].map(([packageName, entry]) => [packageName, entry.versions])
  );
  if (resolved.mode === "set" && resolved.retry === null) {
    const preparation = await (options.prepareRelease ?? prepareRelease)({
      repoRoot: root,
      publishedByName,
      excludeBaselineTag: tag,
      setTagState: { status: "current", tag },
    });
    if (preparation.needsWrite) {
      throw Object.assign(new Error("The set tag contains an incomplete release preparation."), {
        reasonCode: "release-unprepared",
      });
    }
  }
  if (resolved.mode === "package") {
    await requirePublishedDependencies(resolved.packages[0], root, options);
  }
  if (resolved.retry !== null) {
    const retryBase = inspectRetryPublishTag(resolved, root, options.git);
    inspectRetryContents(resolved, retryBase.originalCommit, root, options.git ?? { run: runGit });
  }
  const plan = finalizePublishPlan(resolved, publishedByName);
  if (resolved.retry !== null && plan.skipped.length === 0) {
    throw Object.assign(new Error(`Retry is unnecessary because no versions from publish-set-v${resolved.setVersion} are public.`), {
      reasonCode: "retry-unnecessary",
    });
  }
  return plan;
}

export async function main(tag = process.argv[2] ?? "") {
  const plan = await resolvePublishPlan(tag);
  const first = plan.packages[0];
  process.stdout.write(`${JSON.stringify({
    mode: plan.mode,
    setVersion: plan.setVersion,
    packageKey: first?.packageKey,
    packageName: first?.packageName,
    version: first?.version,
    filter: first?.filter,
    path: first?.path,
    prepare: plan.prepare,
    verify: plan.verify,
    packages: plan.packages,
    verifyPackages: plan.verifyPackages,
    skipped: plan.skipped,
  })}\n`);
}

const invoked = process.argv[1] && path.normalize(process.argv[1]) === path.normalize(fileURLToPath(import.meta.url));
if (invoked) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
