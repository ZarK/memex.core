import fs from "node:fs";
import path from "node:path";
import { MemexPathsError, clean, isAbsolute, isInside, nonEmpty, pathApi, segments, type Env } from "./paths.js";

/**
 * What kind of place a folder is in:
 * - "local": a folder on this computer that nothing copies.
 * - "sync": a folder that a sync client copies to other devices.
 * - "network": a network share.
 * - "removable": a removable or external drive.
 * - "virtualized": a folder that Windows redirects into an MSIX package's private folder.
 */
export type LocationKind = "local" | "sync" | "network" | "removable" | "virtualized";

/**
 * Which check found it:
 * - "variable": the OneDrive, OneDriveConsumer, or OneDriveCommercial variable (Windows).
 * - "cloud-storage": ~/Library/CloudStorage/<name> (macOS).
 * - "segment": a path segment that is a known sync root.
 * - "marker": a marker file in the folder or a parent (.stfolder, .dropbox).
 * - "unc": a UNC path (Windows).
 * - "realpath": the real path of a mapped drive letter is a UNC path (Windows).
 * - "mount-table": the file system type in /proc/self/mounts (Linux).
 * - "mount-path": a mount folder: /media, /run/media (Linux), /Volumes, /Network, /net (macOS).
 * - "msix-package": a folder in %LOCALAPPDATA%\Packages\<package family>.
 * - "msix-redirect": a folder in %LOCALAPPDATA% or %APPDATA% while the app runs as an MSIX package.
 * - "none": no check matched.
 */
export type LocationEvidence =
  | "variable"
  | "cloud-storage"
  | "segment"
  | "marker"
  | "unc"
  | "realpath"
  | "mount-table"
  | "mount-path"
  | "msix-package"
  | "msix-redirect"
  | "none";

export interface LocationDescription {
  path: string;
  kind: LocationKind;
  /** The sync client ("OneDrive", "Syncthing", ...), "MSIX" for a virtualized folder, or null. */
  provider: string | null;
  /** The folder that the provider, share, drive, or package covers, or null for a local folder. */
  root: string | null;
  evidence: LocationEvidence;
}

export interface DescribeLocationOptions {
  platform: string;
  env: Env;
  home: string;
  /**
   * The package family name when the app runs as an MSIX package (in Electron, when process.windowsStore
   * is true). Folders in %LOCALAPPDATA% and %APPDATA% are then redirected into the package.
   */
  msixPackageFamily?: string;
  /** Whether a path exists. Defaults to fs.existsSync. */
  exists?: (p: string) => boolean;
  /** Whether a path is a regular file. Defaults to fs.statSync on the current platform only. */
  isFile?: (p: string) => boolean;
  /** The real path of an existing path. Defaults to fs.realpathSync.native on the current platform only. */
  realpath?: (p: string) => string;
  /** The text of /proc/self/mounts. Defaults to reading it on Linux; null when there is none. */
  mounts?: () => string | null;
}

/** Path segments that are sync roots, compared without case, with the client they name. */
const SEGMENT_PROVIDERS: Array<{ test: (s: string) => boolean; provider: string }> = [
  { test: (s) => s === "onedrive" || s.startsWith("onedrive - "), provider: "OneDrive" },
  { test: (s) => s === "dropbox" || s.startsWith("dropbox ("), provider: "Dropbox" },
  { test: (s) => s === "iclouddrive" || s === "icloud drive" || s === "mobile documents", provider: "iCloud Drive" },
  { test: (s) => s === "google drive" || s === "my drive", provider: "Google Drive" },
  { test: (s) => s === "proton drive", provider: "Proton Drive" },
  { test: (s) => s === "nextcloud", provider: "Nextcloud" },
  { test: (s) => s === "pcloud drive", provider: "pCloud" },
];

/** The <name> prefixes in ~/Library/CloudStorage/<name>-<account>, with the client they name. */
const CLOUD_STORAGE_PROVIDERS: Record<string, string> = {
  onedrive: "OneDrive",
  googledrive: "Google Drive",
  protondrive: "Proton Drive",
  dropbox: "Dropbox",
  box: "Box",
  nextcloud: "Nextcloud",
  pclouddrive: "pCloud",
};

/**
 * Markers that a sync client keeps in the root of the folder it copies. Syncthing's .stfolder is a folder (a file
 * in old versions). Dropbox's marker is a file: Dropbox also keeps its settings in a folder ~/.dropbox on macOS and
 * Linux, which does not make the home folder a Dropbox folder.
 */
const MARKERS: Array<{ name: string; provider: string; fileOnly: boolean }> = [
  { name: ".stfolder", provider: "Syncthing", fileOnly: false },
  { name: ".dropbox", provider: "Dropbox", fileOnly: true },
];

/** File system types in /proc/self/mounts that are network shares. */
const NETWORK_FILE_SYSTEMS = new Set([
  "nfs",
  "nfs4",
  "cifs",
  "smb3",
  "smbfs",
  "afs",
  "ceph",
  "glusterfs",
  "9p",
  "davfs",
  "fuse.sshfs",
  "fuse.rclone",
  "fuse.davfs2",
  "fuse.glusterfs",
]);

