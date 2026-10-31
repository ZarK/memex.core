import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDir, isFile, licenseFileFromPath, sha256 } from "./files.js";
import type { Component, InventoryNote, LicenseFile } from "./types.js";
import { readZipEntries } from "./zip.js";

export const CHROMIUM_LICENSES = "LICENSES.chromium.html";

export interface ElectronSources {
  /** A folder with the Electron binary: the npm package's dist, or an unpacked app build. */
  dist?: string;
  /** An Electron release zip. */
  zip?: string;
  /** The repository root, for its .cache/electron folder. */
  root: string;
}

function fromDir(dir: string): LicenseFile[] | null {
  const chromium = path.join(dir, CHROMIUM_LICENSES);
  if (!isFile(chromium)) return null;
  const files: LicenseFile[] = [];
  for (const name of ["LICENSE", "LICENSE.electron.txt"]) {
    const full = path.join(dir, name);
    if (isFile(full)) {
      files.push(licenseFileFromPath(full, "LICENSE"));
      break;
    }
  }
  files.push(licenseFileFromPath(chromium));
  return files;
}

function fromZip(zip: string): LicenseFile[] | null {
  let entries: Map<string, Buffer>;
  try {
    entries = readZipEntries(zip, (n) => n === "LICENSE" || n === CHROMIUM_LICENSES || n === "LICENSE.electron.txt");
  } catch {
    return null;
  }
  const chromium = entries.get(CHROMIUM_LICENSES);
  if (chromium === undefined) return null;
  const files: LicenseFile[] = [];
  const lic = entries.get("LICENSE") ?? entries.get("LICENSE.electron.txt");
  if (lic !== undefined) files.push({ name: "LICENSE", text: lic.toString("utf8"), bytes: lic.length, sha256: sha256(lic) });
  files.push({ name: CHROMIUM_LICENSES, text: chromium.toString("utf8"), bytes: chromium.length, sha256: sha256(chromium) });
  return files;
}

/** Electron's download caches, in the order @electron/get uses them, plus the repository's .cache/electron. */
function cacheDirs(root: string): string[] {
  const dirs = [path.join(root, ".cache", "electron")];
  if (process.env.electron_config_cache) dirs.push(process.env.electron_config_cache);
  if (process.env.ELECTRON_CACHE) dirs.push(process.env.ELECTRON_CACHE);
  if (process.platform === "win32") dirs.push(path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "electron", "Cache"));
  else if (process.platform === "darwin") dirs.push(path.join(os.homedir(), "Library", "Caches", "electron"));
  else dirs.push(path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"), "electron"));
  return dirs;
}

/** Release zips of one Electron version in a cache folder and its hash-named subfolders. */
function zipsIn(dir: string, version: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`^electron-v${version.replace(/[.+]/g, "\\$&")}-[a-z0-9]+-[a-z0-9]+\\.zip$`);
  const look = (d: string, deep: boolean) => {
    let names: fs.Dirent[];
    try {
      names = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const n of names) {
      if (n.isFile() && re.test(n.name)) out.push(path.join(d, n.name));
      else if (deep && n.isDirectory()) look(path.join(d, n.name), false);
    }
  };
  look(dir, true);
  return out.sort();
}

/** Electron with its own license and the Chromium credits, from a dist folder, a zip, or a cache. */
export function electronComponent(version: string, packageDir: string | null, via: string, src: ElectronSources, notes: InventoryNote[]): Component {
  let files: LicenseFile[] | null = null;
  let from = "";
  const tryDir = (d: string | undefined, label: string) => {
    if (files === null && d !== undefined && isDir(d)) {
      files = fromDir(d);
      if (files !== null) from = `${label} ${d}`;
    }
  };
  const tryZip = (z: string, label: string) => {
    if (files === null && isFile(z)) {
      files = fromZip(z);
      if (files !== null) from = `${label} ${z}`;
    }
  };
  tryDir(src.dist, "dist");
  if (src.zip !== undefined) tryZip(src.zip, "zip");
  if (packageDir !== null) tryDir(path.join(packageDir, "dist"), "dist");
  for (const dir of cacheDirs(src.root)) for (const z of zipsIn(dir, version)) tryZip(z, "cache");
  let note: string | undefined;
  if (files === null) {
    const pkgFiles: LicenseFile[] = [];
    if (packageDir !== null && isFile(path.join(packageDir, "LICENSE"))) pkgFiles.push(licenseFileFromPath(path.join(packageDir, "LICENSE")));
    files = pkgFiles;
    note = `${CHROMIUM_LICENSES} not found: no Electron ${version} dist folder or release zip (pass --electron-dist or --electron-zip)`;
    notes.push({ source: via, message: note });
  }
  return {
    key: `electron:electron@${version}`,
    ecosystem: "electron",
    name: "electron",
    version,
    license: "MIT",
    licenseFrom: from === "" ? "the electron package" : from,
    licenseFiles: files,
    copyright: ["Copyright (c) Electron contributors", "Copyright (c) 2013-2020 GitHub Inc."],
    homepage: "https://www.electronjs.org",
    delivery: "bundled",
    via: [via],
    note,
  };
}

export function hasChromiumCredits(c: Component): boolean {
  return c.licenseFiles.some((f) => f.name === CHROMIUM_LICENSES);
}
