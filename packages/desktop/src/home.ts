import { realpathSync } from "node:fs";
import path from "node:path";

/** The folders of an app that the shell uses: memexPaths() of @tjalve/memex-storage, or the app's own. */
export interface ShellPaths {
  data: string;
  cache: string;
  logs: string;
  state: string;
}

function pathApi(platform: string): path.PlatformPath {
  return platform === "win32" ? path.win32 : path.posix;
}

/** A path with every existing part resolved, so that a link cannot hide where it points. */
export function concretePath(value: string, platform: string = process.platform): string {
  const p = pathApi(platform);
  const resolved = p.resolve(String(value));
  if (platform !== process.platform) return resolved;
  try {
    return realpathSync(resolved);
  } catch {
    const missing: string[] = [];
    let current = resolved;
    for (;;) {
      const parent = p.dirname(current);
      if (parent === current) return resolved;
      missing.unshift(p.basename(current));
      try {
        return p.join(realpathSync(parent), ...missing);
      } catch {
        current = parent;
      }
    }
  }
}

/** The folder the app is installed in, or null when it runs unpackaged. On macOS it is the .app bundle. */
export function packagedInstallDirectory(input: { packaged: boolean; platform?: string; exePath?: string }): string | null {
  const platform = input.platform ?? process.platform;
  if (!input.packaged || !input.exePath) return null;
  const p = pathApi(platform);
  const exeDirectory = p.dirname(input.exePath);
  const parts = exeDirectory.split(/[\\/]/).filter(Boolean);
  if (platform === "darwin" && parts.at(-1) === "MacOS" && parts.at(-2) === "Contents") {
    return p.resolve(exeDirectory, "..", "..");
  }
  return exeDirectory;
}

/** Whether candidate is parent or inside it, after links are resolved. Case-insensitive on Windows. */
export function isInsideDirectory(candidate: string, parent: string | null, platform: string = process.platform): boolean {
  if (!parent) return false;
  const p = pathApi(platform);
  let child = concretePath(candidate, platform);
  let root = concretePath(parent, platform);
  if (platform === "win32") {
    child = child.toLowerCase();
    root = root.toLowerCase();
  }
  if (child === root) return true;
  const prefix = root.endsWith(p.sep) ? root : root + p.sep;
  return child.startsWith(prefix);
}

/**
 * Refuses folders inside the installation folder: an update or an uninstall replaces that folder, and the user's
 * data must never be there.
 */
export function assertOutsideInstall(paths: ShellPaths, installDirectory: string | null, platform: string = process.platform): void {
  for (const key of ["data", "state", "cache", "logs"] as const) {
    if (isInsideDirectory(paths[key], installDirectory, platform)) {
      throw new Error(`The ${key} folder ${paths[key]} is inside the installation folder ${installDirectory}. Choose a folder outside it.`);
    }
  }
}