function join(p: path.PlatformPath, parts: string[], root: string): string {
  return clean(p, p.join(root, ...parts));
}

/** The root of a path ("C:\", "\\server\share\", "/"), from path.parse. */
function rootOf(p: path.PlatformPath, value: string): string {
  return p.parse(value).root;
}

/** The prefix of a path up to and including segment `index` (0-based after the root). */
function prefix(p: path.PlatformPath, value: string, index: number): string {
  const root = rootOf(p, value);
  const rest = segments(p, value.slice(root.length));
  return join(p, rest.slice(0, index + 1), root);
}

/** The UNC share root (\\server\share) of a Windows path, or null. Device paths (\\?\, \\.\) count only as \\?\UNC\. */
function uncShare(value: string): string | null {
  const unc = /^[\\/]{2}\?[\\/]UNC[\\/]([^\\/]+)[\\/]([^\\/]+)/i.exec(value) ?? /^[\\/]{2}([^\\/?.][^\\/]*)[\\/]([^\\/]+)/.exec(value);
  return unc === null ? null : `\\\\${unc[1]}\\${unc[2]}`;
}

function realpathOrNull(realpath: (p: string) => string, value: string): string | null {
  try {
    return realpath(value);
  } catch {
    return null;
  }
}

/** The real path of the nearest existing parent, joined with the rest. Null when nothing resolves. */
function realOfNearest(p: path.PlatformPath, value: string, realpath: (p: string) => string): string | null {
  const rest: string[] = [];
  let current = value;
  for (;;) {
    const real = realpathOrNull(realpath, current);
    if (real !== null) return clean(p, rest.length > 0 ? p.join(real, ...rest) : real);
    const parent = p.dirname(current);
    if (parent === current) return null;
    rest.unshift(p.basename(current));
    current = parent;
  }
}

function decodeMount(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
}

/**
 * The mount point and type in a /proc/self/mounts text that holds a path: the longest mount point, and of equal
 * mount points the last one.
 */
function mountFor(text: string, value: string): { point: string; type: string } | null {
  let best: { point: string; type: string } | null = null;
  for (const line of text.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 3) continue;
    const point = decodeMount(fields[1]!);
    if (!isInside(path.posix, value, point) && point !== "/") continue;
    // A later mount at the same point shadows an earlier one, such as an NFS mount on an autofs trigger.
    if (best === null || point.length >= best.point.length) best = { point, type: fields[2]! };
  }
  return best;
}

function syncBySegments(p: path.PlatformPath, value: string): Omit<LocationDescription, "path"> | null {
  const root = rootOf(p, value);
  const parts = segments(p, value.slice(root.length));
  for (let i = 0; i < parts.length; i++) {
    const s = parts[i]!.toLowerCase();
    for (const entry of SEGMENT_PROVIDERS) {
      if (entry.test(s)) {
        let end = i;
        // iCloud Drive's root on macOS is Mobile Documents/com~apple~CloudDocs.
        if (s === "mobile documents" && parts[i + 1]?.toLowerCase() === "com~apple~clouddocs") end = i + 1;
        return { kind: "sync", provider: entry.provider, root: prefix(p, value, end), evidence: "segment" };
      }
    }
  }
  return null;
}

