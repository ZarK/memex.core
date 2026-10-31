import { describeLocation, type DescribeLocationOptions, type LocationDescription } from "./location.js";
import { SYNC_CHECKED_KEYS, type MemexPaths, type SyncCheckedKey } from "./paths.js";
import { describeSize, folderSize, type FolderSize, type FolderSizeOptions } from "./size.js";

export interface LocationWarning {
  key: SyncCheckedKey;
  path: string;
  location: LocationDescription;
  /** The size of the folder now, for a folder that a sync client covers. Null for the other kinds. */
  size: FolderSize | null;
  /** The warning to show, from locationWarningText(). */
  text: string;
}

const LABELS: Record<SyncCheckedKey, string> = {
  data: "data",
  cache: "cache",
  logs: "log",
  state: "state",
  packs: "pack",
  apps: "app registration",
};

/**
 * The warning for one folder that is not a plain local folder. The app shows it and keeps working: the user
 * decides. Returns null for a local folder.
 */
export function locationWarningText(warning: {
  key: SyncCheckedKey;
  path: string;
  location: LocationDescription;
  size?: FolderSize | null;
}): string | null {
  const { key, path, location } = warning;
  const folder = `The ${LABELS[key]} folder ${path}`;
  const root = location.root ?? path;
  switch (location.kind) {
    case "local":
      return null;
    case "sync": {
      const client = location.provider ?? "a sync client";
      const size = warning.size ?? null;
      const upload =
        size === null || (size.complete && size.bytes === 0)
          ? `${client} uploads every change in it.`
          : `${client} will upload ${describeSize(size)} now, and every change after that.`;
      const risk =
        key === "data"
          ? `${client} can copy a database while the app writes to it, and that copy can be damaged. ` +
            `To be safe, move the folder out of ${root}, or stop ${client} from synchronizing it.`
          : key === "state" || key === "logs"
            ? `The files in it belong to this computer only, so other devices do not need them.`
            : `The app can make or download these files again, so synchronizing them uses space and bandwidth for nothing.`;
      return `${folder} is in ${root}, which ${client} synchronizes. ${upload} ${risk} Memex keeps working.`;
    }
    case "network":
      return (
        `${folder} is on a network share (${root}). A database on a network share can be damaged when two computers ` +
        `write to it, and the app stops when the share is not available. A folder on this computer is safer. Memex keeps working.`
      );
    case "removable":
      return (
        `${folder} is on a removable or external drive (${root}). When the drive is not connected, the app stops and ` +
        `tells you; it does not make an empty folder in its place. Memex keeps working.`
      );
    case "virtualized":
      return (
        `${folder} is in a folder that Windows keeps for this app package only (${root}). Other apps and your backup ` +
        `tool may not find it there, and Windows deletes it when you uninstall the app. Memex keeps working.`
      );
  }
}

/**
 * One warning per checked folder (data, cache, logs, state, packs, apps) that is not a plain local folder, with a
 * size estimate for folders that a sync client covers. The archive is exempt: it is made to be synchronized.
 */
export async function locationWarnings(
  paths: Partial<MemexPaths>,
  options: DescribeLocationOptions & { size?: FolderSizeOptions },
): Promise<LocationWarning[]> {
  const out: LocationWarning[] = [];
  for (const key of SYNC_CHECKED_KEYS) {
    const value = paths[key];
    if (value === undefined) continue;
    const location = describeLocation(value, options);
    if (location.kind === "local") continue;
    const size = location.kind === "sync" ? await folderSize(value, options.size) : null;
    out.push({ key, path: location.path, location, size, text: locationWarningText({ key, path: location.path, location, size })! });
  }
  return out;
}
