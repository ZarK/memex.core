import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { compareVersions, isVersion, probe, sendRequest, servicesFolder, SERVICE_MANIFEST_FORMAT, endpointOf } from "@tjalve/memex-node-client";
import { memexPaths, memexRoot } from "@tjalve/memex-storage";
import { isInsideDirectory } from "./home.js";

/**
 * The shared services inside every Memex app installer: Memex.Node and Memex.User, and later the
 * headless tools. Each app pins the versions it carries in services.json, one archive with its SHA-256 for each target.
 * The pack checks each archive and puts the unpacked copy in <resources>/services/<service>/<version>/. The installer
 * (the NSIS hook on Windows) and every start of the app copy it into the services folder of contracts/surfaces.md
 * (Installed copies), so that ensureNode and ensureUser start the newest installed copy. Under one lock: a version folder
 * is only ever added whole, the two newest versions of each service are kept, every app that carries the services is
 * listed in the clients folder, and the uninstaller of the last app removes the services. Never ~/Memex or the pack
 * store: the services folder must be outside both.
 */

export const SERVICES_PINS_FORMAT = "memex.services/1";
export const SERVICES_BUNDLE_FORMAT = "memex.services-bundle/1";
export const SERVICES_CLIENT_FORMAT = "memex.services-client/1";
/** The folder of the app's resources with the unpacked copies and services.json (the bundle). */
export const SERVICES_RESOURCE = "services";
export const CLIENTS_FOLDER = "clients";
export const SERVICES_LOCK = "services.lock";
/**
 * The marker of a services folder: written when the folder is made, or when an empty folder is first used. Installers
 * and uninstallers act only in a folder that has it, so a folder that a person uses for other files is never changed.
 */
export const SERVICES_MARKER = "memex-services.json";
export const SERVICES_FOLDER_FORMAT = "memex.services-folder/1";
/** How many versions of each service stay installed. */
export const KEEP_VERSIONS = 2;
/** The command line argument of the installer hooks: --memex-services=install or --memex-services=uninstall. */
export const SERVICES_ARG = "--memex-services";

const NAME = /^[a-z][a-z0-9]*$/;
const SHA256 = /^[0-9a-f]{64}$/;

/** One pinned archive of a service: the file name and its SHA-256. */
export interface ServiceArchivePin {
  archive: string;
  sha256: string;
}

/** services.json of an app: the version of each service it carries, and its archive for each target. */
export interface ServicesPins {
  format: typeof SERVICES_PINS_FORMAT;
  services: Record<string, { version: string; targets: Record<string, ServiceArchivePin> }>;
}

/** <resources>/services/services.json: what one build carries, for one target. */
export interface ServicesBundle {
  format: typeof SERVICES_BUNDLE_FORMAT;
  target: string;
  services: Record<string, { version: string } & ServiceArchivePin>;
}

/** <services>/clients/<app>.json: one app that carries the services. */
export interface ServicesClient {
  format: typeof SERVICES_CLIENT_FORMAT;
  app: string;
  productName: string;
  version: string;
  /** The app's program. When it is gone, the app was removed without its uninstaller (a dmg app moved to the Trash). */
  program: string;
  /** The versions the app carries. */
  services: Record<string, string>;
  updatedAt: string;
}

/** The target of this computer (or of a platform and CPU), in the names of the publish profiles: win-x64, osx-arm64, linux-x64. */
export function serviceTarget(platform: string = process.platform, arch: string = process.arch): string {
  const os = platform === "win32" ? "win" : platform === "darwin" ? "osx" : platform === "linux" ? "linux" : null;
  if (!os || !["x64", "arm64"].includes(arch)) throw new Error(`There are no service copies for ${platform}-${arch}.`);
  return `${os}-${arch}`;
}

// ---------- services.json (the pins) ----------

/** Reads and checks services.json. */
export function readServicesPins(file: string): ServicesPins {
  const pins = JSON.parse(readFileSync(file, "utf8")) as ServicesPins;
  assertPins(pins, file);
  return pins;
}

