import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isAppId, memexPaths } from "@tjalve/memex-storage";
import { SurfaceError, readAppRecord, type AppRecord } from "@tjalve/memex-surfaces";
import { endpointOf, sendRequest, type Endpoint } from "./transport.js";

/**
 * The service launcher of contracts/surfaces.md (Service launcher): it finds a running service through its app record,
 * starts the newest installed copy when none runs, and lets a newer copy take over from an older one that runs.
 * ensureNode uses it for Memex.Node; ensureUser (Memex.User) will use it the same way.
 */

export const SERVICE_MANIFEST_FORMAT = "memex.service/1";
export const LAUNCH_LOCK = "launch.lock";
export const DEFAULT_START_TIMEOUT_MS = 10_000;

/** One installed copy of a service. */
export interface ServiceCopy {
  app: string;
  version: string;
  /** The absolute path of the program. */
  command: string;
  args: string[];
  /** services: a version folder in the services folder; record: the copy that wrote the app record; given: passed by the caller. */
  source: "services" | "record" | "given";
}

export interface LauncherOptions {
  /** The apps folder (app records). Default: the apps folder of contracts/storage.md, or MEMEX_APPS_DIR. */
  apps?: string;
  /** The state folder of the service, for the launch lock. Default: its state folder of contracts/storage.md. */
  state?: string;
  /** The services folder. Default: servicesFolder() (MEMEX_SERVICES_DIR overrides it). */
  services?: string;
  /** More copies, for example one that an app carries with it. */
  copies?: ServiceCopy[];
  /** The environment for the folders and for the started service. Default process.env. */
  env?: NodeJS.ProcessEnv;
  /** How long to wait for a start. Default 10 s. */
  timeoutMs?: number;
  /** How long to wait for the launch lock that another launcher holds. Default 30 s. */
  lockTimeoutMs?: number;
  /** The path that asks an older copy to drain. Default /v1/drain (Memex.Node). */
  drainPath?: string;
  /** Lines for a log. */
  log?: (line: string) => void;
}

/** What the launcher did. */
export interface Launch {
  app: string;
  /** found: a current copy ran; started: no copy ran; took-over: a newer copy started while an older one drains. */
  action: "found" | "started" | "took-over";
  record: AppRecord;
  endpoint: Endpoint;
  /** The copy that the launcher started. */
  started?: ServiceCopy;
  /** The older copy that drains. */
  drained?: { pid: number; version: string };
}

// ---------- folders ----------

/**
 * The services folder: installed copies of the shared services, one folder per version.
 * Windows %LOCALAPPDATA%\Programs\Memex\Services, macOS ~/Library/Application Support/Memex/Services,
 * Linux $XDG_DATA_HOME/memex/services. MEMEX_SERVICES_DIR overrides it.
 */
export function servicesFolder(input: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; home?: string } = {}): string {
  const platform = input.platform ?? process.platform;
  const env = input.env ?? process.env;
  const home = input.home ?? os.homedir();
  const p = platform === "win32" ? path.win32 : path.posix;
  const absolute = (v: string | undefined) => (v && p.isAbsolute(v) ? v : undefined);
  if (env.MEMEX_SERVICES_DIR !== undefined && env.MEMEX_SERVICES_DIR !== "") {
    const dir = absolute(env.MEMEX_SERVICES_DIR);
    if (!dir) throw new SurfaceError("invalid_input", `MEMEX_SERVICES_DIR must be an absolute path: ${env.MEMEX_SERVICES_DIR}`);
    return dir;
  }
  if (platform === "win32") return p.join(absolute(env.LOCALAPPDATA) ?? p.join(home, "AppData", "Local"), "Programs", "Memex", "Services");
  if (platform === "darwin") return p.join(home, "Library", "Application Support", "Memex", "Services");
  return p.join(absolute(env.XDG_DATA_HOME) ?? p.join(home, ".local", "share"), "memex", "services");
}

function folders(app: string, options: LauncherOptions) {
  const env = options.env ?? process.env;
  if (!isAppId(app)) throw new SurfaceError("invalid_input", `${app} is not an app id of contracts/storage.md.`, { field: "app" });
  const paths = memexPaths({ app, platform: process.platform, env, home: os.homedir() });
  return {
    apps: options.apps ?? paths.apps,
    state: options.state ?? paths.state,
    services: options.services ?? servicesFolder({ env }),
  };
}

// ---------- versions ----------

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function isVersion(value: string): boolean {
  return SEMVER.test(value);
}