function syncByMarker(
  p: path.PlatformPath,
  value: string,
  exists: (p: string) => boolean,
  isFile: (p: string) => boolean,
): Omit<LocationDescription, "path"> | null {
  let current = value;
  for (;;) {
    for (const marker of MARKERS) {
      const full = p.join(current, marker.name);
      if (marker.fileOnly ? isFile(full) : exists(full)) {
        return { kind: "sync", provider: marker.provider, root: current, evidence: "marker" };
      }
    }
    const parent = p.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** A variable's value when it is an absolute path, else the fallback. */
function absoluteOr(p: path.PlatformPath, value: string | undefined, fallback: string): string {
  const v = nonEmpty(value);
  return v !== undefined && isAbsolute(p, v) ? clean(p, v) : fallback;
}

function isFileOnDisk(value: string): boolean {
  try {
    return fs.statSync(value, { throwIfNoEntry: false })?.isFile() ?? false;
  } catch {
    return false;
  }
}

function defaultMounts(): string | null {
  try {
    return fs.readFileSync("/proc/self/mounts", "utf8");
  } catch {
    return null;
  }
}

/**
 * What kind of place a folder is in: local, a sync client's folder, a network share, a removable or external
 * drive, or an MSIX-virtualized folder. It reads the path, the environment, and does cheap checks only: it looks
 * for marker files in the folder and its parents, resolves the real path, and reads /proc/self/mounts on Linux.
 * It runs no other program and needs no native code. The folder need not exist.
 *
 * The checks, in order (the first match wins): MSIX, the OneDrive variables, ~/Library/CloudStorage, path
 * segments, marker files, network shares, mount folders. Throws MemexPathsError for a relative path.
 */
export function describeLocation(value: string, options: DescribeLocationOptions): LocationDescription {
  const { platform, env, home } = options;
  const p = pathApi(platform);
  if (!isAbsolute(p, value)) {
    throw new MemexPathsError("relative-path", `The folder must be an absolute path: ${value}`);
  }
  const target = clean(p, value);
  const same = platform === process.platform || (platform !== "win32" && process.platform !== "win32");
  const exists = options.exists ?? (same ? fs.existsSync : () => false);
  const isFile = options.isFile ?? (same ? isFileOnDisk : () => false);
  const realpath = options.realpath ?? (same ? fs.realpathSync.native : (x: string) => x);
  const real = realOfNearest(p, target, realpath) ?? target;
  const found = (d: Omit<LocationDescription, "path">): LocationDescription => ({ path: target, ...d });

  if (platform === "win32") {
    const local = absoluteOr(p, env.LOCALAPPDATA, p.join(home, "AppData", "Local"));
    const packages = p.join(local, "Packages");
    for (const candidate of [target, real]) {
      if (isInside(p, candidate, packages) && segments(p, candidate).length > segments(p, packages).length) {
        const name = segments(p, candidate)[segments(p, packages).length]!;
        return found({ kind: "virtualized", provider: "MSIX", root: p.join(clean(p, packages), name), evidence: "msix-package" });
      }
    }
    const family = nonEmpty(options.msixPackageFamily);
    if (family !== undefined) {
      const roaming = absoluteOr(p, env.APPDATA, p.join(home, "AppData", "Roaming"));
      const cache = p.join(packages, family, "LocalCache");
      if (isInside(p, target, local)) return found({ kind: "virtualized", provider: "MSIX", root: p.join(cache, "Local"), evidence: "msix-redirect" });
      if (isInside(p, target, roaming)) return found({ kind: "virtualized", provider: "MSIX", root: p.join(cache, "Roaming"), evidence: "msix-redirect" });
    }
    for (const name of ["OneDrive", "OneDriveConsumer", "OneDriveCommercial"]) {
      const v = nonEmpty(env[name]);
      if (v === undefined || !isAbsolute(p, v)) continue;
      const root = clean(p, v);
      if (isInside(p, target, root)) return found({ kind: "sync", provider: "OneDrive", root, evidence: "variable" });
    }
  }

  if (platform === "darwin") {
    const storage = p.join(home, "Library", "CloudStorage");
    for (const candidate of [target, real]) {
      if (isInside(p, candidate, storage) && segments(p, candidate).length > segments(p, storage).length) {
        const name = segments(p, candidate)[segments(p, storage).length]!;
        const dash = name.indexOf("-");
        const key = (dash > 0 ? name.slice(0, dash) : name).toLowerCase();
        const provider = CLOUD_STORAGE_PROVIDERS[key] ?? (dash > 0 ? name.slice(0, dash) : name);
        return found({ kind: "sync", provider, root: p.join(storage, name), evidence: "cloud-storage" });
      }
    }
  }

  const bySegment = syncBySegments(p, target) ?? (real !== target ? syncBySegments(p, real) : null);
  if (bySegment !== null) return found(bySegment);
  const byMarker = syncByMarker(p, target, exists, isFile);
  if (byMarker !== null) return found(byMarker);

  if (platform === "win32") {
    const share = uncShare(target);
    if (share !== null) return found({ kind: "network", provider: null, root: share, evidence: "unc" });
    const realShare = uncShare(real);
    if (realShare !== null) return found({ kind: "network", provider: null, root: rootOf(p, target), evidence: "realpath" });
    // Removable drives on Windows need GetDriveType, a system call that Node does not expose: not detected.
    return found({ kind: "local", provider: null, root: null, evidence: "none" });
  }

  if (platform === "darwin") {
    const parts = segments(p, real);
    if (parts[0] === "Network" || parts[0] === "net") {
      return found({ kind: "network", provider: null, root: p.join("/", ...parts.slice(0, Math.min(parts.length, 3))), evidence: "mount-path" });
    }
    // /Volumes/<name> is an external drive or a mounted share; the start-up disk resolves to "/".
    if (parts[0] === "Volumes" && parts.length >= 2) {
      return found({ kind: "removable", provider: null, root: p.join("/", "Volumes", parts[1]!), evidence: "mount-path" });
    }
    return found({ kind: "local", provider: null, root: null, evidence: "none" });
  }

  const mounts = (options.mounts ?? (platform === "linux" && same ? defaultMounts : () => null))();
  if (mounts !== null) {
    const mount = mountFor(mounts, real);
    if (mount !== null && NETWORK_FILE_SYSTEMS.has(mount.type)) {
      return found({ kind: "network", provider: null, root: mount.point, evidence: "mount-table" });
    }
  }
  const parts = segments(p, real);
  if (parts[0] === "media" && parts.length >= 3) {
    return found({ kind: "removable", provider: null, root: p.join("/", ...parts.slice(0, 3)), evidence: "mount-path" });
  }
  if (parts[0] === "run" && parts[1] === "media" && parts.length >= 4) {
    return found({ kind: "removable", provider: null, root: p.join("/", ...parts.slice(0, 4)), evidence: "mount-path" });
  }
  return found({ kind: "local", provider: null, root: null, evidence: "none" });
}
