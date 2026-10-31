import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { SERVICES_DMG_NOTE, builderConfig, desktopAsset, executableName, type BuilderOptions } from "./builder.js";
import { writeCliShim } from "./cli-shim.js";
import { readServiceManifest, serviceTarget, stageServices } from "./services.js";
import { assertReleaseVersion, checkUpdateFiles, inspectReleaseAsar, normalizeLinuxArtifactNames, readPackageVersion, releaseTagFromEnv, writeChecksums, type AsarRules } from "./release.js";

/**
 * memex-desktop.config.mjs: one file per app that says how it is packed. Paths are relative to the file's folder.
 *
 *   export default {
 *     builder: { app: "photos", productName: "Memex Photos", files: ["main.mjs", "server/**", "package.json"] },
 *     cli: { entry: "cli.mjs" },
 *     asar: { required: ["main.mjs"] },
 *     versionFiles: ["package.json", "../package.json"],
 *   };
 */
export interface DesktopPackConfig {
  builder: BuilderOptions;
  /** The app's CLI module inside app.asar; the pack writes the memex-<app> shims for it. */
  cli?: { entry: string };
  asar?: AsarRules;
  /** The package.json files whose versions must agree. Defaults to package.json. */
  versionFiles?: string[];
  /** The folder for generated build files. Defaults to build. */
  buildDir?: string;
  /**
   * The shared services the app carries: services.json pins each service's version and, for each target,
   * its archive and SHA-256; from is the folder with those archives. Paths are relative to the config file.
   */
  services?: ServicesPackConfig;
}

export interface ServicesPackConfig {
  /** services.json (memex.services/1). Defaults to services.json. */
  pins?: string;
  /** The folder with the pinned archives (memex-<service>-<version>-<target>.tar.gz). */
  from: string;
  /**
   * The signing hook: a module whose default export is called with the staged copies before electron-builder runs,
   * { services: [{ app, version, folder, command }], target, platform }. Nothing is signed without it on Windows and
   * Linux; on macOS electron-builder signs every program in the bundle with the app's identity (macIdentity).
   */
  sign?: string;
}

export interface PackOptions {
  /** The path of memex-desktop.config.mjs. */
  config: string;
  /** Build the unpacked app only (electron-builder --dir), no installers or checksums. */
  dir?: boolean;
  requireTag?: boolean;
  log?: (line: string) => void;
}

export interface PackResult {
  version: string;
  release: string;
  archives: string[];
  checksums?: { outputPath: string; names: string[] };
  /** The update files to publish beside the installers (the app has `builder.updates`). Also listed in UPDATE-FILES.txt. */
  updateFiles?: string[];
}

export async function loadPackConfig(file: string): Promise<DesktopPackConfig> {
  const module = (await import(pathToFileURL(path.resolve(file)).href)) as { default?: DesktopPackConfig };
  if (!module.default?.builder) throw new Error(`${file} must export default { builder, ... }.`);
  return module.default;
}