/** Compares two semantic versions: negative when a is older. A pre-release is older than its release. */
export function compareVersions(a: string, b: string): number {
  const x = SEMVER.exec(a);
  const y = SEMVER.exec(b);
  if (!x || !y) throw new SurfaceError("invalid_input", `Not a version: ${!x ? a : b}`);
  for (let i = 1; i <= 3; i++) {
    const d = Number(x[i]) - Number(y[i]);
    if (d) return d;
  }
  const px = x[4];
  const py = y[4];
  if (px === py) return 0;
  if (px === undefined) return 1;
  if (py === undefined) return -1;
  const ax = px.split(".");
  const ay = py.split(".");
  for (let i = 0; i < Math.max(ax.length, ay.length); i++) {
    const s = ax[i];
    const t = ay[i];
    if (s === undefined) return -1;
    if (t === undefined) return 1;
    const ns = /^\d+$/.test(s);
    const nt = /^\d+$/.test(t);
    if (ns && nt && Number(s) !== Number(t)) return Number(s) - Number(t);
    if (ns !== nt) return ns ? -1 : 1;
    if (s !== t) return s < t ? -1 : 1;
  }
  return 0;
}

// ---------- installed copies ----------

/**
 * The copies in <services>/<app>/<version>/. Each version folder holds service.json (memex.service/1) with the app, the
 * version (the same as the folder name), and the command, a path inside the folder. A folder that does not follow this,
 * a link, or a command that is missing is left out, and the log says why.
 */
