import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface AppLockInfo {
  app: string;
  data: string;
  pid: number;
  hostname: string;
  startedAt: string;
}

export class AppLockedError extends Error {
  readonly code = "locked";
  readonly holder: AppLockInfo | null;
  constructor(app: string, data: string, holder: AppLockInfo | null) {
    super(
      `Another ${app} is already running with the data folder ${data}` +
        (holder ? ` (process ${holder.pid}, started ${holder.startedAt}).` : ".") +
        " Close it first, or switch to it.",
    );
    this.name = "AppLockedError";
    this.holder = holder;
  }
}

export interface AppLock {
  path: string;
  release(): Promise<void>;
}

export interface AppLockOptions {
  app: string;
  /** The app's data folder. One instance runs per app and data folder. */
  data: string;
  /** The app's state folder (memexPaths().state). The lock lives in <state>/locks, never in the data folder. */
  state: string;
  /** The system boot time in ms since the epoch. Defaults to Date.now() - os.uptime() * 1000. */
  bootTime?: number;
}

/** A lock taken this long before the computed boot time is from before the boot. Covers the rounding of os.uptime(). */
const BOOT_MARGIN_MS = 10_000;
const CLAIM_ATTEMPTS = 4;

/** The lock file of an app and data folder: <state>/locks/<first 16 hex of sha256(app + data folder)>.lock. */
export function appLockPath(options: { app: string; data: string; state: string; platform?: string }): string {
  const data = path.resolve(options.data);
  const key = `${options.app}\n${(options.platform ?? process.platform) === "win32" ? data.toLowerCase() : data}`;
  const name = createHash("sha256").update(key).digest("hex").slice(0, 16);
  return path.join(options.state, "locks", `${name}.lock`);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readLock(file: string): Promise<AppLockInfo | null> {
  try {
    const value = JSON.parse(await fs.readFile(file, "utf8")) as AppLockInfo;
    return typeof value.pid === "number" ? value : null;
  } catch {
    return null;
  }
}

function sameLock(a: AppLockInfo, b: AppLockInfo): boolean {
  return a.pid === b.pid && a.hostname === b.hostname && a.startedAt === b.startedAt;
}

/** A lock file that cannot be read (a crash while it was written) is stale after a minute. */
async function unreadableAndOld(file: string): Promise<boolean> {
  try {
    return Date.now() - (await fs.stat(file)).mtimeMs > 60_000;
  } catch {
    return true;
  }
}

/** A lock is stale when it was taken before the last boot, or its process is gone. */
function staleHolder(holder: AppLockInfo, bootTime: number): boolean {
  const startedAt = Date.parse(holder.startedAt);
  if (!Number.isNaN(startedAt) && startedAt < bootTime - BOOT_MARGIN_MS) return true;
  return holder.pid !== process.pid && !processAlive(holder.pid);
}

/**
 * Moves a stale lock to a unique name, so that of two instances that both judged it stale only one takes it over.
 * Puts it back when it turns out to be a fresh lock that another instance took in between.
 */
async function claimStaleLock(file: string, judged: AppLockInfo | null): Promise<"retry" | { holder: AppLockInfo | null }> {
  const quarantine = `${file}.stale-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    await fs.rename(file, quarantine);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EPERM" || code === "EBUSY" || code === "EACCES") return "retry";
    throw error;
  }
  const moved = await readLock(quarantine);
  const same = judged === null ? moved === null && (await unreadableAndOld(quarantine)) : moved !== null && sameLock(moved, judged);
  if (!same) {
    try {
      await fs.link(quarantine, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") await fs.rename(quarantine, file);
    }
  }
  await fs.rm(quarantine, { force: true });
  return same ? "retry" : { holder: moved };
}

/**
 * Takes the lock that lets one instance of an app run per data folder. The lock lives in the app's state folder,
 * which is machine-local, so a sync client does not copy it. A lock whose process is gone, or that was taken
 * before the last boot, is taken over. Throws AppLockedError when another live instance holds it.
 */
export async function acquireAppLock(options: AppLockOptions): Promise<AppLock> {
  const file = appLockPath(options);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const info: AppLockInfo = {
    app: options.app,
    data: path.resolve(options.data),
    pid: process.pid,
    hostname: os.hostname(),
    startedAt: new Date().toISOString(),
  };
  const bootTime = options.bootTime ?? Date.now() - os.uptime() * 1000;
  let holder: AppLockInfo | null = null;
  for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt++) {
    try {
      const handle = await fs.open(file, "wx");
      try {
        await handle.writeFile(JSON.stringify(info) + "\n");
      } finally {
        await handle.close();
      }
      let released = false;
      return {
        path: file,
        async release() {
          if (released) return;
          released = true;
          const current = await readLock(file);
          if (current !== null && sameLock(current, info)) await fs.rm(file, { force: true });
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      holder = await readLock(file);
      const stale =
        holder === null ? await unreadableAndOld(file) : holder.hostname === info.hostname && staleHolder(holder, bootTime);
      if (!stale) throw new AppLockedError(options.app, info.data, holder);
      const claim = await claimStaleLock(file, holder);
      if (claim !== "retry") throw new AppLockedError(options.app, info.data, claim.holder);
    }
  }
  throw new AppLockedError(options.app, info.data, holder);
}