export async function pack(options: PackOptions): Promise<PackResult> {
  const log = options.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const configFile = path.resolve(options.config);
  const projectDir = path.dirname(configFile);
  const config = await loadPackConfig(configFile);
  const versions = (config.versionFiles ?? ["package.json"]).map((f) => readPackageVersion(path.resolve(projectDir, f)));
  const { version, tag } = assertReleaseVersion({ versions, releaseTag: releaseTagFromEnv(), requireTag: options.requireTag });
  log(`Packing ${config.builder.productName} ${version}${tag ? ` (${tag})` : ""}`);

  const buildDir = path.resolve(projectDir, config.buildDir ?? "build");
  mkdirSync(buildDir, { recursive: true });
  const builder: BuilderOptions = { ...config.builder };
  if (config.cli) {
    if (builder.runAsNode !== true) {
      throw new Error("The CLI shim runs the CLI with the program's own Node.js and needs the runAsNode fuse. Set builder.runAsNode: true to accept that, or leave out cli.");
    }
    const shimRoot = path.join(buildDir, "cli-shims");
    for (const platform of ["win32", "darwin", "linux"]) {
      const options = { app: builder.app, executableName: executableName(builder, platform), cliEntry: config.cli.entry };
      // The Windows shim is compiled with the Windows C# compiler; the Windows installer is built on Windows.
      if (platform === "win32" && process.platform !== "win32") continue;
      const file = await writeCliShim(path.join(shimRoot, platform), options, platform);
      log(`Wrote the CLI shim ${path.relative(projectDir, file)}`);
    }
    builder.cliShims = path.relative(projectDir, shimRoot).replaceAll("\\", "/");
  }
  if (config.services) {
    // The builds of pack: NSIS for x64 on Windows, the dmg for arm64 on macOS, AppImage and deb for x64 on Linux.
    const target = serviceTarget(process.platform, process.platform === "darwin" ? "arm64" : "x64");
    const staged = path.join(buildDir, "services");
    rmSync(staged, { recursive: true, force: true });
    const bundle = stageServices({
      pins: path.resolve(projectDir, config.services.pins ?? "services.json"),
      from: path.resolve(projectDir, config.services.from),
      target,
      out: staged,
      log,
    });
    if (config.services.sign) {
      const hook = (await import(pathToFileURL(path.resolve(projectDir, config.services.sign)).href)) as { default?: (input: unknown) => Promise<void> };
      if (typeof hook.default !== "function") throw new Error(`${config.services.sign} must export a default function.`);
      const services = Object.entries(bundle.services).map(([app, s]) => {
        const folder = path.join(staged, app, s.version);
        return { app, version: s.version, folder, command: path.join(folder, readServiceManifest(folder, app, s.version).command) };
      });
      await hook.default({ services, target, platform: process.platform });
      log(`Ran the signing hook ${config.services.sign} on ${services.length} services.`);
    }
    builder.services = path.relative(projectDir, staged).replaceAll("\\", "/");
    const note = path.join(buildDir, SERVICES_DMG_NOTE);
    copyFileSync(desktopAsset(SERVICES_DMG_NOTE), note);
    builder.servicesNote = note;
  }
  const generated = path.join(buildDir, "electron-builder.json");
  writeFileSync(generated, `${JSON.stringify(builderConfig(builder), null, 2)}\n`);

  const require = createRequire(path.join(projectDir, "package.json"));
  const cli = require.resolve("electron-builder/cli.js");
  const args = [cli, "--projectDir", projectDir, "--config", generated, "--publish", "never"];
  if (options.dir) args.push("--dir");
  log(`electron-builder ${args.slice(1).join(" ")}`);
  const result = spawnSync(process.execPath, args, {
    cwd: projectDir,
    stdio: "inherit",
    env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false" },
  });
  if (result.status !== 0) throw new Error(`electron-builder failed (${result.error?.message ?? `exit ${result.status}`}).`);

  const release = path.resolve(projectDir, builder.output ?? "release");
  const inspected = inspectReleaseAsar(release, config.asar);
  log(`Checked ${inspected.archives.length} app.asar (${inspected.files} files): no source maps, required files present.`);
  if (options.dir) return { version, release, archives: inspected.archives };

  const base = builder.artifactBase ?? builder.productName.trim().replace(/\s+/g, ".");
  for (const entry of normalizeLinuxArtifactNames(release, base)) log(`Renamed ${entry.from} to ${entry.to}`);
  const checksums = writeChecksums(release, base);
  log(`Wrote ${checksums.names.length} checksums to ${checksums.outputPath}`);
  let updateFiles: string[] | undefined;
  if (builder.updates) {
    // The installers keep their names after the rename above, so the update file lists the files that are there.
    updateFiles = checkUpdateFiles(release, version, process.platform);
    writeFileSync(path.join(release, "UPDATE-FILES.txt"), updateFiles.map((name) => `${name}\n`).join(""));
    log(`Checked ${updateFiles.length} update files against the installers: ${updateFiles.join(", ") || "none on this platform"}`);
  }
  return { version, release, archives: inspected.archives, checksums, ...(updateFiles ? { updateFiles } : {}) };
}
