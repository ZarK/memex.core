import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PackError } from "./manifest.js";

/** The lock file of the store: only one program changes the store at a time (contracts/packs.md, Store layout). */
export const STORE_LOCK = ".lock";

/**
 * What the holder writes in <packs>/.lock, the same JSON layout as Memex.Node: { "pid", "startedAt", "hostname",
 * "program" }. startedAt is the start time of the holding process (UTC, ISO 8601), so that a process id that the OS
 * gave to another process is not taken for the holder.
 */
export interface StoreLockHolder {
  pid: number;
  startedAt: string;
  hostname: string;
  program: string;
}

export interface StoreLock {
  readonly path: string;
  readonly holder: StoreLockHolder;
  release(): Promise<void>;
}

export interface StoreLockOptions {
  /** The program name in the lock, which the error of another program shows. Default "memex-packs". */
  program?: string;
  /** How long to wait for a lock that another program holds. Default 30 s, as Memex.Node. */
  waitMs?: number;
}

/** The start time of this process. Memex.Node compares it with the start time that the OS reports, within 2 s. */
function processStart(): string {
  return new Date(Date.now() - process.uptime() * 1000).toISOString();
}

/** The time of the last boot of this computer. */
function bootTime(): number {
  return Date.now() - os.uptime() * 1000;
}

/**
 * The computer name in a lock, as Memex.Node writes it (.NET Environment.MachineName): on Windows the NetBIOS name
 * (COMPUTERNAME, at most 15 characters), on macOS and Linux the host name up to the first '.'. Node.js os.hostname()
 * adds the mDNS suffix on macOS and gives the full DNS name on Windows, so it is not used as it is.
 */
