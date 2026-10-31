import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ArchiveError } from "./layout.js";
import { archiveCacheDir, type ArchiveContext } from "./paths.js";

export class ArchiveLockedError extends ArchiveError {
  readonly holder: LockInfo | null;
  constructor(dir: string, holder: LockInfo | null) {
    super("locked", `Another run holds the lock for ${dir}${holder ? ` (process ${holder.pid} since ${holder.startedAt})` : ""}`);
    this.name = "ArchiveLockedError";
    this.holder = holder;
  }
}

export interface LockInfo {
  pid: number;
  hostname: string;
  startedAt: string;
  dir: string;
}

export interface LockOptions extends ArchiveContext {
  lockDir?: string;
  /** The system boot time in ms since the epoch. Defaults to Date.now() - os.uptime() * 1000. */
  bootTime?: number;
}

/** A lock taken this long before the computed boot time is from before the boot. Covers the rounding of os.uptime(). */
const BOOT_MARGIN_MS = 10_000;

export interface RunLock {
  path: string;
  release(): Promise<void>;
}

/** The lock file for a source folder: <cache>/locks/<first 16 hex of sha256(folder)>.lock. */
export function lockPath(dir: string, options: ArchiveContext & { lockDir?: string } = {}): string {
  const key = path.resolve(dir);
  const normalized = (options.platform ?? process.platform) === "win32" ? key.toLowerCase() : key;
  const name = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  return path.join(options.lockDir ?? path.join(archiveCacheDir(options), "locks"), `${name}.lock`);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Whether a lock left on this machine is stale: it was taken before the last boot (its process
 * id may be in use again by an unrelated process), or its process is gone.
 */
function staleHolder(holder: LockInfo, bootTime: number): boolean {
  const startedAt = Date.parse(holder.startedAt);
  if (!Number.isNaN(startedAt) && startedAt < bootTime - BOOT_MARGIN_MS) return true;
  return holder.pid !== process.pid && !processAlive(holder.pid);
}

async function readLock(file: string): Promise<LockInfo | null> {
  try {
    const value = JSON.parse(await fs.readFile(file, "utf8")) as LockInfo;
    return typeof value.pid === "number" ? value : null;
  } catch {
    return null;
  }
}

const CLAIM_ATTEMPTS = 4;

function sameLock(a: LockInfo, b: LockInfo): boolean {
  return a.pid === b.pid && a.hostname === b.hostname && a.startedAt === b.startedAt;
}

/**
 * Claims a stale lock atomically: renames it to a unique quarantine name, so that of two runs
 * that both judged it stale only one moves it. Returns "retry" when this run moved the stale lock
 * away, or when the file was already gone or busy; the caller then opens the lock again. When the moved file turns out to
 * be a fresh lock that another run took in between, it is put back and that run is the holder.
 */
async function claimStaleLock(file: string, judged: LockInfo | null): Promise<"retry" | { holder: LockInfo | null }> {
  const quarantine = `${file}.stale-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    await fs.rename(file, quarantine);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // ENOENT: another run moved or released it. The others: Windows reports the file busy.
    if (code === "ENOENT" || code === "EPERM" || code === "EBUSY" || code === "EACCES") return "retry";
    throw error;
  }
  const moved = await readLock(quarantine);
  // On Windows with Node 22, the moved file can be gone again at once when the other run deleted
  // it in between. Nothing was claimed, so open the lock again.
  if (moved === null && !(await fs.stat(quarantine).then(() => true, () => false))) return "retry";
  const same = judged === null ? moved === null && (await unreadableAndOld(quarantine)) : moved !== null && sameLock(moved, judged);
  if (!same) {
    try {
      await fs.link(quarantine, file);
    } catch (error) {
      // EEXIST: a third run took the name meanwhile; it is the holder now.
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") await fs.rename(quarantine, file);
    }
  }
  await fs.rm(quarantine, { force: true });
  return same ? "retry" : { holder: moved };
}

/** A lock file that cannot be read (a crash while it was written) is stale after a minute. */
async function unreadableAndOld(file: string): Promise<boolean> {
  try {
    const stat = await fs.stat(file);
    return Date.now() - stat.mtimeMs > 60_000;
  } catch {
    return true;
  }
}

/**
 * Takes the run lock of a source folder. The lock lives in the OS cache folder, never in the
 * archive, so a sync client does not copy it. A lock whose process is gone, or that was taken
 * before the last boot, is taken over.
 * Throws ArchiveLockedError when another live run holds it.
 */
export async function acquireRunLock(dir: string, options: LockOptions = {}): Promise<RunLock> {
  const file = lockPath(dir, options);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const info: LockInfo = {
    pid: process.pid,
    hostname: os.hostname(),
    startedAt: new Date().toISOString(),
    dir: path.resolve(dir),
  };
  const bootTime = options.bootTime ?? Date.now() - os.uptime() * 1000;
  let holder: LockInfo | null = null;
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
          if (current !== null && current.pid === info.pid && current.startedAt === info.startedAt) {
            await fs.rm(file, { force: true });
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      holder = await readLock(file);
      const stale =
        holder === null
          ? await unreadableAndOld(file)
          : holder.hostname === info.hostname && staleHolder(holder, bootTime);
      if (!stale) throw new ArchiveLockedError(dir, holder);
      const claim = await claimStaleLock(file, holder);
      if (claim !== "retry") throw new ArchiveLockedError(dir, claim.holder);
    }
  }
  throw new ArchiveLockedError(dir, holder);
}
