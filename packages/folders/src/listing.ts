import path from "node:path";
import { icloudStubName, isHidden, isOnlineOnly, isSystemFolderName } from "./attributes.js";
import { FolderListingError } from "./errors.js";
import { idReliabilityOf, joinPath, pathKey } from "./keys.js";
import { posixBackend } from "./posix.js";
import type { FolderListing, ListedFile, ListingBackend, ListingWarning, RawEntry } from "./types.js";
import { windowsBackend } from "./windows.js";

export interface ListFolderOptions {
  /** Defaults to the backend for this platform. A backend passed in is not closed. */
  backend?: ListingBackend;
  /** Include hidden files and folders (a name that starts with ".", or the hidden or system attribute). Default false. */
  includeHidden?: boolean;
  /** Leave out a relative path. Called for folders before they are entered and for files. */
  ignore?: (relativePath: string, isFolder: boolean) => boolean;
  /** Folders listed at the same time. Default 8. */
  concurrency?: number;
  signal?: AbortSignal;
  /** Called after each folder with the files and folders listed so far. */
  onProgress?: (progress: { files: number; folders: number }) => void;
}

/** The backend for the platform that runs the code. */
export function defaultBackend(): ListingBackend {
  return process.platform === "win32" ? windowsBackend() : posixBackend();
}

interface FolderResult {
  relative: string;
  files: ListedFile[];
  subfolders: string[];
}

/**
 * Lists the files below a folder without reading or downloading any of them (contracts/folder-scan.md, Listing).
 * Links are never followed. A folder that cannot be listed is reported, and nothing below it is checked.
 * Throws FolderListingError when the root is relative, missing, or not a folder.
 */