function assertPins(pins: ServicesPins, where: string): void {
  if (pins?.format !== SERVICES_PINS_FORMAT) throw new Error(`${where}: format must be ${SERVICES_PINS_FORMAT}.`);
  if (!pins.services || typeof pins.services !== "object") throw new Error(`${where}: services is missing.`);
  for (const [name, service] of Object.entries(pins.services)) {
    if (!NAME.test(name)) throw new Error(`${where}: ${name} is not a service name.`);
    if (!isVersion(service?.version ?? "")) throw new Error(`${where}: ${name} needs a semantic version.`);
    for (const [target, pin] of Object.entries(service.targets ?? {})) {
      if (!/^(win|osx|linux)-(x64|arm64)$/.test(target)) throw new Error(`${where}: ${name} has an unknown target ${target}.`);
      if (!pin || typeof pin.archive !== "string" || pin.archive !== path.basename(pin.archive) || !pin.archive.endsWith(".tar.gz")) {
        throw new Error(`${where}: ${name} ${target} needs archive, the file name of a .tar.gz.`);
      }
      if (!SHA256.test(pin.sha256)) throw new Error(`${where}: ${name} ${target} needs sha256, 64 lower-case hex digits.`);
    }
  }
}

/**
 * Pins the archives that the packaging scripts of memex.node and memex.user wrote (memex-<service>-<version>-<target>.json
 * beside each .tar.gz) into services.json. Pins for other targets stay; a service of another version replaces its pins.
 */
export function pinServices(input: { from: string; file: string }): ServicesPins {
  const pins: ServicesPins = existsSync(input.file) ? readServicesPins(input.file) : { format: SERVICES_PINS_FORMAT, services: {} };
  const records = readdirSync(input.from).filter((f) => /^memex-[a-z][a-z0-9]*-.+\.json$/.test(f));
  if (records.length === 0) throw new Error(`${input.from} has no memex-<service>-<version>-<target>.json from a packaging script.`);
  for (const name of records) {
    const record = JSON.parse(readFileSync(path.join(input.from, name), "utf8")) as { app?: string; version?: string; target?: string; archive?: string; sha256?: string };
    const { app, version, target, archive, sha256 } = record;
    if (!app || !version || !target || !archive || !sha256) throw new Error(`${name} is not a packaging record (app, version, target, archive, sha256).`);
    const actual = sha256File(path.join(input.from, archive));
    if (actual !== sha256) throw new Error(`${archive} has the SHA-256 ${actual}, not the ${sha256} of ${name}.`);
    const service = pins.services[app];
    if (!service || service.version !== version) pins.services[app] = { version, targets: {} };
    pins.services[app]!.targets[target] = { archive, sha256 };
  }
  assertPins(pins, input.file);
  writeFileSync(input.file, `${JSON.stringify(pins, null, 2)}\n`);
  return pins;
}

export function sha256File(file: string): string {
  const hash = createHash("sha256");
  const fd = readFileSync(file);
  hash.update(fd);
  return hash.digest("hex");
}

async function sha256Stream(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

// ---------- the pack: stage the copies for one target ----------

/** On Windows the tar of the system (bsdtar); another tar on PATH may not read drive letters. */
function tarProgram(): string {
  if (process.platform !== "win32") return "tar";
  const root = process.env.SystemRoot ?? process.env.windir;
  return root ? path.join(root, "System32", "tar.exe") : "tar.exe";
}

/** Every file and folder under a folder; a link stops it. */
function walkNoLinks(root: string, visit: (file: string, isDir: boolean) => void = () => {}): number {
  let files = 0;
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) throw new Error(`${full} is a link. A service copy has no links.`);
      if (stat.isDirectory()) {
        visit(full, true);
        walk(full);
      } else if (stat.isFile()) {
        visit(full, false);
        files++;
      } else throw new Error(`${full} is not a file or a folder.`);
    }
  };
  walk(root);
  return files;
}

/** Reads service.json of an unpacked copy and checks it names the service, the version and a command inside the folder. */
export function readServiceManifest(folder: string, app: string, version: string): { command: string; args: string[] } {
  const manifest = JSON.parse(readFileSync(path.join(folder, "service.json"), "utf8")) as { format?: string; app?: string; version?: string; command?: string; args?: unknown };
  if (manifest.format !== SERVICE_MANIFEST_FORMAT) throw new Error(`${folder}: service.json is not ${SERVICE_MANIFEST_FORMAT}.`);
  if (manifest.app !== app || manifest.version !== version) throw new Error(`${folder}: service.json names ${manifest.app} ${manifest.version}, not ${app} ${version}.`);
  const command = manifest.command;
  if (typeof command !== "string" || path.isAbsolute(command) || path.relative(folder, path.resolve(folder, command)).startsWith("..")) {
    throw new Error(`${folder}: the command of service.json must be a path inside the folder.`);
  }
  const stat = lstatSync(path.join(folder, command));
  if (!stat.isFile()) throw new Error(`${folder}: the command ${command} is not a file.`);
  const args = Array.isArray(manifest.args) ? (manifest.args as string[]) : [];
  return { command, args };
}

