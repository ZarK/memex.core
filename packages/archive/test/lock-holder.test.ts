import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ArchiveLockedError, acquireRunLock, lockPath } from "../src/index.js";
import { claimStaleLock } from "../src/lock.js";
import { ownProgramName, type ProcessReader } from "../src/process-info.js";

let dir: string;
let lockDir: string;
const children: ChildProcess[] = [];

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "mxa-"));
  lockDir = path.join(dir, "locks");
});

afterEach(async () => {
  for (const child of children.splice(0)) child.kill();
  await fs.rm(dir, { recursive: true, force: true });
});

function otherProgram(): ChildProcess {
  const child = process.platform === "win32" ? spawn("ping", ["-n", "60", "127.0.0.1"], { stdio: "ignore" }) : spawn("sleep", ["60"], { stdio: "ignore" });
  children.push(child);
  return child;
}

async function writeLock(pid: number, startedAt: Date): Promise<string> {
  const file = lockPath(dir, { lockDir });
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ pid, hostname: os.hostname(), startedAt: startedAt.toISOString(), dir: path.resolve(dir) }) + "\n");
  return file;
}

const asProgram =
  (started: number | null, name = ownProgramName()): ProcessReader =>
  async () => ({ name, started });

// The tests pass the boot time, so none of them depends on how long the computer has been up.
const BOOT = () => Date.now() - 24 * 3600_000;

describe("the holder of a run lock", () => {
  it("takes over a lock whose number is another live program and keeps the old lock aside", async () => {
    const child = otherProgram();
    const file = await writeLock(child.pid!, new Date());
    const lock = await acquireRunLock(dir, { lockDir, bootTime: BOOT() });
    expect((await fs.readdir(path.dirname(file))).filter((name) => name.includes(".stale-"))).toHaveLength(1);
    await lock.release();
  });

  it("keeps the lock of a live run that started when the lock says", async () => {
    const started = Date.now() - 20 * 60_000;
    await writeLock(2 ** 22 + 11, new Date(started + 3000));
    await expect(acquireRunLock(dir, { lockDir, bootTime: started - 3600_000, readProcess: asProgram(started) })).rejects.toBeInstanceOf(ArchiveLockedError);
  });

  it("takes over a lock when the same program started later than the lock was written", async () => {
    const started = Date.now() - 20 * 60_000;
    await writeLock(2 ** 22 + 12, new Date(started - 24 * 3600_000));
    const lock = await acquireRunLock(dir, { lockDir, bootTime: started - 48 * 3600_000, readProcess: asProgram(started) });
    await lock.release();
  });

  it("does not count a process that keeps its start time back as the holder", async () => {
    await writeLock(2 ** 22 + 13, new Date());
    const lock = await acquireRunLock(dir, { lockDir, bootTime: BOOT(), readProcess: asProgram(null) });
    await lock.release();
  });

  it("counts a process that cannot be read as the holder, and says why it will not start", async () => {
    await writeLock(2 ** 22 + 14, new Date());
    const unreadable: ProcessReader = async () => ({ name: "", started: null, unreadable: true });
    const error = await acquireRunLock(dir, { lockDir, bootTime: BOOT(), readProcess: unreadable }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ArchiveLockedError);
    expect((error as ArchiveLockedError).message).toMatch(/would not tell what process \d+ is/);
  });

  it("puts back a lock that another run took in between, and does not take it", async () => {
    const child = otherProgram();
    const file = await writeLock(child.pid!, new Date());
    const judged = JSON.parse(await fs.readFile(file, "utf8"));
    await fs.rm(file);
    const second = await acquireRunLock(dir, { lockDir, bootTime: BOOT() });
    const claim = await claimStaleLock(file, judged);
    expect(claim).not.toBe("retry");
    expect(JSON.parse(await fs.readFile(file, "utf8")).pid).toBe(process.pid);
    await second.release();
  });
});
