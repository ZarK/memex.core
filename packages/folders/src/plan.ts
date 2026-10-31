import os from "node:os";
import path from "node:path";
import { describeLocation, formatBytes, type DescribeLocationOptions, type LocationDescription } from "@tjalve/memex-storage";
import { splitPath } from "./keys.js";
import type { ScanResult } from "./scan.js";

/** The online-only files of one provider that an import would read. */
export interface ProviderTotal {
  /** "Proton Drive", "iCloud Drive", ...; null when the online-only files are in a folder of no known sync client. */
  provider: string | null;
  /** The folder the provider covers, or the scanned root when there is no provider. */
  root: string;
  files: number;
  bytes: number;
  /** iCloud stubs, whose size is not known: `bytes` is then a lower bound. */
  unknownSizeFiles: number;
}

export interface ImportPlan {
  root: string;
  /** Files the import would read now: new, changed, and moved-changed files that are not settling. */
  read: { files: number; bytes: number };
  /** The local part of `read`: nothing is downloaded. */
  local: { files: number; bytes: number };
  /** The online-only part of `read`: reading downloads them. */
  onlineOnly: { files: number; bytes: number; unknownSizeFiles: number; providers: ProviderTotal[] };
  /** Files left for a later scan because they are still being written. */
  settling: { files: number; bytes: number };
  /** True when the app must ask before it reads: the import would download files. */
  needsConfirmation: boolean;
  /** "1,240 files, 38 GB, from iCloud Drive", or null when nothing is downloaded. */
  text: string | null;
}

export interface PlanOptions {
  /** For describeLocation(): the platform, the environment, and the home folder. Defaults to this process. */
  location?: Partial<DescribeLocationOptions>;
}

const READ_OUTCOMES = new Set(["new", "changed", "moved-changed"]);

function count(n: number, one: string, many: string): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

/** The confirmation text of one provider: "1,240 files, 38 GB, from iCloud Drive". */
export function providerText(total: ProviderTotal): string {
  const size = total.unknownSizeFiles > 0 ? `at least ${formatBytes(total.bytes)}` : formatBytes(total.bytes);
  return `${count(total.files, "file", "files")}, ${size}, from ${total.provider ?? total.root}`;
}

/**
 * What an import of a scan would read, and how much of it would be downloaded, by provider. Listing never
 * downloads; reading an online-only file does. When `needsConfirmation` is true, the app shows `text` and the user
 * starts the import.
 */
export function plan(scan: ScanResult, options: PlanOptions = {}): ImportPlan {
  const platform = options.location?.platform ?? process.platform;
  const p = platform === "win32" ? path.win32 : path.posix;
  const describeOptions: DescribeLocationOptions = {
    platform,
    env: options.location?.env ?? process.env,
    home: options.location?.home ?? os.homedir(),
    ...options.location,
  };
  const rootLocation = describeLocation(scan.root, describeOptions);
  const cache = new Map<string, LocationDescription>();
  const locate = (relativeFolder: string): LocationDescription => {
    // A sync client covers its whole folder, so every file below a synchronized root has the root's provider.
    if (rootLocation.kind === "sync" || relativeFolder === "") return rootLocation;
    let found = cache.get(relativeFolder);
    if (found === undefined) {
      found = describeLocation(p.join(scan.root, ...relativeFolder.split("/")), describeOptions);
      cache.set(relativeFolder, found);
    }
    return found;
  };

  const result: ImportPlan = {
    root: scan.root,
    read: { files: 0, bytes: 0 },
    local: { files: 0, bytes: 0 },
    onlineOnly: { files: 0, bytes: 0, unknownSizeFiles: 0, providers: [] },
    settling: { files: 0, bytes: 0 },
    needsConfirmation: false,
    text: null,
  };
  const providers = new Map<string, ProviderTotal>();
  for (const d of scan.decisions) {
    if (!READ_OUTCOMES.has(d.outcome) || d.file === undefined) continue;
    const f = d.file;
    if (d.settling === true) {
      result.settling.files++;
      result.settling.bytes += f.size;
      continue;
    }
    result.read.files++;
    result.read.bytes += f.size;
    if (!f.onlineOnly) {
      result.local.files++;
      result.local.bytes += f.size;
      continue;
    }
    result.onlineOnly.files++;
    result.onlineOnly.bytes += f.size;
    if (!f.sizeKnown) result.onlineOnly.unknownSizeFiles++;
    const location = locate(splitPath(f.path).folder);
    const provider = location.kind === "sync" ? location.provider : null;
    const root = provider !== null && location.root !== null ? location.root : scan.root;
    const key = `${provider ?? ""}\n${root}`;
    let total = providers.get(key);
    if (total === undefined) providers.set(key, (total = { provider, root, files: 0, bytes: 0, unknownSizeFiles: 0 }));
    total.files++;
    total.bytes += f.size;
    if (!f.sizeKnown) total.unknownSizeFiles++;
  }
  result.onlineOnly.providers = [...providers.values()].sort((a, b) => b.bytes - a.bytes || b.files - a.files);
  result.needsConfirmation = result.onlineOnly.files > 0;
  result.text = result.needsConfirmation ? result.onlineOnly.providers.map(providerText).join("; ") : null;
  return result;
}
