import { spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { hashFileSync } from "./release.js";

/**
 * Electron's own install script downloads the program when the package installs. Memex installs with scripts off,
 * so this does the same step on purpose: it downloads the release zip of the installed electron package's version
 * from GitHub, checks its SHA-256 against the checksums.json that the npm package carries (the package itself is
 * checked by the lockfile's integrity), unpacks it into the package's dist folder and writes path.txt.
 */
export interface FetchElectronOptions {
  /** The folder whose node_modules has electron. Defaults to the current folder. */
  from?: string;
  platform?: string;
  arch?: string;
  /** Where the zip is kept. Defaults to <from>/.cache/electron (memex-licenses reads the Chromium credits there). */
  cache?: string;
  /** Download from here instead of GitHub (a mirror with the same file names). */
  mirror?: string;
  log?: (line: string) => void;
}

export interface FetchElectronResult {
  version: string;
  zip: string;
  sha256: string;
  dist: string;
  executable: string;
  downloaded: boolean;
  extracted: boolean;
}

export function electronExecutablePath(platform: string): string {
  if (platform === "win32") return "electron.exe";
  if (platform === "darwin") return "Electron.app/Contents/MacOS/Electron";
  return "electron";
}

export function electronPackageDir(from: string): string {
  const require = createRequire(path.join(path.resolve(from), "package.json"));
  return path.dirname(require.resolve("electron/package.json"));
}

async function download(url: string, target: string): Promise<void> {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`Download failed: ${url} answered ${response.status}.`);
  const temporary = `${target}.${process.pid}.part`;
  await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), createWriteStream(temporary));
  renameSync(temporary, target);
}

function extract(zip: string, dist: string, platform: string): void {
  mkdirSync(dist, { recursive: true });
  // bsdtar reads zip files and keeps the links inside Electron.app; Windows has it as System32\tar.exe.
  const result =
    process.platform === "win32"
      ? spawnSync(path.join(process.env.SystemRoot ?? `${process.env.SystemDrive ?? "C:"}\\Windows`, "System32", "tar.exe"), ["-xf", zip, "-C", dist], { stdio: "inherit" })
      : process.platform === "darwin"
        ? spawnSync("/usr/bin/ditto", ["-x", "-k", zip, dist], { stdio: "inherit" })
        : spawnSync("unzip", ["-q", "-o", zip, "-d", dist], { stdio: "inherit" });
  if (result.status !== 0) throw new Error(`Unpacking ${zip} failed (${result.error?.message ?? `exit ${result.status}`}).`);
  if (!existsSync(path.join(dist, electronExecutablePath(platform)))) throw new Error(`The zip did not hold ${electronExecutablePath(platform)}.`);
}

export async function fetchElectron(options: FetchElectronOptions = {}): Promise<FetchElectronResult> {
  const from = path.resolve(options.from ?? process.cwd());
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const log = options.log ?? (() => {});
  const dir = electronPackageDir(from);
  const { version } = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as { version: string };
  const checksums = JSON.parse(readFileSync(path.join(dir, "checksums.json"), "utf8")) as Record<string, string>;
  const name = `electron-v${version}-${platform}-${arch}.zip`;
  const expected = checksums[name];
  if (!expected || !/^[a-f0-9]{64}$/.test(expected)) throw new Error(`checksums.json of electron ${version} has no ${name}.`);
  const cache = path.resolve(options.cache ?? path.join(from, ".cache", "electron"));
  mkdirSync(cache, { recursive: true });
  const zip = path.join(cache, name);
  let downloaded = false;
  if (!existsSync(zip) || hashFileSync(zip) !== expected) {
    const base = (options.mirror ?? "https://github.com/electron/electron/releases/download/").replace(/\/?$/, "/");
    const url = `${base}v${version}/${name}`;
    log(`Downloading ${url}`);
    await download(url, zip);
    downloaded = true;
  }
  const sha256 = hashFileSync(zip);
  if (sha256 !== expected) throw new Error(`${name} has SHA-256 ${sha256}, but checksums.json says ${expected}. The zip is kept at ${zip} for a look; it is not used.`);
  log(`${name} SHA-256 ${sha256} matches checksums.json.`);
  const dist = path.join(dir, "dist");
  const executable = electronExecutablePath(platform);
  let extracted = false;
  const versionFile = path.join(dist, "version");
  const current = existsSync(versionFile) ? readFileSync(versionFile, "utf8").trim().replace(/^v/, "") : null;
  if (current !== version || !existsSync(path.join(dist, executable))) {
    if (existsSync(dist) && current !== null && current !== version) throw new Error(`${dist} holds Electron ${current}; move it away first.`);
    log(`Unpacking into ${dist}`);
    extract(zip, dist, platform);
    extracted = true;
  }
  writeFileSync(path.join(dir, "path.txt"), executable);
  return { version, zip, sha256, dist, executable, downloaded, extracted };
}
