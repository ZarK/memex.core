/** What a listing backend reports for one entry of a folder. Nothing is opened to read it. */
export interface RawEntry {
  name: string;
  /** "link" is a symbolic link, a junction, or another name-surrogate reparse point. It is never followed. */
  type: "file" | "folder" | "link" | "other";
  size: number;
  /** UTC milliseconds since 1970, an integer. */
  modifiedMs: number;
  /** UTC milliseconds since 1970, or null when the file system keeps no creation time. */
  createdMs: number | null;
  /** Windows file attributes. 0 on other systems. */
  attributes: number;
  /** The Windows reparse tag of a reparse point. 0 otherwise. */
  reparseTag: number;
  /** The BSD file flags on macOS (st_flags). 0 elsewhere, and 0 when they were not read. */
  flags: number;
  /** The file id on its volume, as lowercase hex; null when the platform gives none. */
  fileId: string | null;
  /** True when the name is not valid Unicode (a byte name on Linux, a lone surrogate on Windows). */
  invalidName?: boolean;
}

/** One folder as a backend lists it. */
export type RawFolder =
  | {
      complete: true;
      /** The volume of the folder after any link at its own path; null when the platform gives none. */
      volumeId: string | null;
      /** The file id of the folder itself, for the loop check; null when the platform gives none. */
      folderId: string | null;
      entries: RawEntry[];
    }
  | {
      complete: false;
      /** "missing": the folder is not there. "unreadable": it is there but could not be listed. */
      code: "missing" | "unreadable";
      error: string;
    };

/** The file system facts of a listing root. */
export interface VolumeFacts {
  /** "ntfs", "refs", "apfs", "hfsplus", "ext4", "xfs", "btrfs", "zfs", "fat32", "exfat", "smb", or "unknown". */
  fileSystem: string;
  /** Whether names that differ only in letter case are the same file. */
  ignoresCase: boolean;
}

/** Lists folders for listFolder(). The Windows, POSIX, and fixture backends implement it. */
export interface ListingBackend {
  /** "win32", "darwin", "linux", or another Node.js platform name. Decides path forms. */
  readonly platform: string;
  readFolder(absolutePath: string): Promise<RawFolder>;
  volume(root: string): Promise<VolumeFacts>;
  /** Whether a folder exists (a following check after a listing failed). */
  exists(absolutePath: string): Promise<boolean>;
  close(): Promise<void>;
}

/** How much a matching file id proves: see contracts/folder-scan.md, File ids. */
export type IdReliability = "strong" | "weak" | "unusable";

/** One file of a listing. */
export interface ListedFile {
  /** Relative to the root, with "/" separators. */
  path: string;
  size: number;
  modifiedMs: number;
  createdMs: number | null;
  fileId: string | null;
  volumeId: string | null;
  /** The bytes are not on this device: reading the file makes the sync client download it. */
  onlineOnly: boolean;
  /** False for an iCloud ".<name>.icloud" stub, whose size is not known without reading it. */
  sizeKnown: boolean;
  attributes: number;
}

export type ListingWarningCode =
  | "name-not-unicode"
  | "names-collide-by-case"
  | "names-collide-after-normalization"
  | "folder-not-listed"
  | "folder-gone"
  | "folder-loop";

export interface ListingWarning {
  code: ListingWarningCode;
  /** Relative path of the folder or file. */
  path: string;
  message: string;
}

export interface FolderListing {
  /** The absolute root that was listed. */
  root: string;
  platform: string;
  fileSystem: string;
  idReliability: IdReliability;
  ignoresCase: boolean;
  /** Files in walk order: folders by depth then name, each folder's files by name (ordinal). */
  files: ListedFile[];
  /** Relative paths of the folders listed completely, "" for the root, in walk order. */
  listedFolders: string[];
  /** Folders that could not be listed: nothing below them was checked. */
  unlistedFolders: Array<{ path: string; error: string; gone: boolean }>;
  /** Folders that were not entered: hidden, system, ignored, or a loop. Their files are not checked. */
  skippedFolders: string[];
  /** Files that the listing saw but left out (hidden, ignored, a name collision). They are not checked. */
  skippedFiles: string[];
  /** Links (files and folders) that were not followed. */
  links: string[];
  warnings: ListingWarning[];
  /** True when every folder that was entered was listed completely. */
  complete: boolean;
  /** Milliseconds the listing took. */
  elapsedMs: number;
}