export interface StageServicesOptions {
  /** services.json of the app. */
  pins: string;
  /** The folder with the pinned archives. */
  from: string;
  /** The target of the build: win-x64, osx-arm64, linux-x64. */
  target: string;
  /** An empty folder (or one that does not exist): it becomes <resources>/services. */
  out: string;
  log?: (line: string) => void;
}

/**
 * Checks each pinned archive of the target by SHA-256, unpacks it, checks its service.json and that it has no links, and
 * writes <out>/<service>/<version>/ and <out>/services.json (the bundle). A missing pin or archive stops the pack.
 */
export function stageServices(options: StageServicesOptions): ServicesBundle {
  const log = options.log ?? (() => {});
  const pins = readServicesPins(options.pins);
  if (existsSync(options.out) && readdirSync(options.out).length > 0) throw new Error(`The folder is not empty: ${options.out}`);
  mkdirSync(options.out, { recursive: true });
  const bundle: ServicesBundle = { format: SERVICES_BUNDLE_FORMAT, target: options.target, services: {} };
  for (const [app, service] of Object.entries(pins.services)) {
    const pin = service.targets[options.target];
    if (!pin) throw new Error(`${options.pins} pins no ${options.target} archive for ${app} ${service.version}.`);
    const archive = path.join(options.from, pin.archive);
    if (!existsSync(archive)) throw new Error(`The archive ${pin.archive} of ${app} ${service.version} is not in ${options.from}.`);
    const actual = sha256File(archive);
    if (actual !== pin.sha256) throw new Error(`${pin.archive} has the SHA-256 ${actual}, not the pinned ${pin.sha256}. It is not used.`);
    const work = path.join(options.out, `.unpack-${app}`);
    mkdirSync(work);
    const result = spawnSync(tarProgram(), ["-xzf", archive, "-C", work], { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" });
    if (result.status !== 0) throw new Error(`${pin.archive} could not be unpacked: ${result.error?.message ?? result.stderr}`);
    const top = readdirSync(work);
    if (top.length !== 1) throw new Error(`${pin.archive} must hold one folder, not ${top.length} entries.`);
    const unpacked = path.join(work, top[0]!);
    const files = walkNoLinks(unpacked);
    readServiceManifest(unpacked, app, service.version);
    const folder = path.join(options.out, app, service.version);
    mkdirSync(path.dirname(folder), { recursive: true });
    renameSync(unpacked, folder);
    rmSync(work, { recursive: true });
    bundle.services[app] = { version: service.version, archive: pin.archive, sha256: pin.sha256 };
    log(`Service ${app} ${service.version} for ${options.target}: ${pin.archive}, SHA-256 ${actual} (pinned), ${files} files`);
  }
  writeFileSync(path.join(options.out, "services.json"), `${JSON.stringify(bundle, null, 2)}\n`);
  return bundle;
}

/** Reads <resources>/services/services.json, or null when the build carries no services. */
export function readServicesBundle(resources: string): ServicesBundle | null {
  const file = path.join(resources, SERVICES_RESOURCE, "services.json");
  if (!existsSync(file)) return null;
  const bundle = JSON.parse(readFileSync(file, "utf8")) as ServicesBundle;
  if (bundle?.format !== SERVICES_BUNDLE_FORMAT || !bundle.services) throw new Error(`${file} is not ${SERVICES_BUNDLE_FORMAT}.`);
  for (const [app, service] of Object.entries(bundle.services)) {
    if (!NAME.test(app) || !isVersion(service.version)) throw new Error(`${file}: ${app} ${service.version} is not a service and a version.`);
  }
  return bundle;
}

// ---------- the services folder ----------

export interface ServicesFolderOptions {
  /** The services folder. Default: servicesFolder() of @tjalve/memex-node-client (MEMEX_SERVICES_DIR overrides it). */
  services?: string;
  /** The environment for the folders. Default process.env. */
  env?: NodeJS.ProcessEnv;
  /** How long to wait for the lock that another installer holds. Default 2 minutes. */
  lockTimeoutMs?: number;
  log?: (line: string) => void;
}

/** The services folder, after the check that it is outside ~/Memex (MEMEX_HOME) and the pack store. */
export function checkedServicesFolder(options: Pick<ServicesFolderOptions, "services" | "env"> = {}): string {
  const env = options.env ?? process.env;
  const folder = path.resolve(options.services ?? servicesFolder({ env }));
  const home = os.homedir();
  const root = memexRoot({ platform: process.platform, env, home });
  const packs = memexPaths({ app: "node", platform: process.platform, env, home }).packs;
  for (const [name, other] of [["the Memex folder", root], ["the pack store", packs]] as const) {
    if (isInsideDirectory(folder, other) || isInsideDirectory(other, folder) || path.resolve(other) === folder) {
      throw new Error(`The services folder ${folder} must be outside ${name} (${other}).`);
    }
  }
  return folder;
}

function notALink(folder: string): void {
  try {
    if (lstatSync(folder).isSymbolicLink()) throw new Error(`${folder} is a link. The services folder and its folders must not be links.`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** True when the folder has the marker of a services folder (SERVICES_MARKER). */
export function isServicesFolder(services: string): boolean {
  try {
    const marker = path.join(services, SERVICES_MARKER);
    if (!lstatSync(marker).isFile()) return false;
    return (JSON.parse(readFileSync(marker, "utf8")) as { format?: string })?.format === SERVICES_FOLDER_FORMAT;
  } catch {
    return false;
  }
}

/**
 * Makes the folder a services folder, or checks that it is one: a missing or empty folder gets the marker; a folder
 * that holds anything else and has no marker is refused, because it is not ours.
 */
function claimServicesFolder(services: string): void {
  notALink(services);
  mkdirSync(services, { recursive: true });
  if (isServicesFolder(services)) return;
  const others = readdirSync(services).filter((name) => name !== SERVICES_MARKER && !name.startsWith(`${SERVICES_MARKER}.tmp-`));
  if (others.length > 0) {
    throw new Error(`${services} is not a Memex services folder (it has no ${SERVICES_MARKER}) and holds other files, such as ${others.slice(0, 3).join(", ")}. Name an empty or a new folder.`);
  }
  const temporary = path.join(services, `${SERVICES_MARKER}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`);
  writeFileSync(temporary, `${JSON.stringify({ format: SERVICES_FOLDER_FORMAT })}\n`);
  renameSync(temporary, path.join(services, SERVICES_MARKER));
}

/** True when the version folder has a service.json of memex.service/1 for that service and version. */
function isVersionFolder(folder: string, app: string, version: string): boolean {
  try {
    if (!lstatSync(folder).isDirectory()) return false;
    const manifest = JSON.parse(readFileSync(path.join(folder, "service.json"), "utf8")) as { format?: string; app?: string; version?: string };
    return manifest.format === SERVICE_MANIFEST_FORMAT && manifest.app === app && manifest.version === version;
  } catch {
    return false;
  }
}

const LEFTOVER = /^\.(partial|removing)-[0-9A-Za-z.+-]+-[0-9a-f]{8}$/;

/**
 * True when <services>/<app> holds a service and nothing else: each entry is a version folder with its service.json,
 * or the leftover of a stopped install or removal (.partial-*, .removing-*).
 */
function isServiceFolder(services: string, app: string): boolean {
  const root = path.join(services, app);
  try {
    if (!lstatSync(root).isDirectory()) return false;
    const entries = readdirSync(root);
    return entries.length > 0 && entries.every((name) => (isVersion(name) ? isVersionFolder(path.join(root, name), app, name) : LEFTOVER.test(name) && lstatSync(path.join(root, name)).isDirectory()));
  } catch {
    return false;
  }
}

interface LockInfo {
  pid: number;
  hostname: string;
  startedAt: string;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Runs fn while this process holds <services>/services.lock: created exclusively with { pid, hostname, startedAt }. A
 * lock whose process is gone on this computer, or that is older than 10 minutes, is taken over.
 */
export async function withServicesLock<T>(services: string, timeoutMs: number, fn: () => Promise<T>, log: (line: string) => void = () => {}): Promise<T> {
  mkdirSync(services, { recursive: true });
  let waiting = false;
  const file = path.join(services, SERVICES_LOCK);
  const info: LockInfo = { pid: process.pid, hostname: os.hostname(), startedAt: new Date().toISOString() };
  const until = Date.now() + timeoutMs;
  for (;;) {
    try {
      writeFileSync(file, `${JSON.stringify(info)}\n`, { flag: "wx", mode: 0o600 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    let stale = false;
    try {
      const stat = lstatSync(file);
      const holder = JSON.parse(readFileSync(file, "utf8")) as LockInfo;
      stale = Date.now() - stat.mtimeMs > 10 * 60_000 || (holder.hostname === os.hostname() && typeof holder.pid === "number" && !alive(holder.pid));
    } catch {
      stale = false;
    }
    if (stale) {
      const aside = `${file}.stale-${process.pid}-${randomBytes(4).toString("hex")}`;
      try {
        renameSync(file, aside);
        rmSync(aside, { force: true });
      } catch {
        // another installer moved it first
      }
      continue;
    }
    if (Date.now() >= until) throw new Error(`Another Memex installer holds ${file}. Try again in a moment.`);
    if (!waiting) {
      waiting = true;
      let holder = "another installer";
      try {
        holder = `process ${(JSON.parse(readFileSync(file, "utf8")) as LockInfo).pid}`;
      } catch {
        // released or being written
      }
      log(`Waiting for ${SERVICES_LOCK}, which ${holder} holds.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  try {
    return await fn();
  } finally {
    try {
      const current = JSON.parse(readFileSync(file, "utf8")) as LockInfo;
      if (current.pid === info.pid && current.startedAt === info.startedAt) rmSync(file, { force: true });
    } catch {
      // gone already
    }
  }
}

/** The installed versions of one service, newest first: the folders <services>/<service>/<version>/ with a semantic version as name. */
export function installedVersions(services: string, app: string): string[] {
  const root = path.join(services, app);
  notALink(root);
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((name) => isVersion(name))
    .sort((a, b) => compareVersions(b, a));
}

const REMOVING_SERVICE = /^\.removing-[a-z][a-z0-9]*-[0-9a-f]{8}$/;

/**
 * The services in the services folder: the folders that hold only version folders with a service.json for that service
 * (and leftovers). Anything else is not a service: it is logged and never changed or removed.
 */
export function installedServices(services: string, log: (line: string) => void = () => {}): string[] {
  if (!existsSync(services)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(services, { withFileTypes: true })) {
    if (entry.name === CLIENTS_FOLDER || entry.name === SERVICES_MARKER || entry.name === SERVICES_LOCK) continue;
    if (entry.isDirectory() && NAME.test(entry.name) && isServiceFolder(services, entry.name)) found.push(entry.name);
    else if (!(entry.isDirectory() && REMOVING_SERVICE.test(entry.name))) log(`${path.join(services, entry.name)} is not a Memex service; it stays as it is.`);
  }
  return found.sort();
}

export function readClients(services: string): ServicesClient[] {
  const folder = path.join(services, CLIENTS_FOLDER);
  notALink(folder);
  if (!existsSync(folder)) return [];
  const clients: ServicesClient[] = [];
  for (const name of readdirSync(folder).sort()) {
    if (!name.endsWith(".json")) continue;
    try {
      const client = JSON.parse(readFileSync(path.join(folder, name), "utf8")) as ServicesClient;
      if (client.format === SERVICES_CLIENT_FORMAT && `${client.app}.json` === name) clients.push(client);
    } catch {
      // a broken entry counts as no client
    }
  }
  return clients;
}

function programExists(program: string): boolean {
  try {
    return lstatSync(program).isFile();
  } catch {
    return false;
  }
}

/** The running copy of a service, when its app record names a live process whose program is inside that folder. */
async function runningCopy(app: string, env: NodeJS.ProcessEnv): Promise<{ pid: number; executable: string; version: string } | null> {
  let apps: string;
  try {
    apps = memexPaths({ app: app as "node", platform: process.platform, env, home: os.homedir() }).apps;
  } catch {
    return null;
  }
  const found = await probe(app, { apps, timeoutMs: 2000 });
  if (!found.record?.running) return null;
  if (found.state === "stopped") return null;
  return { pid: found.record.running.pid, executable: found.record.executable, version: found.record.version };
}

/** Removes a folder inside the services folder: first renamed aside, so that no launcher sees half of it. */
function removeFolder(folder: string, services: string, log: (line: string) => void): boolean {
  if (!isInsideDirectory(folder, services) || path.resolve(folder) === path.resolve(services)) throw new Error(`${folder} is not inside ${services}.`);
  notALink(folder);
  const aside = path.join(path.dirname(folder), `.removing-${path.basename(folder)}-${randomBytes(4).toString("hex")}`);
  try {
    renameSync(folder, aside);
  } catch (error) {
    log(`${folder} stays: it cannot be moved (${(error as Error).message}); a program in it may run.`);
    return false;
  }
  try {
    rmSync(aside, { recursive: true, force: true });
  } catch (error) {
    log(`${aside} is left over: ${(error as Error).message}. The next install removes it.`);
  }
  return true;
}

/** Leftovers of an install or a removal that stopped: .partial-* and .removing-* folders. Only under the lock. */
function removeLeftovers(services: string, log: (line: string) => void): void {
  for (const name of readdirSync(services)) {
    if (!REMOVING_SERVICE.test(name)) continue;
    try {
      rmSync(path.join(services, name), { recursive: true, force: true });
      log(`Removed the leftover ${path.join(services, name)}.`);
    } catch (error) {
      log(`The leftover ${path.join(services, name)} stays: ${(error as Error).message}`);
    }
  }
  for (const app of installedServices(services)) {
    const root = path.join(services, app);
    for (const name of readdirSync(root)) {
      if (!LEFTOVER.test(name)) continue;
      try {
        rmSync(path.join(root, name), { recursive: true, force: true });
        log(`Removed the leftover ${path.join(root, name)}.`);
      } catch (error) {
        log(`The leftover ${path.join(root, name)} stays: ${(error as Error).message}`);
      }
    }
  }
}

/** Copies a folder of real files and folders (no links), 16 files at a time, and checks each copy against its source by SHA-256. */
async function copyVerified(from: string, to: string): Promise<number> {
  const jobs: Array<{ s: string; d: string; mode: number }> = [];
  const walk = async (src: string, dst: string) => {
    await fs.mkdir(dst);
    for (const entry of await fs.readdir(src)) {
      const s = path.join(src, entry);
      const d = path.join(dst, entry);
      const stat = await fs.lstat(s);
      if (stat.isSymbolicLink()) throw new Error(`${s} is a link. A service copy has no links.`);
      if (stat.isDirectory()) await walk(s, d);
      else if (stat.isFile()) jobs.push({ s, d, mode: stat.mode & 0o777 });
      else throw new Error(`${s} is not a file or a folder.`);
    }
  };
  await walk(from, to);
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const { s, d, mode } = jobs[next++]!;
      await fs.copyFile(s, d);
      if (process.platform !== "win32") await fs.chmod(d, mode);
      const [a, b] = await Promise.all([sha256Stream(s), sha256Stream(d)]);
      if (a !== b) throw new Error(`The copy of ${s} differs from the file.`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(16, jobs.length) }, worker));
  return jobs.length;
}

export interface InstallServicesOptions extends ServicesFolderOptions {
  /** The app's resources folder (process.resourcesPath), with services/services.json and the unpacked copies. */
  resources: string;
  /** The app that carries the services; it is listed in <services>/clients/<app>.json. */
  client: { app: string; productName: string; version: string; program: string };
}

export interface InstallServicesResult {
  services: string;
  /**
   * Per service: installed (copied now), present (that version was installed already), skipped (two newer versions are
   * installed), or refused (the service's folder holds something that is not a Memex service).
   */
  copies: Array<{ app: string; version: string; action: "installed" | "present" | "skipped" | "refused"; files?: number }>;
  removed: Array<{ app: string; version: string }>;
  clients: string[];
}

/**
 * Installs the services that the app carries into the services folder, under the lock: each version folder that is not
 * there yet is copied into .partial-<version>-<random>, checked file by file, and renamed into place, so a launcher sees
 * a whole copy or none. A version is not installed when two newer versions are. Then the app is listed as a client, and
 * the older versions beyond the newest two are removed, unless their program runs. ensureNode and ensureUser then start
 * the newest copy (contracts/surfaces.md, Service launcher).
 */
export async function installServices(options: InstallServicesOptions): Promise<InstallServicesResult | null> {
  const log = options.log ?? (() => {});
  const bundle = readServicesBundle(options.resources);
  if (!bundle) return null;
  if (!NAME.test(options.client.app)) throw new Error(`${options.client.app} is not an app name.`);
  const env = options.env ?? process.env;
  const services = checkedServicesFolder(options);
  claimServicesFolder(services);
  return withServicesLock(services, options.lockTimeoutMs ?? 120_000, async () => {
    removeLeftovers(services, log);
    const result: InstallServicesResult = { services, copies: [], removed: [], clients: [] };
    for (const [app, service] of Object.entries(bundle.services)) {
      if (existsSync(path.join(services, app)) && !isServiceFolder(services, app)) {
        result.copies.push({ app, version: service.version, action: "refused" });
        log(`${app} ${service.version} is not installed: ${path.join(services, app)} holds something that is not a Memex service.`);
        continue;
      }
      const versions = installedVersions(services, app);
      const target = path.join(services, app, service.version);
      if (versions.includes(service.version)) {
        result.copies.push({ app, version: service.version, action: "present" });
        log(`${app} ${service.version} is installed already in ${target}.`);
        continue;
      }
      const newer = versions.filter((v) => compareVersions(v, service.version) > 0);
      if (newer.length >= KEEP_VERSIONS) {
        result.copies.push({ app, version: service.version, action: "skipped" });
        log(`${app} ${service.version} is not installed: ${newer.join(" and ")} are newer.`);
        continue;
      }
      const source = path.join(options.resources, SERVICES_RESOURCE, app, service.version);
      readServiceManifest(source, app, service.version);
      const partial = path.join(services, app, `.partial-${service.version}-${randomBytes(4).toString("hex")}`);
      await fs.mkdir(path.join(services, app), { recursive: true });
      const files = await copyVerified(source, partial);
      readServiceManifest(partial, app, service.version);
      await fs.rename(partial, target);
      result.copies.push({ app, version: service.version, action: "installed", files });
      log(`Installed ${app} ${service.version} into ${target} (${files} files, each checked).`);
    }
    const client: ServicesClient = {
      format: SERVICES_CLIENT_FORMAT,
      ...options.client,
      services: Object.fromEntries(Object.entries(bundle.services).map(([app, s]) => [app, s.version])),
      updatedAt: new Date().toISOString(),
    };
    mkdirSync(path.join(services, CLIENTS_FOLDER), { recursive: true });
    const entry = path.join(services, CLIENTS_FOLDER, `${client.app}.json`);
    writeFileSync(`${entry}.tmp`, `${JSON.stringify(client, null, 2)}\n`);
    renameSync(`${entry}.tmp`, entry);
    result.clients = pruneClients(services, log).map((c) => c.app);
    for (const app of installedServices(services, log)) {
      const running = await runningCopy(app, env);
      for (const version of installedVersions(services, app).slice(KEEP_VERSIONS)) {
        const folder = path.join(services, app, version);
        if (running && isInsideDirectory(running.executable, folder)) {
          log(`${app} ${version} stays: it runs (process ${running.pid}).`);
          continue;
        }
        if (!isVersionFolder(folder, app, version)) continue;
        if (removeFolder(folder, services, log)) {
          result.removed.push({ app, version });
          log(`Removed ${app} ${version}: only the newest ${KEEP_VERSIONS} versions are kept.`);
        }
      }
    }
    return result;
  }, log);
}

/** Removes the clients whose program is gone (an app removed without its uninstaller) and returns the others. */
function pruneClients(services: string, log: (line: string) => void): ServicesClient[] {
  const kept: ServicesClient[] = [];
  for (const client of readClients(services)) {
    if (programExists(client.program)) kept.push(client);
    else {
      rmSync(path.join(services, CLIENTS_FOLDER, `${client.app}.json`), { force: true });
      log(`${client.productName} is no longer installed (${client.program} is gone); it is no longer a client.`);
    }
  }
  return kept;
}

export interface UninstallServicesOptions extends ServicesFolderOptions {
  /** The app whose uninstaller runs. */
  app: string;
  /** How long to wait for a running service to stop after POST /v1/drain. Default 70 s (Node drains for at most 60 s). */
  stopTimeoutMs?: number;
}

export interface UninstallServicesResult {
  services: string;
  /** The apps that still carry the services. When there are none, the services were removed. */
  clients: string[];
  removed: string[];
  /** Services that stay because their program still runs. */
  kept: string[];
}

/**
 * The uninstaller's part: the app is no longer a client. When no other app is a client, every service in the services
 * folder is asked to drain and stop, and its folder, the clients folder and the services folder are removed. Nothing
 * outside the services folder is touched: never ~/Memex, the pack store or the app records.
 */
export async function uninstallServices(options: UninstallServicesOptions): Promise<UninstallServicesResult> {
  const log = options.log ?? (() => {});
  const env = options.env ?? process.env;
  const services = checkedServicesFolder(options);
  notALink(services);
  const result: UninstallServicesResult = { services, clients: [], removed: [], kept: [] };
  if (!existsSync(services)) return result;
  if (!isServicesFolder(services)) {
    log(`${services} is not a Memex services folder (it has no ${SERVICES_MARKER}); nothing in it is changed.`);
    return result;
  }
  await withServicesLock(services, options.lockTimeoutMs ?? 120_000, async () => {
    rmSync(path.join(services, CLIENTS_FOLDER, `${options.app}.json`), { force: true });
    result.clients = pruneClients(services, log).map((c) => c.app);
    if (result.clients.length > 0) {
      log(`The services stay: ${result.clients.join(", ")} still ${result.clients.length === 1 ? "carries" : "carry"} them.`);
      return;
    }
    for (const app of installedServices(services, log)) {
      const running = await runningCopy(app, env);
      if (running && isInsideDirectory(running.executable, path.join(services, app))) {
        log(`${app} ${running.version} runs (process ${running.pid}); it is asked to drain and stop.`);
        await stopService(app, env, running.pid, options.stopTimeoutMs ?? 70_000, log);
      }
      if (removeFolder(path.join(services, app), services, log)) {
        result.removed.push(app);
        log(`Removed ${app}: no installed app carries it any more.`);
      } else result.kept.push(app);
    }
    const clients = path.join(services, CLIENTS_FOLDER);
    if (existsSync(clients)) {
      notALink(clients);
      for (const name of readdirSync(clients)) if (name.endsWith(".json") || name.endsWith(".json.tmp")) rmSync(path.join(clients, name), { force: true });
      try {
        rmdirSync(clients);
      } catch {
        log(`${clients} stays: it holds other files.`);
      }
    }
  }, log);
  if (result.clients.length > 0) return result;
  // The lock file is gone now. The folder goes when it holds nothing but its marker; anything else in it stays.
  try {
    const others = readdirSync(services).filter((name) => name !== SERVICES_MARKER);
    if (others.length === 0) {
      rmSync(path.join(services, SERVICES_MARKER), { force: true });
      rmdirSync(services);
      log(`Removed the empty services folder ${services}.`);
    } else log(`The services folder ${services} stays: it also holds ${others.join(", ")}.`);
  } catch {
    // another installer added to it
  }
  return result;
}

async function stopService(app: string, env: NodeJS.ProcessEnv, pid: number, timeoutMs: number, log: (line: string) => void): Promise<void> {
  try {
    const apps = memexPaths({ app: app as "node", platform: process.platform, env, home: os.homedir() }).apps;
    const found = await probe(app, { apps, timeoutMs: 2000 });
    if (found.state === "running") {
      const answer = await sendRequest(await endpointOf(found.record.running!), { method: "POST", path: "/v1/drain", headers: { accept: "application/json" }, timeoutMs: 5000 });
      log(`POST /v1/drain to ${app} answered ${answer.status}.`);
    }
  } catch (error) {
    log(`${app} did not take the drain: ${(error as Error).message}`);
  }
  const until = Date.now() + timeoutMs;
  while (alive(pid) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 200));
  log(alive(pid) ? `${app} (process ${pid}) still runs after ${timeoutMs} ms.` : `${app} (process ${pid}) stopped.`);
}

/** What the services folder holds: each service with its versions, and the clients. */
export function servicesStatus(options: Pick<ServicesFolderOptions, "services" | "env"> = {}): { services: string; installed: Record<string, string[]>; clients: ServicesClient[] } {
  const services = checkedServicesFolder(options);
  const installed: Record<string, string[]> = {};
  for (const app of installedServices(services)) installed[app] = installedVersions(services, app);
  return { services, installed, clients: readClients(services) };
}

/** The action of --memex-services=<action> in a command line, or null. */
export function servicesAction(argv: readonly string[]): "install" | "uninstall" | null {
  for (const arg of argv) {
    if (arg === `${SERVICES_ARG}=install`) return "install";
    if (arg === `${SERVICES_ARG}=uninstall`) return "uninstall";
  }
  return null;
}
