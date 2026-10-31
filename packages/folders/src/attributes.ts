import type { RawEntry } from "./types.js";

/** Windows file attributes that the listing reads. */
export const FILE_ATTRIBUTE = {
  READONLY: 0x1,
  HIDDEN: 0x2,
  SYSTEM: 0x4,
  DIRECTORY: 0x10,
  ARCHIVE: 0x20,
  SPARSE_FILE: 0x200,
  REPARSE_POINT: 0x400,
  OFFLINE: 0x1000,
  RECALL_ON_OPEN: 0x40000,
  PINNED: 0x80000,
  UNPINNED: 0x100000,
  RECALL_ON_DATA_ACCESS: 0x400000,
} as const;

/** The attributes that say a file's bytes are not on this device. */
export const ONLINE_ONLY_ATTRIBUTES = FILE_ATTRIBUTE.OFFLINE | FILE_ATTRIBUTE.RECALL_ON_OPEN | FILE_ATTRIBUTE.RECALL_ON_DATA_ACCESS;

/** The bit of a reparse tag that says the reparse point names another file: a link. */
export const REPARSE_TAG_NAME_SURROGATE = 0x20000000;

/** macOS SF_DATALESS: the file's bytes are not on this device; reading them downloads them. */
export const SF_DATALESS = 0x40000000;

/** The name of an iCloud Drive stub for a file that is not downloaded (macOS before 14): ".<name>.icloud". */
export function icloudStubName(name: string): string | null {
  const match = /^\.(.+)\.icloud$/.exec(name);
  return match === null ? null : match[1]!;
}

/**
 * Whether an entry's bytes are online only. A cloud reparse tag alone does not say so: a file that the sync client
 * has downloaded keeps its tag but has none of these attributes, and reading it downloads nothing.
 */
export function isOnlineOnly(entry: Pick<RawEntry, "attributes" | "flags">): boolean {
  return (entry.attributes & ONLINE_ONLY_ATTRIBUTES) !== 0 || (entry.flags & SF_DATALESS) !== 0;
}

/** Whether a reparse tag is a link (a symbolic link, a junction, or another name surrogate). */
export function isLinkTag(tag: number): boolean {
  return ((tag >>> 0) & REPARSE_TAG_NAME_SURROGATE) !== 0;
}

/** Folder names that belong to the operating system or a storage device. They are never entered. */
const SYSTEM_FOLDERS = new Set([
  ".spotlight-v100",
  ".trashes",
  ".documentrevisions-v100",
  ".fseventsd",
  "system volume information",
  "$recycle.bin",
  "lost+found",
  // Synology and QNAP keep their thumbnails, recycle bins and snapshots in the shares.
  "@eadir",
  "#recycle",
  "#snapshot",
  "@recycle",
  "@recently-snapshot",
  ".@__thumb",
  ".@__qini",
]);

export function isSystemFolderName(name: string): boolean {
  const lower = name.toLowerCase();
  return SYSTEM_FOLDERS.has(lower) || lower.startsWith(".trash-");
}

/** Hidden: a name that starts with ".", or the Windows hidden or system attribute. */
export function isHidden(entry: Pick<RawEntry, "name" | "attributes">): boolean {
  return entry.name.startsWith(".") || (entry.attributes & (FILE_ATTRIBUTE.HIDDEN | FILE_ATTRIBUTE.SYSTEM)) !== 0;
}
