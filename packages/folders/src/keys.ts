import type { IdReliability } from "./types.js";

/** The key of a relative path or name: Unicode NFC, and upper case where the file system ignores case. */
export function pathKey(relativePath: string, ignoresCase: boolean): string {
  const normalized = relativePath.normalize("NFC");
  return ignoresCase ? normalized.toUpperCase() : normalized;
}

/** The folder ("" at the root) and the name of a relative path with "/" separators. */
export function splitPath(relativePath: string): { folder: string; name: string } {
  const slash = relativePath.lastIndexOf("/");
  return slash < 0 ? { folder: "", name: relativePath } : { folder: relativePath.slice(0, slash), name: relativePath.slice(slash + 1) };
}

export function joinPath(folder: string, name: string): string {
  return folder === "" ? name : `${folder}/${name}`;
}

/** True when `key` is `root` or below it. */
export function isAtOrBelow(key: string, root: string): boolean {
  return root === "" || key === root || (key.length > root.length && key[root.length] === "/" && key.startsWith(root));
}

const TWO_SECONDS = 2000;
const ONE_HOUR = 3_600_000;

/**
 * Whether two modification times are equal. On FAT32 and exFAT, which keep local time in two-second steps, a
 * difference of up to 2 seconds is equal, and so is one of one hour (within 2 seconds), the shift of a
 * daylight-saving change.
 */
export function timesEqual(left: number, right: number, fileSystem: string): boolean {
  if (left === right) return true;
  if (fileSystem !== "fat32" && fileSystem !== "exfat") return false;
  const difference = Math.abs(left - right);
  return difference <= TWO_SECONDS || Math.abs(difference - ONE_HOUR) <= TWO_SECONDS;
}

/** How much a matching file id proves on a file system. */
export function idReliabilityOf(fileSystem: string): IdReliability {
  switch (fileSystem) {
    case "ntfs":
    case "refs":
    case "apfs":
      return "strong";
    case "ext4":
    case "xfs":
    case "btrfs":
    case "zfs":
    case "hfsplus":
    case "smb":
      return "weak";
    default:
      return "unusable";
  }
}

/** A file system name from a driver or mount type name. */
export function fileSystemName(type: string): string {
  switch (type.toLowerCase()) {
    case "ntfs":
    case "ntfs3":
      return "ntfs";
    case "refs":
      return "refs";
    case "apfs":
      return "apfs";
    case "hfs":
    case "hfs+":
    case "hfsplus":
      return "hfsplus";
    case "ext4":
    case "ext3":
    case "ext2":
      return "ext4";
    case "xfs":
      return "xfs";
    case "btrfs":
      return "btrfs";
    case "zfs":
      return "zfs";
    case "fat32":
    case "fat":
    case "fat16":
    case "fat12":
    case "msdos":
    case "vfat":
      return "fat32";
    case "exfat":
      return "exfat";
    case "smbfs":
    case "cifs":
    case "smb2":
    case "smb3":
    case "nfs":
    case "nfs4":
      return "smb";
    default:
      return "unknown";
  }
}
