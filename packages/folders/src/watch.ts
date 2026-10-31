import { watch as fsWatch, type FSWatcher } from "node:fs";

/** Why the app should scan now. */
export type WatchReason = "start" | "change" | "periodic" | "watch-failed";

export interface WatchOptions {
  /** Called when the app should scan the folder. Always called once with "start". */
  onScan: (reason: WatchReason) => void;
  /** A change starts a scan after the folder has been quiet this long. Default 10 seconds. */
  quietMs?: number;
  /** A scan also runs this often, because a sync client can change files without a change event. Default 30 minutes; 0 for none. */
  periodicMs?: number;
  /** Set false to scan only on start and periodically. Default true. */
  live?: boolean;
  /** For tests: the fs.watch function. */
  watchFn?: typeof fsWatch;
}

export interface FolderWatch {
  /** "live": change events start scans. "scan-on-start": the folder could not be watched; only start and periodic scans run. */
  readonly mode: "live" | "scan-on-start";
  close(): void;
}

/**
 * Keeps a folder current while the app runs: a scan on start, a scan after each burst of changes once the folder is
 * quiet, and a slow periodic scan. When the folder cannot be watched (a network share, too many watches, a platform
 * without recursive watching), or the watch fails later, it falls back to scan-on-start and periodic scans.
 * On macOS, FSEvents can also report changes made just before the watch started, so a "change" scan can follow
 * the start scan without a change after it; a scan is idempotent, so the extra scan is harmless.
 */
export function watchFolder(root: string, options: WatchOptions): FolderWatch {
  const quietMs = options.quietMs ?? 10_000;
  const periodicMs = options.periodicMs ?? 30 * 60 * 1000;
  const watchFn = options.watchFn ?? fsWatch;
  let mode: FolderWatch["mode"] = "scan-on-start";
  let watcher: FSWatcher | null = null;
  let quiet: NodeJS.Timeout | null = null;
  let periodic: NodeJS.Timeout | null = null;
  let closed = false;

  const scan = (reason: WatchReason): void => {
    if (!closed) options.onScan(reason);
  };
  const changed = (): void => {
    if (quiet !== null) clearTimeout(quiet);
    quiet = setTimeout(() => {
      quiet = null;
      scan("change");
    }, quietMs);
    quiet.unref?.();
  };
  const fallBack = (): void => {
    if (mode === "scan-on-start") return;
    mode = "scan-on-start";
    watcher?.close();
    watcher = null;
    scan("watch-failed");
  };

  if (options.live !== false) {
    try {
      watcher = watchFn(root, { recursive: true, persistent: false }, () => changed());
      watcher.on("error", fallBack);
      mode = "live";
    } catch {
      watcher = null;
      mode = "scan-on-start";
    }
  }
  if (periodicMs > 0) {
    periodic = setInterval(() => scan("periodic"), periodicMs);
    periodic.unref?.();
  }
  queueMicrotask(() => scan("start"));

  return {
    get mode() {
      return mode;
    },
    close(): void {
      closed = true;
      if (quiet !== null) clearTimeout(quiet);
      if (periodic !== null) clearInterval(periodic);
      watcher?.close();
      watcher = null;
    },
  };
}
