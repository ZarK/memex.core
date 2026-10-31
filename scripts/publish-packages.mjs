import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Every public package of this repository, in release order: a package comes after every
// package of this repository that it depends on (dependencies, peer and dev dependencies).
// scripts/check-release-manifests.mjs fails when this list and the workspace disagree.
export const RELEASE_PACKAGES = Object.freeze([
  { key: "memex-sqlite", path: "packages/sqlite", commands: [] },
  { key: "memex-schema", path: "packages/schema", commands: [] },
  { key: "memex-storage", path: "packages/storage", commands: [] },
  { key: "memex-archive", path: "packages/archive", commands: ["memex-archive"] },
  { key: "memex-folders", path: "packages/folders", commands: ["memex-folders"] },
  { key: "memex-import", path: "packages/import", commands: ["memex-import"] },
  { key: "memex-facts", path: "packages/facts", commands: ["memex-facts"] },
  { key: "memex-handles", path: "packages/handles", commands: [] },
  { key: "memex-licenses", path: "packages/licenses", commands: ["memex-licenses"] },
  { key: "memex-surfaces", path: "packages/surfaces", commands: ["memex-surfaces"] },
  { key: "memex-node-client", path: "packages/node-client", commands: [] },
  { key: "memex-packs", path: "packages/packs", commands: [] },
  { key: "memex-node-ui", path: "packages/node-ui", commands: [] },
  { key: "memex-user-client", path: "packages/user-client", commands: [] },
  // The main entry imports Electron, a peer dependency; the installed check imports the
  // server and build entries instead.
  { key: "memex-desktop", path: "packages/desktop", commands: ["memex-desktop"], imports: ["./server", "./build"] },
].map(entry => Object.freeze({
  ...entry,
  name: `@tjalve/${entry.key}`,
  packageJson: `${entry.path}/package.json`,
  commands: Object.freeze([...entry.commands]),
  imports: Object.freeze([...(entry.imports ?? ["."])]),
})));

function packageEntry(entry) {
  return Object.freeze({
    filter: entry.name,
    path: entry.path,
    packageJson: entry.packageJson,
    // The package and every workspace package it depends on.
    prepare: `pnpm --filter ${entry.name}... run build`,
    verify: `pnpm --filter ${entry.name} run typecheck && pnpm --filter ${entry.name} test && node scripts/check-release-manifests.mjs`,
    commands: entry.commands,
    imports: entry.imports,
  });
}

export const PUBLISH_PACKAGES = Object.freeze(new Map(RELEASE_PACKAGES.map(entry => [entry.key, packageEntry(entry)])));

export const PUBLISH_SET_ORDER = Object.freeze(RELEASE_PACKAGES.map(entry => entry.key));

export const SET_PREPARE = "pnpm run build";
export const SET_VERIFY = "pnpm run typecheck && pnpm run test && node scripts/check-release-manifests.mjs";

// The set version is the version of the private root package.json. It names the set tag
// publish-set-v<version>, and pnpm release:prepare advances it once per new set.
export const SET_VERSION_FILE = "package.json";

const PACKAGE_TAG = /^publish-([a-z0-9-]+)-v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/;

export function repoRootFrom(moduleUrl = import.meta.url) {
  return path.resolve(path.dirname(fileURLToPath(moduleUrl)), "..");
}

export async function readPackageJson(relativePath, root = ROOT) {
  return JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
}

export async function readSetVersion(root = ROOT) {
  const manifest = await readPackageJson(SET_VERSION_FILE, root);
  if (manifest.private !== true || typeof manifest.version !== "string" || manifest.version === "") {
    fail(`${SET_VERSION_FILE} must be private and carry the set version.`);
  }
  return manifest.version;
}

function fail(message) {
  const error = new Error(message);
  error.reasonCode = "publish-tag";
  throw error;
}

