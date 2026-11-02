import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * What the system says about a process: its program name and when it started (ms since the epoch). `started` is null when the
 * system keeps it back (a process of another account, or an elevated one). `unreadable` is true when the tool that reads it
 * failed, so nothing is known except that the process exists.
 */
export interface ProcessInfo {
  name: string;
  started: number | null;
  unreadable?: boolean;
}

/** Reads a process by its number: null when there is none. A test replaces it. */
export type ProcessReader = (pid: number) => Promise<ProcessInfo | null>;

/** How long before its process started a record may be dated: clocks and seconds round. */
export const RECORD_MARGIN_MS = 5_000;

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The program name of this process, as the system names a process of it. */
export function ownProgramName(): string {
  return path.basename(process.execPath).replace(/\.exe$/i, "");
}

/** Whether a name the system gives is the name of this program (Linux cuts the name to 15 characters). */
export function isOwnProgram(name: string, own: string = ownProgramName()): boolean {
  const a = name.toLowerCase();
  const b = own.toLowerCase();
  return a === b || (a.length === 15 && b.startsWith(a));
}

async function readLinux(pid: number): Promise<ProcessInfo> {
  const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
  const open = stat.indexOf("(");
  const close = stat.lastIndexOf(")");
  const name = stat.slice(open + 1, close);
  // After the name: state is field 3 and the start time, in clock ticks since the boot, is field 22.
  const ticks = Number(stat.slice(close + 2).split(" ")[19]);
  const boot = /^btime (\d+)$/m.exec(await fs.readFile("/proc/stat", "utf8"));
  if (!boot || !Number.isFinite(ticks)) return { name, started: null };
  // The kernel counts 100 ticks a second on every platform Node runs on.
  return { name, started: Number(boot[1]) * 1000 + (ticks / 100) * 1000 };
}

async function readWindows(pid: number): Promise<ProcessInfo | null> {
  const script = `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { $p.ProcessName; try { $p.StartTime.ToUniversalTime().ToString('o') } catch { '' } }`;
  const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { timeout: 15_000, windowsHide: true });
  const [name, started] = stdout.split(/\r?\n/).map((line) => line.trim());
  if (!name) return null;
  const time = started ? Date.parse(started) : NaN;
  return { name, started: Number.isNaN(time) ? null : time };
}

async function readPs(pid: number): Promise<ProcessInfo | null> {
  const env = { ...process.env, LC_ALL: "C" };
  const { stdout } = await run("ps", ["-o", "lstart=", "-o", "comm=", "-p", String(pid)], { timeout: 10_000, env });
  const line = stdout.trim();
  if (!line) return null;
  // "Mon Nov  2 18:00:00 2026 /usr/bin/program": five words of time, then the program.
  const words = line.split(/\s+/);
  const time = Date.parse(words.slice(0, 5).join(" "));
  return { name: path.basename(words.slice(5).join(" ")), started: Number.isNaN(time) ? null : time };
}

/** Reads a process from the system: Windows by PowerShell, Linux by /proc, others by ps. No dependency is added. */
export const readSystemProcess: ProcessReader = async (pid) => {
  if (!processExists(pid)) return null;
  try {
    if (process.platform === "linux") return await readLinux(pid);
    if (process.platform === "win32") return await readWindows(pid);
    return await readPs(pid);
  } catch {
    // The process ended while it was read, or the tool failed: then nothing is known but that it exists.
    if (!processExists(pid)) return null;
    return { name: "", started: null, unreadable: true };
  }
};

/**
 * Whether the process that a record names can still be the one that wrote it: the number is alive and its process started no later
 * than the record. A process that started after the record was written got the number from one that ended; a killed owner leaves its
 * record behind. A process that cannot be read, or a record time that does not parse, counts as the owner.
 */
export async function processCanHaveWritten(pid: number, recordedAt: string | undefined, read: ProcessReader = readSystemProcess): Promise<boolean> {
  const found = await read(pid);
  if (found === null) return false;
  if (found.unreadable || found.started === null) return true;
  const recorded = Date.parse(recordedAt ?? "");
  if (Number.isNaN(recorded)) return true;
  return found.started <= recorded + RECORD_MARGIN_MS;
}

/**
 * Whether the process that holds a lock of this account is still the instance that took it: the number is alive, the program is the
 * one that runs this code, and the lock was not written before the process started. A start time that the system keeps back is
 * another account's process, since a lock lives in the state folder of one account. A process that cannot be read counts as the holder.
 */
export async function holderIsLive(pid: number, lockedAt: string, read: ProcessReader = readSystemProcess): Promise<boolean> {
  const found = await read(pid);
  if (found === null) return false;
  if (found.unreadable) return true;
  if (!isOwnProgram(found.name)) return false;
  if (found.started === null) return false;
  const locked = Date.parse(lockedAt);
  if (Number.isNaN(locked)) return true;
  return locked >= found.started - RECORD_MARGIN_MS;
}
