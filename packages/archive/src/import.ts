import fs from "node:fs/promises";
import path from "node:path";
import { ArchiveError, IMPORTS_DIR, assertRelativePath, importDir } from "./layout.js";
import type { LockOptions } from "./lock.js";
import { openPack } from "./pack.js";
import { openRun } from "./run.js";
import type { ArchiveStatus, FilteredRecord } from "./status.js";

/** The device that an import's manifests and status name. Its domain is "imports". */
export const IMPORT_DEVICE = "import";

export interface ImportOptions extends LockOptions {
  root: string;
  /** The folder to import. It is read only: nothing in it is changed or deleted. */
  folder: string;
  /** The import name: [a-z0-9][a-z0-9._-]{0,63}. */
  name: string;
  /** yyyy-mm-dd. Defaults to today's local date. */
  date?: string;
  now?: Date;
  cacheDir?: string;
  partBytes?: number;
}

export interface ImportFailure {
  id: string;
  error: string;
}

export interface ImportResult {
  /** <root>/imports/<date>-<name>. */
  dir: string;
  /** imports/<date>-<name>, with forward slashes. */
  path: string;
  status: ArchiveStatus;
  /** Whether the import is a successful run. When it is not, status.lastRun.error says why. */
  ok: boolean;
  /** Files stored: the files in the published packs. A file in a part that was not published is not counted. */
  files: number;
  /** Bytes of the stored files, before compression. */
  bytes: number;
  /** The pack files published, relative to the import folder. */
  packs: string[];
  /** Links and other entries that are not files or folders, with the reason. Not followed. */
  skipped: FilteredRecord[];
  /** Files, and folders that could not be read, that could not be stored. Any failure makes the import a failed run. */
  failed: ImportFailure[];
}

/** The local date as yyyy-mm-dd. */
function localDate(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Whether `inner` is `outer` or a path inside it. */
function within(outer: string, inner: string): boolean {
  const rel = path.relative(outer, inner);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

type Found =
  | { kind: "file"; id: string; file: string }
  | { kind: "skip"; id: string; reason: string }
  | { kind: "fail"; id: string; error: string };

/**
 * Walks a folder depth first, in name order, without following links. Yields one entry at a time,
 * so that a large folder is never listed into memory at once. A folder that cannot be read (no
 * permission, removed during the walk) is yielded as a failure, and the walk goes on.
 */
async function* walk(dir: string, prefix: string): AsyncGenerator<Found> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    yield { kind: "fail", id: prefix === "" ? "." : prefix, error: (error as Error).message };
    return;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    const id = prefix === "" ? e.name : `${prefix}/${e.name}`;
    const file = path.join(dir, e.name);
    if (e.isSymbolicLink()) yield { kind: "skip", id, reason: "link, not followed" };
    else if (e.isDirectory()) yield* walk(file, id);
    else if (e.isFile()) yield { kind: "file", id, file };
    else yield { kind: "skip", id, reason: "not a file or folder" };
  }
}

/**
 * Imports a folder as a one-time drop into <root>/imports/<date>-<name>/: every file is stored
 * whole as files/<path> in the packs of one run, with the path relative to the folder as its id,
 * through the same staging and closed writes as a collector run. Links are listed and skipped.
 * The folder is only read. Files are streamed one at a time, so the folder can be any size.
 * Throws ArchiveError "import-exists" when an import with this date and name exists.
 */
export async function importFolder(options: ImportOptions): Promise<ImportResult> {
  const folder = path.resolve(options.folder);
  const stat = await fs.stat(folder).catch(() => null);
  if (stat === null || !stat.isDirectory()) throw new ArchiveError("not-a-folder", `Not a folder: ${options.folder}`);
  const date = options.date ?? localDate(options.now ?? new Date());
  const dir = importDir(options.root, { date, name: options.name });
  if (within(folder, path.resolve(dir))) {
    throw new ArchiveError("import-inside-folder", `The import folder ${dir} would be inside ${folder}`);
  }
  // Creating the folder itself (not recursive) is the refusal: only one import gets it.
  await fs.mkdir(path.dirname(dir), { recursive: true });
  try {
    await fs.mkdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    throw new ArchiveError("import-exists", `An import named ${date}-${options.name} exists already: ${dir}`);
  }

  const source = `${date}-${options.name}`;
  const run = await openRun(dir, { ...options, domain: IMPORTS_DIR, source, device: IMPORT_DEVICE });
  const skipped: FilteredRecord[] = [];
  const failed: ImportFailure[] = [];
  let written = 0;
  let read = 0;
  try {
    for await (const found of walk(folder, "")) {
      read++;
      if (found.kind === "skip") {
        skipped.push({ id: found.id, reason: found.reason });
        continue;
      }
      if (found.kind === "fail") {
        failed.push({ id: found.id, error: found.error });
        continue;
      }
      try {
        assertRelativePath(found.id);
        await run.captureFile(found.file, found.id);
        written++;
      } catch (error) {
        failed.push({ id: found.id, error: (error as Error).message });
      }
    }
  } catch (error) {
    // The walk itself failed: record the run as failed.
    await run.fail(error, { read, written, filtered: skipped.length, failed: failed.length });
    throw error;
  }
  const error =
    failed.length === 0
      ? null
      : `${failed.length} files or folders could not be stored, for example ${failed[0]!.id}: ${failed[0]!.error}`;
  const status = await run.finish({
    counts: { read, written, unchanged: 0, filtered: skipped.length, failed: failed.length },
    filtered: skipped,
    error,
  });
  // Count what was published, not what was staged: a part that could not be finished or published
  // is not in the archive.
  let files = 0;
  let bytes = 0;
  for (const file of status.lastRun.packs) {
    for (const entry of (await openPack(path.join(dir, file))).manifest.entries) {
      if (entry.kind === "full") {
        files++;
        bytes += entry.size;
      }
    }
  }
  return {
    dir,
    path: `${IMPORTS_DIR}/${source}`,
    status,
    ok: status.lastRun.outcome === "success",
    files,
    bytes,
    packs: status.lastRun.packs,
    skipped,
    failed,
  };
}
