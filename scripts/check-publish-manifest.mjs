import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const exactVersionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

// The manifest that is staged: dependencies and optional dependencies name exact versions,
// and no field (development dependencies included) keeps the workspace protocol. A peer dependency may name a range (the
// desktop shell accepts any Electron from a version on).
export function collectPublishManifestFailures(packageJson, label = "package.json") {
  const failures = [];
  for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    const entries = packageJson[field];
    if (!entries || typeof entries !== "object") continue;

    for (const [name, version] of Object.entries(entries)) {
      const versionText = String(version);

      if (versionText.startsWith("workspace:")) {
        failures.push(`${label}: ${field}.${name} uses unsupported publish protocol "${version}"`);
        continue;
      }

      if ((field === "dependencies" || field === "optionalDependencies") && !exactVersionPattern.test(versionText)) {
        failures.push(`${label}: ${field}.${name} must use an exact publish version, found "${version}"`);
      }
    }
  }
  return failures;
}

export async function main(argv = process.argv.slice(2)) {
  const packageJsonPath = path.resolve(argv[0] ?? "package.json");
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  const failures = collectPublishManifestFailures(packageJson, packageJsonPath);
  if (failures.length > 0) {
    process.stderr.write(`${failures.join("\n")}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${JSON.stringify({ ok: true, packageJsonPath, name: packageJson.name, version: packageJson.version })}\n`);
}

const invoked = process.argv[1] && path.normalize(process.argv[1]) === path.normalize(fileURLToPath(import.meta.url));
if (invoked) await main();