export function parseSetPublishTag(tag, setVersion) {
  const originalTag = `publish-set-v${setVersion}`;
  if (tag === originalTag) {
    return Object.freeze({ setVersion, retry: null, originalTag });
  }
  const escapedTag = originalTag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const retryMatch = new RegExp(`^${escapedTag}-retry\\.([1-9][0-9]*)$`).exec(tag ?? "");
  if (!retryMatch) return null;
  return Object.freeze({
    setVersion,
    retry: Number(retryMatch[1]),
    originalTag,
  });
}

async function packagePlan(key, root) {
  const entry = PUBLISH_PACKAGES.get(key);
  if (!entry) fail(`Unknown package key "${key}". Valid keys: ${[...PUBLISH_PACKAGES.keys()].join(", ")}.`);
  const packageJson = await readPackageJson(entry.packageJson, root);
  if (packageJson.name !== entry.filter) {
    fail(`${entry.packageJson} declares ${packageJson.name ?? "no package name"}; expected ${entry.filter}.`);
  }
  return Object.freeze({
    packageKey: key,
    packageName: packageJson.name,
    version: packageJson.version,
    filter: entry.filter,
    path: entry.path,
    inputs: [entry.path],
    packageJson: entry.packageJson,
    prepare: entry.prepare,
    verify: entry.verify,
    commands: [...entry.commands],
    imports: [...entry.imports],
  });
}

export async function resolvePublishTag(tag, root = ROOT) {
  if (String(tag ?? "").startsWith("publish-set-v")) {
    const version = await readSetVersion(root);
    const setTag = parseSetPublishTag(tag, version);
    if (!setTag) {
      fail(`Publish tag "${tag}" does not match the set version ${version} in ${SET_VERSION_FILE}.`);
    }
    const { setVersion, retry } = setTag;
    const packages = [];
    for (const key of PUBLISH_SET_ORDER) {
      packages.push(await packagePlan(key, root));
    }
    return Object.freeze({
      mode: "set",
      setVersion,
      retry,
      prepare: SET_PREPARE,
      verify: SET_VERIFY,
      packages,
    });
  }

  const match = PACKAGE_TAG.exec(tag ?? "");
  if (!match) {
    fail(`Invalid publish tag "${tag}". Expected publish-<package>-v<version>, publish-set-v<setVersion>, or publish-set-v<setVersion>-retry.<number>.`);
  }
  const [, packageKey, tagVersion] = match;
  if (packageKey === "set") {
    fail(`Invalid publish tag "${tag}". Expected publish-set-v<setVersion>.`);
  }
  const planned = await packagePlan(packageKey, root);
  if (planned.version !== tagVersion) {
    fail(`Tag version ${tagVersion} does not match ${planned.packageJson} version ${planned.version}.`);
  }
  return Object.freeze({
    mode: "package",
    setVersion: null,
    retry: null,
    prepare: planned.prepare,
    verify: planned.verify,
    packages: [planned],
  });
}

// The exact versions of the workspace packages a package depends on at run time, as the
// published manifest will name them.
export async function internalRuntimeDependencies(entry, root = ROOT) {
  const manifest = await readPackageJson(entry.packageJson, root);
  const names = new Set(RELEASE_PACKAGES.map(candidate => candidate.name));
  const result = [];
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    for (const [name, specifier] of Object.entries(manifest[field] ?? {})) {
      if (!names.has(name)) continue;
      const catalog = RELEASE_PACKAGES.find(candidate => candidate.name === name);
      const version = String(specifier).startsWith("workspace:")
        ? (await readPackageJson(catalog.packageJson, root)).version
        : String(specifier);
      result.push({ field, name, version });
    }
  }
  return result;
}

export function registryPackageUrl(packageName, registry = "https://registry.npmjs.org/") {
  const base = String(registry).endsWith("/") ? registry : `${registry}/`;
  return `${base}${String(packageName).replace("/", "%2f")}`;
}

