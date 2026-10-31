import path from "node:path";
import type { MemexPaths } from "./paths.js";

/** The folders an Electron app uses under the storage contract. */
export interface ElectronPaths {
  /** The app's own user data (databases, settings): memexPaths().data. Electron does not write here. */
  data: string;
  /** app.setPath("userData"): Chromium's profile (local storage, IndexedDB, cookies, preferences). Machine-local. */
  userData: string;
  /** app.setPath("sessionData"): data that Electron sessions keep. */
  sessionData: string;
  /** app.setPath("logs"). */
  logs: string;
  /** app.setPath("crashDumps"). */
  crashDumps: string;
  /** The value of the --disk-cache-dir switch: Chromium's HTTP, code, and GPU caches. */
  diskCache: string;
}

/**
 * The folders an Electron app sets before the app is ready, so that Chromium writes nothing in %APPDATA% or
 * ~/.config and nothing in the user's data folder. Pure. Usage, in the main process before app.whenReady():
 *
 *   const e = electronPaths(currentMemexPaths("study"));
 *   app.setPath("userData", e.userData);
 *   app.setPath("sessionData", e.sessionData);
 *   app.setPath("logs", e.logs);
 *   app.setPath("crashDumps", e.crashDumps);
 *   app.commandLine.appendSwitch("disk-cache-dir", e.diskCache);
 *
 * Anything the user would lose (settings, UI preferences, notes) belongs in `data`, not in Chromium's local storage.
 */
export function electronPaths(paths: Pick<MemexPaths, "data" | "cache" | "logs" | "state">, options: { platform?: string } = {}): ElectronPaths {
  const p = (options.platform ?? process.platform) === "win32" ? path.win32 : path.posix;
  return {
    data: paths.data,
    userData: p.join(paths.state, "Electron"),
    sessionData: p.join(paths.state, "Electron"),
    logs: paths.logs,
    crashDumps: p.join(paths.logs, "Crashes"),
    diskCache: p.join(paths.cache, "Chromium"),
  };
}
