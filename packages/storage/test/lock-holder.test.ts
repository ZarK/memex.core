import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppLockedError, acquireAppLock, appLockPath } from "../src/index.js";
import { claimStaleLock } from "../src/lock.js";
import { ownProgramName, type ProcessReader } from "../src/process-info.js";

let dir: string;
const children: ChildProcess[] = [];

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "mxl-"));
});

afterEach(async () => {
  for (const child of children.splice(0)) child.kill();
  await fs.rm(dir, { recursive: true, force: true });
});

const options = () => ({ app: "photos", data: path.join(dir, "Photos"), state: path.join(dir, "state") });

/** A live program that is not this one, for as long as the test needs it. */
function otherProgram(): ChildProcess {
  const child = process.platform === "win32" ? spawn("ping", ["-n", "60", "127.0.0.1"], { stdio: "ignore" }) : spawn("sleep", ["60"], { stdio: "ignore" });
  children.push(child);
  return child;
}

async function writeLock(pid: number, startedAt: Date): Promise<string> {
  const file = appLockPath(options());
  await fs.mkdir(path.dirname(file), { recursive: true });
  const info = { app: "photos", data: path.resolve(options().data), pid, hostname: os.hostname(), startedAt: startedAt.toISOString() };
  await fs.writeFile(file, JSON.stringify(info) + "\n");
  return file;
}

const asProgram =
  (started: number | null, name = ownProgramName()): ProcessReader =>
  async () => ({ name, started });

// The tests pass the boot time, so none of them depends on how long the computer has been up.
const BOOT = () => Date.now() - 24 * 3600_000;

describe("the holder of an app lock", () => {
  it("takes over a lock whose process is gone", async () => {
    const child = otherProgram();
    const pid = child.pid!;
    child.kill();
    await new Promise((resolve) => child.once("exit", resolve));
    await writeLock(pid, new Date());
    const lock = await acquireAppLock({ ...options(), bootTime: BOOT() });
    await lock.release();
  });

  it("takes over a lock whose number is another live program and keeps the old lock aside", async () => {
    const child = otherProgram();
    const file = await writeLock(child.pid!, new Date());
    const lock = await acquireAppLock({ ...options(), bootTime: BOOT() });
    const aside = (await fs.readdir(path.dirname(file))).filter((name) => name.includes(".stale-"));
    expect(aside).toHaveLength(1);
    expect(JSON.parse(await fs.readFile(path.join(path.dirname(file), aside[0]!), "utf8")).pid).toBe(child.pid);
    await lock.release();
  });

  it("keeps the lock of a live instance that started when the lock says", async () => {
    const started = Date.now() - 20 * 60_000;
    const file = await writeLock(2 ** 22 + 11, new Date(started + 3000));
    const error = await acquireAppLock({ ...options(), bootTime: started - 3600_000, readProcess: asProgram(started) }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppLockedError);
    expect(JSON.parse(await fs.readFile(file, "utf8")).pid).toBe(2 ** 22 + 11);
    expect((await fs.readdir(path.dirname(file))).filter((name) => name.includes(".stale-"))).toEqual([]);
  });

  it("takes over a lock when the same program started later than the lock was written", async () => {
    const started = Date.now() - 20 * 60_000;
    await writeLock(2 ** 22 + 12, new Date(started - 24 * 3600_000));
    const lock = await acquireAppLock({ ...options(), bootTime: started - 48 * 3600_000, readProcess: asProgram(started) });
    await lock.release();
  });

  it("takes over a lock whose number is this process but was written long before it started", async () => {
    const started = Date.now() - 20 * 60_000;
    await writeLock(process.pid, new Date(started - 24 * 3600_000));
    const lock = await acquireAppLock({ ...options(), bootTime: started - 48 * 3600_000, readProcess: asProgram(started) });
    await lock.release();
  });

  it("does not count a process of another program that keeps its start time back as the holder", async () => {
    await writeLock(2 ** 22 + 13, new Date());
    const lock = await acquireAppLock({ ...options(), bootTime: BOOT(), readProcess: asProgram(null, "ping") });
    await lock.release();
  });

  it("counts a process of the lock's program that keeps its start time back (an elevated instance) as the holder", async () => {
    await writeLock(2 ** 22 + 16, new Date());
    await expect(acquireAppLock({ ...options(), bootTime: BOOT(), readProcess: asProgram(null) })).rejects.toBeInstanceOf(AppLockedError);
  });

  it("keeps the lock of a live instance of another executable of the same app, by the program the lock names", async () => {
    const started = Date.now() - 20 * 60_000;
    const file = appLockPath(options());
    await fs.mkdir(path.dirname(file), { recursive: true });
    const info = { app: "photos", data: path.resolve(options().data), pid: 2 ** 22 + 17, hostname: os.hostname(), startedAt: new Date(started + 3000).toISOString(), program: "Memex Photos" };
    await fs.writeFile(file, JSON.stringify(info) + "\n");
    await expect(acquireAppLock({ ...options(), bootTime: started - 3600_000, readProcess: asProgram(started, "Memex Photos") })).rejects.toBeInstanceOf(AppLockedError);
  });

  it("writes the program into the lock", async () => {
    const lock = await acquireAppLock({ ...options(), bootTime: BOOT() });
    expect(JSON.parse(await fs.readFile(lock.path, "utf8")).program).toBe(ownProgramName());
    await lock.release();
  });

  it("counts a process that cannot be read as the holder", async () => {
    await writeLock(2 ** 22 + 14, new Date());
    const unreadable: ProcessReader = async () => ({ name: "", started: null, unreadable: true });
    const error = await acquireAppLock({ ...options(), bootTime: BOOT(), readProcess: unreadable }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppLockedError);
    // The app says plainly why it will not start.
    expect((error as AppLockedError).message).toMatch(/would not tell what process \d+ is/);
    expect((error as AppLockedError).message).toMatch(/remove the lock file/);
  });

  it("does not look at the process of a free lock", async () => {
    let reads = 0;
    const lock = await acquireAppLock({ ...options(), bootTime: BOOT(), readProcess: async () => (reads++, null) });
    expect(reads).toBe(0);
    await lock.release();
  });

  it("keeps a lock that an instance took long after it started", async () => {
    const started = Date.now() - 3 * 3600_000;
    await writeLock(2 ** 22 + 15, new Date(started + 2 * 3600_000));
    await expect(acquireAppLock({ ...options(), bootTime: started - 3600_000, readProcess: asProgram(started) })).rejects.toBeInstanceOf(AppLockedError);
  });

  it("puts back a lock that another start took in between, and does not take it", async () => {
    const child = otherProgram();
    const file = await writeLock(child.pid!, new Date());
    const judged = JSON.parse(await fs.readFile(file, "utf8"));
    // Between the judgement and the move another start took the lock over and wrote its own.
    await fs.rm(file);
    const second = await acquireAppLock({ ...options(), bootTime: BOOT() });
    const claim = await claimStaleLock(file, judged);
    expect(claim).not.toBe("retry");
    expect(JSON.parse(await fs.readFile(file, "utf8")).pid).toBe(process.pid);
    await second.release();
  });
});