export async function readPublishedVersions(packageName, options = {}) {
  return (await readRegistryPackage(packageName, options)).versions;
}

export function inspectRetryContents(plan, originalCommit, root, git) {
  const inputs = [...new Set((plan.packages ?? []).flatMap(entry => entry.inputs ?? [entry.path]))];
  if (inputs.length === 0) fail("Retry publish plan has no package inputs.");
  try {
    git.run(["diff", "--quiet", `${originalCommit}..HEAD`, "--", ...inputs], root);
  } catch (error) {
    throw Object.assign(new Error("Publishable package contents changed after the original set tag; prepare a new release instead of retrying the old set."), {
      reasonCode: "retry-content-drift",
      cause: error,
    });
  }
}

export async function readRegistryPackage(packageName, options = {}) {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const url = registryPackageUrl(packageName, options.registry);
  let response;
  try {
    response = await fetchImpl(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
  } catch (error) {
    throw Object.assign(
      new Error(`Registry lookup for ${packageName} failed.`),
      { reasonCode: "registry-lookup", cause: error }
    );
  }
  if (response.status === 404) return Object.freeze({ packageName, exists: false, versions: Object.freeze([]) });
  if (!response.ok) {
    throw Object.assign(
      new Error(`Registry lookup for ${packageName} failed (${response.status}).`),
      { reasonCode: "registry-lookup" }
    );
  }
  let body;
  try {
    body = await response.json();
  } catch (error) {
    throw Object.assign(
      new Error(`Registry lookup for ${packageName} failed.`),
      { reasonCode: "registry-lookup", cause: error }
    );
  }
  return Object.freeze({
    packageName,
    exists: true,
    versions: Object.freeze(Object.keys(body.versions ?? {})),
  });
}

export async function readRegistryPackagesForPlan(plan, options = {}) {
  const packageNames = [...new Set((plan.packages ?? []).map(entry => entry.packageName))];
  const packages = await Promise.all(packageNames.map(packageName => readRegistryPackage(packageName, options)));
  return new Map(packages.map(entry => [entry.packageName, entry]));
}

export async function readPublishedVersionsForPlan(plan, options = {}) {
  const packages = await readRegistryPackagesForPlan(plan, options);
  return new Map([...packages].map(([packageName, entry]) => [packageName, entry.versions]));
}

function failFinalize(message, reasonCode) {
  const error = new Error(message);
  error.reasonCode = reasonCode;
  throw error;
}

export function finalizePublishPlan(plan, publishedByName) {
  if (!plan || !Array.isArray(plan.packages) || plan.packages.length === 0) {
    failFinalize("Publish plan has no packages.", "empty-plan");
  }
  const publishedMap = publishedByName instanceof Map
    ? publishedByName
    : new Map(Object.entries(publishedByName ?? {}));

  if (plan.mode === "package") {
    const entry = plan.packages[0];
    const published = publishedMap.get(entry.packageName) ?? [];
    if (published.includes(entry.version)) {
      failFinalize(`${entry.packageName}@${entry.version} is already on npm.`, "already-published");
    }
    return Object.freeze({
      ...plan,
      packages: Object.freeze([...plan.packages]),
      verifyPackages: Object.freeze([...plan.packages]),
      skipped: Object.freeze([]),
    });
  }

  const selected = [];
  const skipped = [];
  for (const entry of plan.packages) {
    const published = publishedMap.get(entry.packageName) ?? [];
    if (published.includes(entry.version)) {
      skipped.push(Object.freeze({ ...entry, skipReason: "already-published" }));
    } else {
      selected.push(entry);
    }
  }
  if (selected.length === 0) {
    failFinalize("Publish set has no unpublished packages.", "nothing-to-publish");
  }
  return Object.freeze({
    ...plan,
    packages: Object.freeze(selected),
    verifyPackages: Object.freeze([...plan.packages]),
    skipped: Object.freeze(skipped),
  });
}
