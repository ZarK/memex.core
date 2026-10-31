import fs from "node:fs/promises";
import path from "node:path";

export interface FolderSizeOptions {
  /** Stop counting when the total reaches this many bytes. Default 100 GB. */
  limitBytes?: number;
  /** Stop counting after this many milliseconds. Default 2000. */
  timeBudgetMs?: number;
  /** The clock, in milliseconds. Defaults to performance.now(). */
  now?: () => number;
}

export interface FolderSize {
  /** The bytes counted. When `complete` is false, the folder holds at least this much. */
  bytes: number;
  files: number;
  /** True when every file was counted. */
  complete: boolean;
  /** Why the count stopped early: "limit" (the total reached limitBytes) or "time" (the budget ran out). */
  stoppedBy: "limit" | "time" | null;
  /** Folders and files that could not be read, and were left out. */
  skipped: number;
}

export const DEFAULT_SIZE_LIMIT_BYTES = 100 * 1000 ** 3;
export const DEFAULT_SIZE_TIME_BUDGET_MS = 2000;

/**
 * The size of a folder and everything in it, counted until a byte limit or a time budget stops it. When the folder
 * itself is a symbolic link or junction, it counts the folder the link points to; it does not follow links inside
 * the folder. It reads only file metadata, so it does not download online-only files.
 * A missing folder has size 0.
 */
export async function folderSize(dir: string, options: FolderSizeOptions = {}): Promise<FolderSize> {
  const limit = options.limitBytes ?? DEFAULT_SIZE_LIMIT_BYTES;
  const budget = options.timeBudgetMs ?? DEFAULT_SIZE_TIME_BUDGET_MS;
  const now = options.now ?? (() => performance.now());
  const deadline = now() + budget;
  const out: FolderSize = { bytes: 0, files: 0, complete: true, stoppedBy: null, skipped: 0 };
  const stop = (why: "limit" | "time"): FolderSize => ({ ...out, complete: false, stoppedBy: why });

  try {
    const top = await fs.stat(dir);
    if (!top.isDirectory()) return { ...out, bytes: top.size, files: top.isFile() ? 1 : 0 };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return out;
    return { ...out, complete: false, skipped: 1 };
  }

  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      out.skipped++;
      continue;
    }
    for (const entry of entries) {
      if (now() > deadline) return stop("time");
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        try {
          out.bytes += (await fs.lstat(full)).size;
          out.files++;
        } catch {
          out.skipped++;
        }
        if (out.bytes >= limit) return stop("limit");
      }
    }
  }
  if (out.skipped > 0) out.complete = false;
  return out;
}

/** A byte count for people: "0 bytes", "512 bytes", "3.2 MB", "38 GB". Units of 1000. */
export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} ${bytes === 1 ? "byte" : "bytes"}`;
  const units = ["KB", "MB", "GB", "TB", "PB"];
  let value = bytes;
  let unit = -1;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  const rounded = value < 10 ? Math.round(value * 10) / 10 : Math.round(value);
  if (rounded >= 1000 && unit < units.length - 1) return `1 ${units[unit + 1]}`;
  return `${rounded} ${units[unit]}`;
}

/** A size estimate for people: "about 3.2 GB", "more than 100 GB" (limit), "at least 3.2 GB" (time). */
export function describeSize(size: FolderSize): string {
  if (size.stoppedBy === "limit") return `more than ${formatBytes(size.bytes)}`;
  if (!size.complete) return `at least ${formatBytes(size.bytes)}`;
  return `about ${formatBytes(size.bytes)}`;
}