export async function listFolder(root: string, options: ListFolderOptions = {}): Promise<FolderListing> {
  const started = performance.now();
  const backend = options.backend ?? defaultBackend();
  const own = options.backend === undefined;
  const p = backend.platform === "win32" ? path.win32 : path.posix;
  if (!p.isAbsolute(root)) throw new FolderListingError("relative-path", `The folder must be an absolute path: ${root}`);
  const absoluteRoot = p.resolve(root);
  try {
    const first = await backend.readFolder(absoluteRoot);
    if (!first.complete) {
      throw first.code === "missing"
        ? new FolderListingError("missing", `The folder ${absoluteRoot} was not found. If it is on a drive, connect the drive and try again.`)
        : new FolderListingError("not-a-folder", `The folder ${absoluteRoot} could not be listed: ${first.error}`);
    }
    const volume = await backend.volume(absoluteRoot);
    const listing: FolderListing = {
      root: absoluteRoot,
      platform: backend.platform,
      fileSystem: volume.fileSystem,
      idReliability: idReliabilityOf(volume.fileSystem),
      ignoresCase: volume.ignoresCase,
      files: [],
      listedFolders: [],
      unlistedFolders: [],
      skippedFolders: [],
      skippedFiles: [],
      links: [],
      warnings: [],
      complete: true,
      elapsedMs: 0,
    };
    const visited = new Set<string>();
    let fileCount = 0;
    let folderCount = 0;

    const warn = (w: ListingWarning): void => {
      listing.warnings.push(w);
    };

    const handle = (relative: string, folder: Awaited<ReturnType<ListingBackend["readFolder"]>>): FolderResult | null => {
      if (!folder.complete) return null;
      if (folder.folderId !== null) {
        const key = `${folder.volumeId ?? ""}\n${folder.folderId}`;
        if (visited.has(key)) {
          warn({ code: "folder-loop", path: relative, message: "Skipped a folder that this listing already listed (a mount or link loop)." });
          // Not listed: the scan does not check entries below it (the other view of the folder holds them).
          listing.skippedFolders.push(relative);
          return null;
        }
        visited.add(key);
      }
      const files: ListedFile[] = [];
      const subfolders: string[] = [];
      const seenKeys = new Set<string>();
      const seenNormalized = new Set<string>();
      const folderKeys = new Set<string>();
      const folderNormalized = new Set<string>();
      const entries = [...folder.entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const entry of entries) {
        const relativePath = joinPath(relative, entry.name);
        if (entry.invalidName === true) {
          warn({ code: "name-not-unicode", path: relative, message: "Skipped a name that is not valid Unicode." });
          continue;
        }
        if (entry.type === "link") {
          listing.links.push(relativePath);
          continue;
        }
        if (entry.type === "folder") {
          const key = pathKey(entry.name, listing.ignoresCase);
          const normalized = pathKey(entry.name, false);
          if (folderKeys.has(key)) {
            // Two folder names with one key would merge into one folder of the journal: the first in ordinal order is it.
            warn(
              folderNormalized.has(normalized)
                ? { code: "names-collide-after-normalization", path: relativePath, message: "Skipped a folder whose name equals another after Unicode normalization." }
                : { code: "names-collide-by-case", path: relativePath, message: "Skipped a folder whose name differs from another only in letter case." },
            );
            listing.skippedFolders.push(relativePath);
            continue;
          }
          folderKeys.add(key);
          folderNormalized.add(normalized);
          if (isSystemFolderName(entry.name) || (!options.includeHidden && isHidden(entry)) || options.ignore?.(relativePath, true) === true) {
            listing.skippedFolders.push(relativePath);
          } else {
            subfolders.push(relativePath);
          }
          continue;
        }
        if (entry.type !== "file") continue;
        // iCloud Drive stubs exist only on macOS; a ".<name>.icloud" file copied elsewhere is an ordinary file.
        const stub = backend.platform === "darwin" ? icloudStubName(entry.name) : null;
        const name = stub ?? entry.name;
        const filePath = joinPath(relative, name);
        const key = pathKey(name, listing.ignoresCase);
        const normalized = pathKey(name, false);
        if (seenKeys.has(key)) {
          warn(
            seenNormalized.has(normalized)
              ? { code: "names-collide-after-normalization", path: filePath, message: "Skipped a file whose name equals another after Unicode normalization." }
              : { code: "names-collide-by-case", path: filePath, message: "Skipped a file whose name differs from another only in letter case." },
          );
          listing.skippedFiles.push(filePath);
          continue;
        }
        seenKeys.add(key);
        seenNormalized.add(normalized);
        if ((stub === null && !options.includeHidden && isHidden(entry)) || options.ignore?.(filePath, false) === true) {
          listing.skippedFiles.push(filePath);
          continue;
        }
        files.push(toListed(filePath, entry, stub !== null, folder.volumeId));
      }
      return { relative, files, subfolders };
    };

    // Breadth first: every folder of one depth, in name order, before any folder below them.
    let level: string[] = [];
    const rootResult = handle("", first);
    const results: FolderResult[] = [];
    if (rootResult !== null) {
      results.push(rootResult);
      level = rootResult.subfolders;
      fileCount += rootResult.files.length;
      folderCount++;
    }
    const concurrency = Math.max(1, options.concurrency ?? 8);
    while (level.length > 0) {
      const next: string[] = [];
      // The workers only read; the folders are handled in walk order after the level is read, so which of two views
      // of one folder (a bind mount) is listed and which is skipped as a loop does not depend on timing.
      const raws = new Array<Awaited<ReturnType<ListingBackend["readFolder"]>>>(level.length);
      let index = 0;
      const workers = Array.from({ length: Math.min(concurrency, level.length) }, async () => {
        while (index < level.length) {
          options.signal?.throwIfAborted();
          const i = index++;
          raws[i] = await backend.readFolder(p.join(absoluteRoot, ...level[i]!.split("/")));
        }
      });
      await Promise.all(workers);
      for (let i = 0; i < level.length; i++) {
        const relative = level[i]!;
        const raw = raws[i]!;
        if (!raw.complete) {
          const gone = raw.code === "missing" && !(await backend.exists(p.join(absoluteRoot, ...relative.split("/"))));
          listing.unlistedFolders.push({ path: relative, error: raw.error, gone });
          warn({ code: gone ? "folder-gone" : "folder-not-listed", path: relative, message: gone ? "A folder went away during the listing." : "A folder could not be listed; nothing below it was checked." });
          continue;
        }
        const r = handle(relative, raw);
        if (r === null) continue;
        results.push(r);
        next.push(...r.subfolders);
        folderCount++;
        fileCount += r.files.length;
        options.onProgress?.({ files: fileCount, folders: folderCount });
      }
      level = next;
    }
    for (const r of results) {
      listing.listedFolders.push(r.relative);
      for (const f of r.files) listing.files.push(f);
    }
    listing.unlistedFolders.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    listing.complete = listing.unlistedFolders.length === 0;
    listing.elapsedMs = Math.round(performance.now() - started);
    return listing;
  } finally {
    if (own) await backend.close();
  }
}

function toListed(filePath: string, entry: RawEntry, stub: boolean, volumeId: string | null): ListedFile {
  return {
    path: filePath,
    size: stub ? 0 : entry.size,
    modifiedMs: entry.modifiedMs,
    createdMs: entry.createdMs,
    fileId: stub ? null : entry.fileId,
    volumeId: stub || entry.fileId === null ? null : volumeId,
    onlineOnly: stub || isOnlineOnly(entry),
    sizeKnown: !stub,
    attributes: entry.attributes,
  };
}
