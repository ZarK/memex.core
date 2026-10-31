import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { RELEASE_PACKAGES, SET_VERSION_FILE } from "./publish-packages.mjs";
import { readWorkspaceManifestPaths } from "./prepare-release.mjs";

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPOSITORY_URL = "git+https://github.com/ZarK/memex.core.git";
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
// Scripts that npm or pnpm would run when the package is installed or packed.
const LIFECYCLE_SCRIPTS = Object.freeze([
  "preinstall", "install", "postinstall", "prepare", "prepublish", "prepublishOnly", "prepack", "postpack",
]);
const ORDER_FIELDS = Object.freeze(["dependencies", "optionalDependencies", "peerDependencies", "devDependencies"]);

function readJson(root, relativePath) {
  return JSON.parse(readFileSync(path.join(root, relativePath), "utf8"));
}

// Checks that the release catalog in publish-packages.mjs matches the workspace: every
// public workspace package is in it once, in an order where each package comes after the
// packages of this repository it depends on, with the fields a public package needs.
export function collectReleaseManifestFailures(root = DEFAULT_ROOT, catalog = RELEASE_PACKAGES) {
  const failures = [];
  const rootManifest = readJson(root, SET_VERSION_FILE);
  if (rootManifest.private !== true) failures.push(`${SET_VERSION_FILE}: the root package must be private.`);
  if (!SEMVER.test(String(rootManifest.version ?? ""))) failures.push(`${SET_VERSION_FILE}: version must hold the set version.`);

  const catalogPaths = new Set(catalog.map(entry => entry.packageJson));
  for (const packageJson of readWorkspaceManifestPaths(root)) {
    const manifest = readJson(root, packageJson);
    if (manifest.private === true) {
      if (catalogPaths.has(packageJson)) failures.push(`${packageJson}: a private package cannot be released.`);
      continue;
    }
    if (!catalogPaths.has(packageJson)) {
      failures.push(`${packageJson}: public workspace package ${manifest.name} is missing from the release catalog in scripts/publish-packages.mjs.`);
    }
  }

  const position = new Map(catalog.map((entry, index) => [entry.name, index]));
  const keys = new Set();
  catalog.forEach((entry, index) => {
    if (keys.has(entry.key)) failures.push(`${entry.key}: listed twice in the release catalog.`);
    keys.add(entry.key);
    if (!existsSync(path.join(root, entry.packageJson))) {
      failures.push(`${entry.packageJson}: missing.`);
      return;
    }
    const manifest = readJson(root, entry.packageJson);
    const label = entry.packageJson;
    if (manifest.name !== entry.name) failures.push(`${label}: name is ${manifest.name}, expected ${entry.name}.`);
    if (entry.name !== `@tjalve/${entry.key}`) failures.push(`${label}: key ${entry.key} does not match ${entry.name}.`);
    if (!SEMVER.test(String(manifest.version ?? ""))) failures.push(`${label}: version ${manifest.version} is not a release version.`);
    if (manifest.private === true) failures.push(`${label}: private.`);
    if (manifest.license !== "MIT") failures.push(`${label}: license must be MIT.`);
    if (manifest.publishConfig?.access !== "public") failures.push(`${label}: publishConfig.access must be public.`);
    if (manifest.repository?.url !== REPOSITORY_URL || manifest.repository?.directory !== entry.path) {
      failures.push(`${label}: repository must be ${REPOSITORY_URL} with directory ${entry.path}.`);
    }
    if (!Array.isArray(manifest.files) || manifest.files.length === 0) failures.push(`${label}: files must list what is published.`);
    for (const file of ["LICENSE", "README.md"]) {
      if (!existsSync(path.join(root, entry.path, file))) failures.push(`${label}: ${file} is missing next to it.`);
    }
    for (const script of LIFECYCLE_SCRIPTS) {
      if (manifest.scripts?.[script] !== undefined) failures.push(`${label}: lifecycle script "${script}" is not allowed in a released package.`);
    }
    const declaredCommands = Object.keys(typeof manifest.bin === "string" ? { [entry.key]: manifest.bin } : (manifest.bin ?? {})).sort();
    if (JSON.stringify(declaredCommands) !== JSON.stringify([...entry.commands].sort())) {
      failures.push(`${label}: commands ${declaredCommands.join(", ") || "(none)"} differ from the catalog (${entry.commands.join(", ") || "none"}).`);
    }
    for (const field of ORDER_FIELDS) {
      for (const name of Object.keys(manifest[field] ?? {})) {
        if (!position.has(name)) continue;
        if (position.get(name) >= index) {
          failures.push(`${label}: ${field} ${name} must come before ${entry.name} in the release catalog.`);
        }
      }
    }
  });
  return failures;
}

export function main(root = DEFAULT_ROOT) {
  const failures = collectReleaseManifestFailures(root);
  if (failures.length > 0) {
    process.stderr.write(`${failures.join("\n")}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`Release catalog matches the workspace: ${RELEASE_PACKAGES.map(entry => entry.name).join(", ")}.\n`);
}

const invoked = process.argv[1] && path.normalize(process.argv[1]) === path.normalize(fileURLToPath(import.meta.url));
if (invoked) main();