export async function installedCopies(app: string, options: Pick<LauncherOptions, "services" | "env" | "log"> = {}): Promise<ServiceCopy[]> {
  const root = path.join(options.services ?? servicesFolder({ env: options.env }), app);
  let names: string[];
  try {
    names = await fs.readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const copies: ServiceCopy[] = [];
  for (const name of names) {
    if (!isVersion(name)) continue;
    const copy = await readCopy(app, name, path.join(root, name), options.log);
    if (copy) copies.push({ ...copy, source: "services" });
  }
  return copies;
}

/** One version folder by the rules above, or null (the log says why). A folder removed while it is read is left out. */
async function readCopy(app: string, version: string, folder: string, log?: (line: string) => void): Promise<Omit<ServiceCopy, "source"> | null> {
  const skip = (why: string) => {
    log?.(`The services folder ${folder} is left out: ${why}`);
    return null;
  };
  let stat;
  try {
    stat = await fs.lstat(folder);
  } catch (error) {
    return skip(`it cannot be read (${(error as Error).message}).`);
  }
  if (!stat.isDirectory()) return skip(stat.isSymbolicLink() ? "it is a link." : "it is not a folder.");
  let manifest: { format?: unknown; app?: unknown; version?: unknown; command?: unknown; args?: unknown };
  try {
    manifest = JSON.parse(await fs.readFile(path.join(folder, "service.json"), "utf8"));
  } catch (error) {
    return skip(`service.json cannot be read (${(error as Error).message}).`);
  }
  if (manifest.format !== SERVICE_MANIFEST_FORMAT) {
    return skip(`service.json has the format ${JSON.stringify(manifest.format)}, not ${SERVICE_MANIFEST_FORMAT}.`);
  }
  if (manifest.app !== app || manifest.version !== version) {
    return skip(`service.json names ${String(manifest.app)} ${String(manifest.version)}, not ${app} ${version}.`);
  }
  const args = manifest.args ?? [];
  if (typeof manifest.command !== "string" || !Array.isArray(args) || !args.every((a) => typeof a === "string")) {
    return skip("service.json needs command (a string) and args (strings).");
  }
  const command = path.resolve(folder, manifest.command);
  const inside = path.relative(folder, command);
  if (path.isAbsolute(manifest.command) || inside.startsWith("..") || path.isAbsolute(inside)) {
    return skip("the command is not inside the version folder.");
  }
  try {
    const file = await fs.lstat(command);
    if (!file.isFile()) return skip(file.isSymbolicLink() ? "the command is a link." : "the command is not a file.");
  } catch {
    return skip(`the command ${manifest.command} is missing.`);
  }
  return { app, version, command, args: args as string[] };
}

/** The newest copy: the highest version; of equal versions, a copy in the services folder first, then the record's. */
export function newestCopy(copies: ServiceCopy[]): ServiceCopy | null {
  const rank = { services: 0, given: 1, record: 2 } as const;
  return [...copies].sort((a, b) => compareVersions(b.version, a.version) || rank[a.source] - rank[b.source])[0] ?? null;
}

/**
 * The program that wrote the app record. When a service.json of that app and version is beside it and names it as its
 * command, its args are used too (a runtime that starts a script, as Memex.User's copy). Otherwise it starts without args.
 */
export async function recordCopy(record: AppRecord | null): Promise<ServiceCopy | null> {
  if (!record || !isVersion(record.version)) return null;
  try {
    if (!(await fs.lstat(record.executable)).isFile()) return null;
  } catch {
    return null;
  }
  const folder = path.dirname(record.executable);
  const manifest = await fs.lstat(path.join(folder, "service.json")).then(
    (s) => s.isFile(),
    () => false,
  );
  if (manifest) {
    const copy = await readCopy(record.app, record.version, folder);
    if (!copy || path.resolve(copy.command) !== path.resolve(record.executable)) return null;
    return { ...copy, source: "record" };
  }
  return { app: record.app, version: record.version, command: record.executable, args: [], source: "record" };
}

// ---------- probing ----------

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export type Probe =
  | { state: "running"; record: AppRecord; endpoint: Endpoint; version: string }
  | { state: "draining"; record: AppRecord }
  | { state: "unresponsive"; record: AppRecord; reason: string }
  | { state: "stopped"; record: AppRecord | null; reason: string };

/** The reader rules of contracts/surfaces.md, with GET /health over the pipe or socket as well as over a URL. */
export async function probe(app: string, options: { apps?: string; timeoutMs?: number } = {}): Promise<Probe> {
  const record = await readAppRecord(app, { apps: options.apps });
  if (!record) return { state: "stopped", record, reason: "not installed" };
  if (!record.running) return { state: "stopped", record, reason: "running is null" };
  if (!processAlive(record.running.pid)) return { state: "stopped", record, reason: `the process ${record.running.pid} is gone` };
  let endpoint: Endpoint;
  try {
    endpoint = await endpointOf(record.running);
  } catch (error) {
    return { state: "stopped", record, reason: `the endpoint cannot be read: ${(error as Error).message}` };
  }
  try {
    const answer = await sendRequest(endpoint, { method: "GET", path: "/health", headers: { accept: "application/json" }, timeoutMs: options.timeoutMs ?? 2000 });
    const health = JSON.parse(answer.body.toString("utf8")) as { status?: string; app?: string; version?: string };
    if (answer.status === 200 && health.app === app && health.status === "draining") return { state: "draining", record };
    if (answer.status !== 200 || health.status !== "ok") return { state: "stopped", record, reason: `GET /health answered ${answer.status}` };
    if (health.app !== app) return { state: "stopped", record, reason: `GET /health names the app ${String(health.app)}` };
    return { state: "running", record, endpoint, version: health.version ?? record.version };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ETIMEDOUT") return { state: "unresponsive", record, reason: (error as Error).message };
    return { state: "stopped", record, reason: `GET /health failed: ${(error as Error).message}` };
  }
}

// ---------- the launch lock ----------

interface LockInfo {
  pid: number;
  hostname: string;
  startedAt: string;
}

const STALE_LOCK_MS = 60_000;

/**
 * Runs fn while this process holds <state>/launch.lock, so that two launchers never start or drain at the same time.
 * The file is created exclusively and holds { pid, hostname, startedAt }. A lock whose process is gone, or that is older
 * than a minute, is taken over. The C# launcher (Memex.Node.Client) uses the same file and rules.
 */
export async function withLaunchLock<T>(state: string, timeoutMs: number, fn: () => Promise<T>): Promise<T> {
  // 0700 as Node makes it (node-api.md, Transport), because the launcher may be the first to create it.
  await fs.mkdir(state, { recursive: true, mode: 0o700 });
  const file = path.join(state, LAUNCH_LOCK);
  const info: LockInfo = { pid: process.pid, hostname: os.hostname(), startedAt: new Date().toISOString() };
  const until = Date.now() + timeoutMs;
  for (;;) {
    try {
      await fs.writeFile(file, JSON.stringify(info) + "\n", { flag: "wx", mode: 0o600 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (await staleLock(file)) {
      const aside = `${file}.stale-${process.pid}-${randomBytes(4).toString("hex")}`;
      try {
        await fs.rename(file, aside);
        await fs.rm(aside, { force: true });
      } catch {
        // another launcher moved it first
      }
      continue;
    }
    if (Date.now() >= until) {
      throw new SurfaceError("unavailable", `Another launcher holds ${file}.`, { hint: "Try again in a moment." });
    }
    await delay(100);
  }
  try {
    return await fn();
  } finally {
    try {
      const current = JSON.parse(await fs.readFile(file, "utf8")) as LockInfo;
      if (current.pid === info.pid && current.startedAt === info.startedAt && current.hostname === info.hostname) await fs.rm(file, { force: true });
    } catch {
      // gone already
    }
  }
}

async function staleLock(file: string): Promise<boolean> {
  try {
    const stat = await fs.stat(file);
    if (Date.now() - stat.mtimeMs > STALE_LOCK_MS) return true;
    const holder = JSON.parse(await fs.readFile(file, "utf8")) as LockInfo;
    return holder.hostname === os.hostname() && typeof holder.pid === "number" && !processAlive(holder.pid);
  } catch {
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------- ensure ----------

/**
 * Makes sure that the newest installed copy of a service runs, and returns its endpoint:
 * 1. A copy that runs (its process lives and GET /health answers ok) and is not older than the newest installed copy
 *    is used as it is.
 * 2. Otherwise, under the launch lock: when an older copy runs, it is asked to drain (POST /v1/drain). It stops taking
 *    new work and gives up its single-instance lock, then exits when its held work ends.
 * 3. The newest copy is started detached, and the launcher waits until its record names a process that answers
 *    GET /health, at most timeoutMs (10 s).
 */
export async function ensureService(app: string, options: LauncherOptions = {}): Promise<Launch> {
  const dirs = folders(app, options);
  const log = options.log ?? (() => {});
  const timeoutMs = options.timeoutMs ?? DEFAULT_START_TIMEOUT_MS;

  const decide = async () => {
    const found = await probe(app, { apps: dirs.apps });
    const copies = [...(await installedCopies(app, { services: dirs.services, env: options.env, log })), ...(options.copies ?? [])];
    const fromRecord = await recordCopy(found.record);
    if (fromRecord) copies.push(fromRecord);
    return { found, newest: newestCopy(copies) };
  };

  // Fast path, without the lock.
  const first = await decide();
  if (first.found.state === "running" && (!first.newest || compareVersions(first.found.version, first.newest.version) >= 0)) {
    return { app, action: "found", record: first.found.record, endpoint: first.found.endpoint };
  }

  return withLaunchLock(dirs.state, options.lockTimeoutMs ?? 30_000, async () => {
    const { found, newest } = await decide();
    let drained: Launch["drained"];
    if (found.state === "running") {
      if (!newest || compareVersions(found.version, newest.version) >= 0) {
        return { app, action: "found", record: found.record, endpoint: found.endpoint } satisfies Launch;
      }
      log(`${app} ${found.version} runs, and ${newest.version} is installed: the older copy drains.`);
      const answer = await sendRequest(found.endpoint, { method: "POST", path: options.drainPath ?? "/v1/drain", headers: { accept: "application/json" }, timeoutMs: 5000 });
      if (answer.status !== 202) {
        throw new SurfaceError("unavailable", `${app} ${found.version} did not drain: POST ${options.drainPath ?? "/v1/drain"} answered ${answer.status}.`);
      }
      drained = { pid: found.record.running!.pid, version: found.version };
    } else if (found.state === "unresponsive") {
      throw new SurfaceError("unavailable", `${app} runs (process ${found.record.running!.pid}) but does not answer: ${found.reason}`, {
        hint: "Wait a moment and try again.",
      });
    }
    if (!newest) {
      throw new SurfaceError("unavailable", `${app} is not installed: no copy in ${path.join(dirs.services, app)} and no app record with a program.`, {
        hint: "Install a Memex app that carries it.",
      });
    }
    const running = await start(app, newest, dirs.apps, options.env ?? process.env, timeoutMs, drained?.pid, log);
    return { app, action: drained ? "took-over" : "started", record: running.record, endpoint: running.endpoint, started: newest, drained } satisfies Launch;
  });
}

async function start(
  app: string,
  copy: ServiceCopy,
  apps: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  olderPid: number | undefined,
  log: (line: string) => void,
): Promise<{ record: AppRecord; endpoint: Endpoint }> {
  log(`Starting ${app} ${copy.version}: ${copy.command}`);
  const child = spawn(copy.command, copy.args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    cwd: path.dirname(copy.command),
    env: { ...env },
  });
  let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  let failed: Error | null = null;
  child.once("exit", (code, signal) => (exited = { code, signal }));
  child.once("error", (error) => (failed = error));
  child.unref();
  const until = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < until) {
    if (failed) throw new SurfaceError("unavailable", `${app} ${copy.version} could not start: ${(failed as Error).message}`);
    const found = await probe(app, { apps, timeoutMs: Math.max(200, Math.min(2000, until - Date.now())) });
    if (found.state === "running" && found.record.running!.pid !== olderPid && compareVersions(found.version, copy.version) >= 0) {
      return { record: found.record, endpoint: found.endpoint };
    }
    last = found.state === "running" ? `${found.version} answers` : "reason" in found ? found.reason : found.state;
    const done = exited as { code: number | null; signal: NodeJS.Signals | null } | null;
    if (done && done.code !== 0) {
      throw new SurfaceError("unavailable", `${app} ${copy.version} stopped at its start with exit code ${done.code ?? done.signal}.`, {
        hint: "Its log is in its logs folder.",
      });
    }
    await delay(100);
  }
  throw new SurfaceError("unavailable", `${app} ${copy.version} did not answer within ${timeoutMs} ms (${last}).`);
}
