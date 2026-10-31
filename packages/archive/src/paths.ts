import os from "node:os";
import path from "node:path";

/** Where the code runs. Every field defaults to the current process. */
export interface ArchiveContext {
  platform?: string;
  env?: Readonly<Record<string, string | undefined>>;
  home?: string;
}

interface Resolved {
  p: path.PlatformPath;
  platform: string;
  env: Readonly<Record<string, string | undefined>>;
  home: string;
}

function resolveContext(ctx: ArchiveContext = {}): Resolved {
  const platform = ctx.platform ?? process.platform;
  return {
    p: platform === "win32" ? path.win32 : path.posix,
    platform,
    env: ctx.env ?? process.env,
    home: ctx.home ?? os.homedir(),
  };
}

export class ArchivePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchivePathError";
  }
}

function isAbsolute(p: path.PlatformPath, value: string): boolean {
  if (p === path.win32) return /^[A-Za-z]:[\\/]/.test(value) || /^[\\/]{2}[^\\/]/.test(value);
  return p.isAbsolute(value);
}

function clean(p: path.PlatformPath, value: string): string {
  let out = p.normalize(value);
  const root = p.parse(out).root;
  while (out.length > root.length && out.endsWith(p.sep)) out = out.slice(0, -1);
  return out;
}

function absolute(p: path.PlatformPath, name: string, value: string | undefined): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (!isAbsolute(p, value)) throw new ArchivePathError(`${name} must be an absolute path: ${value}`);
  return clean(p, value);
}

function lenient(p: path.PlatformPath, value: string | undefined): string | undefined {
  if (value === undefined || value === "" || !isAbsolute(p, value)) return undefined;
  return clean(p, value);
}

/**
 * The archive root (contracts/archive.md, Root): the flag, then MEMEX_ARCHIVE_HOME,
 * then MEMEX_HOME/Archive, then ~/Memex/Archive. The same rule as memexPaths().archive.
 */
export function resolveArchiveRoot(options: ArchiveContext & { flag?: string } = {}): string {
  const { p, env, home } = resolveContext(options);
  const flag = absolute(p, "--root", options.flag);
  if (flag !== undefined) return flag;
  const archiveHome = absolute(p, "MEMEX_ARCHIVE_HOME", env.MEMEX_ARCHIVE_HOME);
  if (archiveHome !== undefined) return archiveHome;
  const memexHome = absolute(p, "MEMEX_HOME", env.MEMEX_HOME);
  const h = absolute(p, "home", home);
  if (h === undefined) throw new ArchivePathError("The home folder is not set");
  return p.join(memexHome ?? p.join(h, "Memex"), "Archive");
}

/** The OS cache folder of the app id "archive" (contracts/storage.md). Run locks live here. */
export function archiveCacheDir(ctx: ArchiveContext = {}): string {
  const { p, platform, env, home } = resolveContext(ctx);
  const h = absolute(p, "home", home);
  if (h === undefined) throw new ArchivePathError("The home folder is not set");
  if (platform === "win32") {
    const local = lenient(p, env.LOCALAPPDATA) ?? p.join(h, "AppData", "Local");
    return p.join(local, "Memex", "Archive", "Cache");
  }
  if (platform === "darwin") return p.join(h, "Library", "Caches", "Memex", "Archive");
  const xdgCache = lenient(p, env.XDG_CACHE_HOME) ?? p.join(h, ".cache");
  return p.join(xdgCache, "memex", "archive");
}
