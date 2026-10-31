import { copyFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { RELEASE_PACKAGES } from "./publish-packages.mjs";

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLISHED_FIELDS = Object.freeze(["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]);

export async function readWorkspaceVersions(root = DEFAULT_ROOT) {
  const versions = new Map();
  for (const entry of RELEASE_PACKAGES) {
    const manifest = JSON.parse(await readFile(path.join(root, entry.packageJson), "utf8"));
    if (manifest.name !== entry.name) {
      throw new Error(`${entry.packageJson}: expected package name ${entry.name}, found ${manifest.name}`);
    }
    versions.set(entry.name, manifest.version);
  }
  return versions;
}

// Replaces each workspace: dependency of a package manifest with the exact version of that
// workspace package, as pnpm pack does, and keeps the original next to it as
// package.json.publish-backup until restore-publish-dependencies.mjs puts it back.
export async function resolvePublishDependencies(packageJsonPath, options = {}) {
  const packageVersions = options.versions ?? await readWorkspaceVersions(options.root ?? DEFAULT_ROOT);
  const backupPath = `${packageJsonPath}.publish-backup`;
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  const resolved = [];

  for (const field of PUBLISHED_FIELDS) {
    const entries = packageJson[field];
    if (!entries || typeof entries !== "object") continue;

    for (const [name, version] of Object.entries(entries)) {
      if (!String(version).startsWith("workspace:")) continue;

      const exactVersion = packageVersions.get(name);
      if (!exactVersion) {
        throw new Error(`Cannot resolve workspace dependency ${name} for ${packageJsonPath}`);
      }

      entries[name] = exactVersion;
      resolved.push({ field, name, version: exactVersion });
    }
  }

  if (resolved.length > 0) {
    await copyFile(packageJsonPath, backupPath);
    await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
  }

  return {
    ok: true,
    packageJsonPath,
    name: packageJson.name,
    version: packageJson.version,
    resolved,
  };
}

export async function main(argv = process.argv.slice(2)) {
  const packageJsonPath = path.resolve(argv[0] ?? "package.json");
  try {
    process.stdout.write(`${JSON.stringify(await resolvePublishDependencies(packageJsonPath))}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

const invoked = process.argv[1] && path.normalize(process.argv[1]) === path.normalize(fileURLToPath(import.meta.url));
if (invoked) await main();