export function lockHostname(): string {
  const netbios = process.platform === "win32" ? process.env.COMPUTERNAME?.trim() : undefined;
  if (netbios) return netbios;
  const name = os.hostname();
  const dot = name.indexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

function shortHost(name: string): string {
  const dot = name.indexOf(".");
  return (dot > 0 ? name.slice(0, dot) : name).toLowerCase();
}

/**
 * True when two lock host names name the same computer (contracts/packs.md, Store layout): compared without case and
 * up to the first '.', and a NetBIOS name (15 characters) matches a longer name that starts with it.
 */
export function sameComputer(a: string, b: string): boolean {
  const x = shortHost(a);
  const y = shortHost(b);
  if (x === y) return x.length > 0;
  return (x.length === 15 && y.startsWith(x)) || (y.length === 15 && x.startsWith(y));
}

function isThisComputer(hostname: string): boolean {
  return sameComputer(hostname, lockHostname()) || sameComputer(hostname, os.hostname());
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Reads the holder of the lock: null when there is no lock; a "half written" holder for a lock that is not JSON yet. */
export async function readStoreLock(root: string): Promise<StoreLockHolder | null> {
  return readLockFile(path.join(root, STORE_LOCK));
}

/** Reads a lock file with the layout of .lock (also a staging folder's .download.lock). */
export async function readLockFile(file: string): Promise<StoreLockHolder | null> {
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    if (code === "EBUSY" || code === "EPERM" || code === "EACCES") return { pid: 0, startedAt: new Date().toISOString(), hostname: lockHostname(), program: "a program" };
    throw error;
  }
  const holder = parseHolder(text);
  if (holder !== null) return holder;
  // Memex.Node's rule: a lock that is not valid JSON is stale, unless it is new (its writer may be writing it now).
  const stat = await fs.stat(file).catch(() => null);
  if (stat !== null && Date.now() - stat.mtimeMs < 5000) return { pid: 0, startedAt: new Date().toISOString(), hostname: lockHostname(), program: "a program" };
  return { pid: -1, startedAt: "", hostname: lockHostname(), program: "a crashed program" };
}

function parseHolder(text: string): StoreLockHolder | null {
  try {
    const value = JSON.parse(text) as Partial<StoreLockHolder>;
    if (typeof value.pid === "number" && typeof value.startedAt === "string" && typeof value.hostname === "string") {
      return { pid: value.pid, startedAt: value.startedAt, hostname: value.hostname, program: typeof value.program === "string" ? value.program : "a program" };
    }
  } catch {
    // not JSON yet, or left half written by a crash
  }
  return null;
}

/**
 * True when the lock no longer protects anything: it was written before the last boot, or its process on this
 * computer is gone. A lock from another computer (a store on a shared drive) is never stale here. A lock of a process
 * that runs is held: unlike Memex.Node, this library cannot read the start time of another process without native
 * code, so a process id that the OS gave again counts as the holder until it ends.
 */
async function isStale(file: string, holder: StoreLockHolder): Promise<boolean> {
  if (holder.pid === -1) return true;
  if (holder.pid === 0) return false;
  if (!isThisComputer(holder.hostname)) return false;
  const stat = await fs.stat(file).catch(() => null);
  if (stat !== null && stat.mtimeMs < bootTime()) return true;
  return !isAlive(holder.pid);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A lock file taken with an exclusive create. The handle stays open while keepOpen is set. */
export interface HeldLockFile {
  readonly file: string;
  readonly holder: StoreLockHolder;
  /** Closes the handle that keepOpen kept open. The file stays. */
  closeHandle(): Promise<void>;
  /** Closes the handle and removes the file while it is still this lock. */
  release(): Promise<void>;
}

/**
 * Takes a lock file as Memex.Node takes .lock: an exclusive create that writes the holder, a wait of up to waitMs
 * while another program holds it, and a stale lock taken over by a rename to a unique name first (<file>.stale-<id>),
 * so that two programs never both take it. busy() gives the error when the wait ends.
 */
export async function acquireLockFile(
  file: string,
  options: { program: string; waitMs: number; keepOpen?: boolean; busy: (current: StoreLockHolder) => Error },
): Promise<HeldLockFile> {
  const holder: StoreLockHolder = { pid: process.pid, startedAt: processStart(), hostname: lockHostname(), program: options.program };
  const until = Date.now() + options.waitMs;
  for (;;) {
    let handle: fs.FileHandle | null = null;
    try {
      handle = await fs.open(file, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (handle !== null) {
      let open: fs.FileHandle | null = handle;
      try {
        await handle.writeFile(JSON.stringify(holder), "utf8");
        if (options.keepOpen === true) await handle.sync();
      } finally {
        if (options.keepOpen !== true) {
          await handle.close();
          open = null;
        }
      }
      let released = false;
      const closeHandle = async () => {
        const h = open;
        open = null;
        if (h !== null) await h.close().catch(() => undefined);
      };
      return {
        file,
        holder,
        closeHandle,
        async release() {
          if (released) return;
          released = true;
          await closeHandle();
          // Only remove the lock while it is still this one.
          const now = await readLockFile(file).catch(() => null);
          if (now !== null && now.pid === holder.pid && now.startedAt === holder.startedAt) await fs.rm(file, { force: true });
        },
      };
    }
    const current = await readLockFile(file);
    if (current === null) continue;
    if (await isStale(file, current)) {
      await takeOver(file, current);
      continue;
    }
    if (Date.now() >= until) throw options.busy(current);
    await sleep(100);
  }
}

/**
 * Takes <root>/.lock as Memex.Node does (acquireLockFile). Throws PackError "store_busy" that names the holder when the
 * wait ends.
 */
export async function acquireStoreLock(root: string, options: StoreLockOptions = {}): Promise<StoreLock> {
  await fs.mkdir(root, { recursive: true });
  const held = await acquireLockFile(path.join(root, STORE_LOCK), {
    program: options.program ?? "memex-packs",
    waitMs: options.waitMs ?? 30_000,
    busy: (current) =>
      new PackError("store_busy", `Another program changes the pack store now: ${current.program} (process ${current.pid}). Try again when it is done.`),
  });
  return { path: held.file, holder: held.holder, release: () => held.release() };
}

async function takeOver(file: string, stale: StoreLockHolder): Promise<void> {
  const aside = `${file}.stale-${randomUUID().replace(/-/g, "")}`;
  try {
    await fs.rename(file, aside);
  } catch {
    return; // another program took it over first
  }
  // Another program may have taken the stale lock over and made a fresh one between the read and the rename. Then the
  // renamed file is that fresh lock: put it back. A broken stale lock (pid -1) never parses, so any valid holder is fresh.
  let moved: StoreLockHolder | null = null;
  try {
    moved = parseHolder(await fs.readFile(aside, "utf8"));
  } catch {
    moved = null;
  }
  if (moved !== null && (stale.pid <= 0 || moved.pid !== stale.pid || moved.startedAt !== stale.startedAt)) {
    await fs.rename(aside, file).catch(() => undefined);
    return;
  }
  await fs.rm(aside, { force: true }).catch(() => undefined);
}

/** Runs fn while holding the store lock. */
export async function withStoreLock<T>(root: string, fn: () => Promise<T>, options: StoreLockOptions = {}): Promise<T> {
  const lock = await acquireStoreLock(root, options);
  try {
    return await fn();
  } finally {
    await lock.release();
  }
}
