import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildArgvCommandPlan } from "./process-launch.mjs";
import { PUBLISH_PACKAGES } from "./publish-packages.mjs";
import { resolvePublishDependencies } from "./resolve-publish-dependencies.mjs";
import { restorePublishDependencies } from "./restore-publish-dependencies.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fail(message, reasonCode = "installed-check") {
  throw Object.assign(new Error(message), { reasonCode });
}

function run(command, args, options) {
  const plan = buildArgvCommandPlan(command, args);
  const result = spawnSync(plan.command, plan.args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    windowsVerbatimArguments: plan.windowsVerbatimArguments,
    timeout: options.timeout ?? 300_000,
  });
  return result;
}

function requireSuccess(result, label) {
  if (result.status !== 0) {
    fail(`${label} failed with exit ${result.status ?? "unknown"}.\n${String(result.stderr ?? "").trim()}\n${String(result.stdout ?? "").trim()}`.trim());
  }
  return result;
}

export function packagesToCheck(plan) {
  const packages = plan.verifyPackages ?? plan.packages;
  if (!Array.isArray(packages) || packages.length === 0) fail("Publish plan has no packages.", "plan");
  return packages.map(entry => {
    const allowed = PUBLISH_PACKAGES.get(entry.packageKey);
    if (!allowed || allowed.path !== entry.path || allowed.filter !== entry.packageName) {
      fail(`Publish plan entry ${entry.packageKey} does not match the allowlist.`, "plan");
    }
    return { ...entry, commands: [...allowed.commands], imports: [...allowed.imports] };
  });
}

// The repository rule (.npmrc): no dependency version younger than 14 days. The install
// below runs in a folder outside the checkout, where the repository .npmrc does not apply.
export const MIN_RELEASE_AGE_DAYS = 14;

// Variables that let a process request the job's OIDC token. The installed check runs
// third-party dependency code, so its child processes never get them.
const OIDC_VARIABLES = Object.freeze(["ACTIONS_ID_TOKEN_REQUEST_URL", "ACTIONS_ID_TOKEN_REQUEST_TOKEN"]);

export function scratchEnvironment(base, env = process.env) {
  const homes = {
    MEMEX_HOME: path.join(base, "home"),
    MEMEX_ARCHIVE_HOME: path.join(base, "archive"),
    MEMEX_APPS_DIR: path.join(base, "apps"),
  };
  for (const folder of Object.values(homes)) mkdirSync(folder, { recursive: true });
  const child = { ...env, ...homes };
  for (const name of Object.keys(child)) {
    if (OIDC_VARIABLES.includes(name.toUpperCase())) delete child[name];
  }
  return child;
}

export function installArguments(tarballs) {
  return [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--legacy-peer-deps",
    "--save-exact",
    `--min-release-age=${MIN_RELEASE_AGE_DAYS}`,
    ...tarballs,
  ];
}

// Packs each package as it is staged (workspace dependencies replaced by exact versions),
// installs the packed files into a folder outside the checkout with install scripts off,
// then imports every entry and starts every command with --help.
export async function verifyInstalledPackages(plan, options = {}) {
  const root = options.root ?? ROOT;
  const packages = packagesToCheck(plan);
  const base = realpathSync.native(mkdtempSync(path.join(options.tmpdir ?? os.tmpdir(), "memex-release-check-")));
  const relative = path.relative(realpathSync.native(root), base);
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) fail("The check folder must be outside the checkout.");
  const tarballs = path.join(base, "tarballs");
  const prefix = path.join(base, "install");
  mkdirSync(tarballs, { recursive: true });
  mkdirSync(prefix, { recursive: true });
  const env = scratchEnvironment(path.join(base, "scratch"), options.env);
  const log = options.log ?? (line => process.stdout.write(`${line}\n`));

  const packed = [];
  for (const entry of packages) {
    const manifestPath = path.join(root, entry.packageJson);
    try {
      await resolvePublishDependencies(manifestPath, { root });
      const result = requireSuccess(
        run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", tarballs], { cwd: path.join(root, entry.path), env }),
        `npm pack ${entry.packageName}`,
      );
      const [info] = JSON.parse(result.stdout);
      if (info?.name !== entry.packageName || info?.version !== entry.version) {
        fail(`npm pack returned ${info?.name}@${info?.version}, expected ${entry.packageName}@${entry.version}.`);
      }
      packed.push(path.join(tarballs, info.filename));
      log(`packed ${entry.packageName}@${entry.version} (${info.entryCount} files, ${info.size} bytes)`);
    } finally {
      await restorePublishDependencies(manifestPath);
    }
  }

  writeFileSync(path.join(prefix, "package.json"), `${JSON.stringify({ name: "memex-release-check", private: true }, null, 2)}\n`);
  requireSuccess(
    run("npm", installArguments(packed), { cwd: prefix, env }),
    "npm install of the packed packages",
  );
  log(`installed ${packed.length} packed packages into a folder outside the checkout`);

  const checks = [];
  for (const entry of packages) {
    const installedRoot = path.join(prefix, "node_modules", ...entry.packageName.split("/"));
    const installed = JSON.parse(readFileSync(path.join(installedRoot, "package.json"), "utf8"));
    if (installed.version !== entry.version) fail(`${entry.packageName} installed as ${installed.version}, expected ${entry.version}.`);
    for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
      for (const dependency of Object.entries(installed[field] ?? {})) {
        if (String(dependency[1]).startsWith("workspace:")) fail(`${entry.packageName} was packed with ${field}.${dependency[0]}@${dependency[1]}.`);
      }
    }
    for (const subpath of entry.imports) {
      const specifier = subpath === "." ? entry.packageName : `${entry.packageName}/${subpath.replace(/^\.\//, "")}`;
      requireSuccess(
        run(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(specifier)});`], { cwd: prefix, env, timeout: 60_000 }),
        `import ${specifier}`,
      );
      checks.push(`import ${specifier}`);
      log(`ok import ${specifier}`);
    }
    const bins = typeof installed.bin === "string" ? { [entry.packageKey]: installed.bin } : (installed.bin ?? {});
    for (const command of entry.commands) {
      if (!bins[command]) fail(`${entry.packageName} does not declare the command ${command}.`);
      requireSuccess(
        run(process.execPath, [path.join(installedRoot, bins[command]), "--help"], { cwd: prefix, env, timeout: 60_000 }),
        `${command} --help`,
      );
      checks.push(`${command} --help`);
      log(`ok ${command} --help`);
    }
  }
  return { ok: true, folder: base, packages: packages.map(entry => `${entry.packageName}@${entry.version}`), checks };
}

export async function main(argv = process.argv.slice(2)) {
  const planFlag = argv.indexOf("--plan");
  const planPath = path.resolve(planFlag >= 0 ? argv[planFlag + 1] ?? "" : "publish-plan.json");
  try {
    const plan = JSON.parse(readFileSync(planPath, "utf8"));
    const report = await verifyInstalledPackages(plan);
    if (argv.includes("--json")) process.stdout.write(`${JSON.stringify(report)}\n`);
    else process.stdout.write(`Installed check passed: ${report.packages.length} packages, ${report.checks.length} checks.\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

const invoked = process.argv[1] && path.normalize(process.argv[1]) === path.normalize(fileURLToPath(import.meta.url));
if (invoked) await main();
