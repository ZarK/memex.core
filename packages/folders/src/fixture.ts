import type { ListingBackend, RawEntry, RawFolder, VolumeFacts } from "./types.js";

/** One entry of a fixture folder. Missing fields default to a plain local file. */
export interface FixtureEntry extends Partial<RawEntry> {
  name: string;
}

/** A fixture tree: folders by relative path ("" is the root), each a list of entries or an error. */
export interface FixtureTree {
  platform?: string;
  fileSystem?: string;
  ignoresCase?: boolean;
  volumeId?: string;
  /** A folder's id by relative path; default "folder:<path>". Two folders with one id are one folder seen twice (a bind mount). */
  folderIds?: Record<string, string>;
  folders: Record<string, FixtureEntry[] | { error: "missing" | "unreadable" }>;
}

/**
 * A backend over a fixture tree, for tests and the contract fixtures. The root is "/fixture" (POSIX paths). A folder
 * entry whose folder is not in the tree is an empty folder.
 */
export function fixtureBackend(tree: FixtureTree, root = "/fixture"): ListingBackend {
  const relative = (absolutePath: string): string => (absolutePath === root ? "" : absolutePath.slice(root.length + 1));
  return {
    platform: tree.platform ?? "linux",
    async readFolder(absolutePath: string): Promise<RawFolder> {
      const rel = relative(absolutePath);
      const folder = tree.folders[rel];
      if (folder !== undefined && !Array.isArray(folder)) {
        return { complete: false, code: folder.error, error: `fixture: ${folder.error}` };
      }
      const entries: RawEntry[] = (folder ?? []).map((e) => ({
        type: "file",
        size: 0,
        modifiedMs: 0,
        createdMs: null,
        attributes: 0,
        reparseTag: 0,
        flags: 0,
        fileId: null,
        ...e,
      }));
      return { complete: true, volumeId: tree.volumeId ?? null, folderId: tree.folderIds?.[rel] ?? `folder:${rel}`, entries };
    },
    async volume(): Promise<VolumeFacts> {
      return { fileSystem: tree.fileSystem ?? "ext4", ignoresCase: tree.ignoresCase ?? false };
    },
    async exists(absolutePath: string): Promise<boolean> {
      const folder = tree.folders[relative(absolutePath)];
      return folder !== undefined && (Array.isArray(folder) || folder.error !== "missing");
    },
    async close(): Promise<void> {},
  };
}
