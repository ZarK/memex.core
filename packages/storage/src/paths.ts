import path from "node:path";

/** App ids from contracts/storage.md, with their folder names. */
export const APP_FOLDERS = {
  photos: "Photos",
  study: "Study",
  finance: "Finance",
  health: "Health",
  workspace: "Workspace",
  studio: "Studio",
  contacts: "Contacts",
  conversations: "Conversations",
  calendar: "Calendar",
  node: "Node",
  user: "User",
  archive: "Archive",
  capture: "Capture",
  codesessions: "CodeSessions",
} as const;

export type AppId = keyof typeof APP_FOLDERS;
export const APP_IDS = Object.keys(APP_FOLDERS) as AppId[];

export type Env = Readonly<Record<string, string | undefined>>;

export interface MemexPathsInput {
  app: string;
  /** A Node.js platform name: "win32", "darwin", "linux". Others use the Linux rules. */
  platform: string;
  env: Env;
  /** The user's home folder, absolute. */
  home: string;
  /** The app's data folder flag, for example --data. Absolute. */
  flag?: string;
  /** The parsed locations.json: the folders the user chose. Not read when MEMEX_HOME is set. */
  locations?: LocationsFile;
}

/** locations.json: the folders the user chose, per app (contracts/storage.md, Chosen locations). */
export interface LocationsFile {
  format: "memex.locations/1";
  apps: Partial<Record<string, AppLocations>>;
  /** The folder the user moved the pack store to (Memex.Node writes it; storage contract 1.1). Absolute. */
  packs?: string;
}

export interface AppLocations {
  data?: string;
  cache?: string;
}

/** Where the data folder came from, in precedence order. */
export type DataSource = "flag" | "variable" | "memex-home" | "locations" | "default";

/** Where the pack store folder came from: MEMEX_PACKS_DIR, the folder the user moved it to, or the OS default. */
export type PacksSource = "variable" | "locations" | "default";

export interface MemexPaths {
  data: string;
  cache: string;
  logs: string;
  state: string;
  packs: string;
  apps: string;
  archive: string;
}

export type MemexPathsErrorCode = "unknown-app" | "relative-path" | "invalid-locations";

export class MemexPathsError extends Error {
  readonly code: MemexPathsErrorCode;
  constructor(code: MemexPathsErrorCode, message: string) {
    super(message);
    this.name = "MemexPathsError";
    this.code = code;
  }
}

export function isAppId(value: string): value is AppId {
  return Object.prototype.hasOwnProperty.call(APP_FOLDERS, value);
}

/** The variable that sets an app's data folder, for example MEMEX_PHOTOS_HOME. */
export function appHomeVariable(app: AppId): string {
  return `MEMEX_${app.toUpperCase()}_HOME`;
}

/** @internal */
export function pathApi(platform: string): path.PlatformPath {
  return platform === "win32" ? path.win32 : path.posix;
}

/** @internal */
export function clean(p: path.PlatformPath, value: string): string {
  let out = p.normalize(value);
  const root = p.parse(out).root;
  while (out.length > root.length && (out.endsWith(p.sep) || (p === path.win32 && out.endsWith("/")))) {
    out = out.slice(0, -1);
  }
  return out;
}

/** @internal */
export function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}

function required(p: path.PlatformPath, name: string, value: string | undefined): string | undefined {
  const v = nonEmpty(value);
  if (v === undefined) return undefined;
  if (!isAbsolute(p, v)) {
    throw new MemexPathsError("relative-path", `${name} must be an absolute path: ${v}`);
  }
  return clean(p, v);
}

function optional(p: path.PlatformPath, value: string | undefined): string | undefined {
  const v = nonEmpty(value);
  if (v === undefined || !isAbsolute(p, v)) return undefined;
  return clean(p, v);
}

/** @internal */
export function isAbsolute(p: path.PlatformPath, value: string): boolean {
  if (p === path.win32) {
    // A rooted path without a drive ("\\foo") is relative to the current drive: not absolute here.
    return /^[A-Za-z]:[\\/]/.test(value) || /^[\\/]{2}[^\\/]/.test(value);
  }
  return p.isAbsolute(value);
}

interface Resolved {
  p: path.PlatformPath;
  home: string;
  folder: string;
  data: string;
  source: DataSource;
  userRoot: string;
  chosen: AppLocations;
  archive: string;
}

function chosenFolder(p: path.PlatformPath, app: string, key: keyof AppLocations, value: string | undefined): string | undefined {
  const v = nonEmpty(value);
  if (v === undefined) return undefined;
  if (!isAbsolute(p, v)) {
    throw new MemexPathsError("relative-path", `locations.json: ${app}.${key} must be an absolute path: ${v}`);
  }
  return clean(p, v);
}

function resolve(input: MemexPathsInput): Resolved {
  const { app, platform, env } = input;
  if (!isAppId(app)) {
    throw new MemexPathsError("unknown-app", `Unknown Memex app id: ${app}`);
  }
  const p = pathApi(platform);
  const home = required(p, "home", input.home);
  if (home === undefined) {
    throw new MemexPathsError("relative-path", "home must be an absolute path");
  }
  const folder = APP_FOLDERS[app];

  const flag = required(p, "flag", input.flag);
  const appHome = required(p, appHomeVariable(app), env[appHomeVariable(app)]);
  const memexHome = required(p, "MEMEX_HOME", env.MEMEX_HOME);
  const archiveHome = required(p, "MEMEX_ARCHIVE_HOME", env.MEMEX_ARCHIVE_HOME);
  // MEMEX_HOME is for development and test runs: they never read the user's chosen folders.
  const apps = memexHome === undefined ? input.locations?.apps ?? {} : {};
  const own = apps[app] ?? {};
  const chosen: AppLocations = {};
  const chosenData = chosenFolder(p, app, "data", own.data);
  const chosenCache = chosenFolder(p, app, "cache", own.cache);
  if (chosenData !== undefined) chosen.data = chosenData;
  if (chosenCache !== undefined) chosen.cache = chosenCache;
  const chosenArchive = app === "archive" ? chosenData : chosenFolder(p, "archive", "data", apps.archive?.data);

  const userRoot = memexHome ?? p.join(home, "Memex");
  let data: string, source: DataSource;
  if (flag !== undefined) [data, source] = [flag, "flag"];
  else if (appHome !== undefined) [data, source] = [appHome, "variable"];
  else if (memexHome !== undefined) [data, source] = [p.join(memexHome, folder), "memex-home"];
  else if (chosenData !== undefined) [data, source] = [chosenData, "locations"];
  else [data, source] = [p.join(userRoot, folder), "default"];
  const archive =
    app === "archive" ? data : archiveHome ?? (memexHome !== undefined ? p.join(memexHome, "Archive") : chosenArchive ?? p.join(userRoot, "Archive"));
  return { p, home, folder, data, source, userRoot, chosen, archive };
}

/**
 * Where the data folder of an app comes from: a flag, its MEMEX_<APP>_HOME variable, MEMEX_HOME,
 * locations.json, or the default. An app may make a missing folder only for "default" and "memex-home".
 */
export function dataSource(input: MemexPathsInput): DataSource {
  return resolve(input).source;
}

/** The Memex root that holds README.txt: MEMEX_HOME, else ~/Memex. */
export function memexRoot(input: { platform: string; env: Env; home: string }): string {
  const p = pathApi(input.platform);
  const home = required(p, "home", input.home);
  if (home === undefined) throw new MemexPathsError("relative-path", "home must be an absolute path");
  return required(p, "MEMEX_HOME", input.env.MEMEX_HOME) ?? p.join(home, "Memex");
}

/**
 * Where locations.json lives. It is machine-local, outside ~/Memex, because it says where ~/Memex parts are:
 * %LOCALAPPDATA%\Memex\locations.json, ~/Library/Application Support/Memex/locations.json,
 * $XDG_CONFIG_HOME/memex/locations.json.
 */
export function locationsFilePath(input: { platform: string; env: Env; home: string }): string {
  const p = pathApi(input.platform);
  const home = required(p, "home", input.home);
  if (home === undefined) throw new MemexPathsError("relative-path", "home must be an absolute path");
  if (input.platform === "win32") {
    return p.join(optional(p, input.env.LOCALAPPDATA) ?? p.join(home, "AppData", "Local"), "Memex", "locations.json");
  }
  if (input.platform === "darwin") return p.join(home, "Library", "Application Support", "Memex", "locations.json");
  return p.join(optional(p, input.env.XDG_CONFIG_HOME) ?? p.join(home, ".config"), "memex", "locations.json");
}

/**
 * The pack store folder before the OS default: MEMEX_PACKS_DIR, then the top-level "packs" of locations.json (the
 * folder Memex.Node moved the store to). Like the chosen folders of apps, "packs" is not read when MEMEX_HOME is set.
 */
function resolvePacks(p: path.PlatformPath, input: MemexPathsInput): { folder: string | undefined; source: PacksSource } {
  const variable = required(p, "MEMEX_PACKS_DIR", input.env.MEMEX_PACKS_DIR);
  if (variable !== undefined) return { folder: variable, source: "variable" };
  const memexHome = required(p, "MEMEX_HOME", input.env.MEMEX_HOME);
  if (memexHome === undefined) {
    const chosen = nonEmpty(input.locations?.packs);
    if (chosen !== undefined) {
      if (!isAbsolute(p, chosen)) throw new MemexPathsError("relative-path", `locations.json: packs must be an absolute path: ${chosen}`);
      return { folder: clean(p, chosen), source: "locations" };
    }
  }
  return { folder: undefined, source: "default" };
}

/**
 * Where the pack store folder of memexPaths() comes from: "variable" (MEMEX_PACKS_DIR), "locations" (the folder the
 * user moved the store to, in locations.json), or "default". Memex.Node reports the same values.
 */
export function packsSource(input: MemexPathsInput): PacksSource {
  const { platform } = input;
  resolve(input);
  return resolvePacks(pathApi(platform), input).source;
}

/**
 * The folders of one Memex app (contracts/storage.md). Pure: it reads only its input.
 * Throws MemexPathsError for an unknown app id or a relative flag, variable, home, or chosen folder.
 */
export function memexPaths(input: MemexPathsInput): MemexPaths {
  const { app, platform, env } = input;
  const { p, home, folder, data, chosen, archive } = resolve(input);
  const packsDir = resolvePacks(p, input).folder;
  const appsDir = required(p, "MEMEX_APPS_DIR", env.MEMEX_APPS_DIR);

  let cache: string, logs: string, state: string, packsDefault: string, appsDefault: string;
  if (platform === "win32") {
    const local = optional(p, env.LOCALAPPDATA) ?? p.join(home, "AppData", "Local");
    const base = p.join(local, "Memex");
    cache = p.join(base, folder, "Cache");
    logs = p.join(base, folder, "Logs");
    state = p.join(base, folder, "State");
    packsDefault = p.join(base, "Packs");
    appsDefault = p.join(base, "Apps");
  } else if (platform === "darwin") {
    const support = p.join(home, "Library", "Application Support", "Memex");
    cache = p.join(home, "Library", "Caches", "Memex", folder);
    logs = p.join(home, "Library", "Logs", "Memex", folder);
    state = p.join(support, folder);
    packsDefault = p.join(support, "Packs");
    appsDefault = p.join(support, "Apps");
  } else {
    const xdgCache = optional(p, env.XDG_CACHE_HOME) ?? p.join(home, ".cache");
    const xdgState = optional(p, env.XDG_STATE_HOME) ?? p.join(home, ".local", "state");
    const xdgData = optional(p, env.XDG_DATA_HOME) ?? p.join(home, ".local", "share");
    cache = p.join(xdgCache, "memex", app);
    logs = p.join(xdgState, "memex", app, "logs");
    state = p.join(xdgState, "memex", app, "state");
    packsDefault = p.join(xdgData, "memex", "packs");
    appsDefault = p.join(xdgData, "memex", "apps");
  }

  // MEMEX_LOCAL_ROOT moves the machine-local folders (cache, logs, state) to a chosen folder: tests and sandboxes set it.
  const localRoot = required(p, "MEMEX_LOCAL_ROOT", env.MEMEX_LOCAL_ROOT);
  if (localRoot !== undefined) {
    cache = p.join(localRoot, folder, "Cache");
    logs = p.join(localRoot, folder, "Logs");
    state = p.join(localRoot, folder, "State");
  }
  return {
    data,
    cache: chosen.cache ?? cache,
    logs,
    state,
    packs: packsDir ?? packsDefault,
    apps: appsDir ?? appsDefault,
    archive,
  };
}

/** Retired variables in contract order, with their replacements (null: no variable replaces it). */
export const RETIRED_VARIABLES: ReadonlyArray<{ name: string; replacement: string | null }> = [
  { name: "FINANCE_DB", replacement: "MEMEX_FINANCE_HOME" },
  { name: "HEALTH_HOME", replacement: "MEMEX_HEALTH_HOME" },
  { name: "HEALTH_DATA", replacement: "MEMEX_HEALTH_HOME" },
  { name: "HEALTH_PREFERENCES", replacement: "MEMEX_HEALTH_HOME" },
  { name: "AIW_DB", replacement: "MEMEX_WORKSPACE_HOME" },
  { name: "AIW_PROVIDERS", replacement: "MEMEX_WORKSPACE_HOME" },
  { name: "AIW_TOOLS", replacement: "MEMEX_WORKSPACE_HOME" },
  { name: "AIW_ARTIFACT_ROOT", replacement: "MEMEX_WORKSPACE_HOME" },
  { name: "AIW_HIMALAYA_CONFIG", replacement: "MEMEX_WORKSPACE_HOME" },
  { name: "DASHBOARD_DB_PATH", replacement: "MEMEX_STUDIO_HOME" },
  { name: "DASHBOARD_WORKFLOW_DIR", replacement: "MEMEX_STUDIO_HOME" },
  { name: "MEMEX_PHOTOS_LIBRARY", replacement: "MEMEX_PHOTOS_HOME" },
  { name: "MEMEX_MODELS_ROOT", replacement: "MEMEX_PACKS_DIR" },
  { name: "MEMEX_GEODATA_ROOT", replacement: "MEMEX_PACKS_DIR" },
  { name: "MEMEX_THUMBNAIL_CACHE_ROOT", replacement: null },
  { name: "MEMEX_STUDY_LIBRARY", replacement: "MEMEX_STUDY_HOME" },
  { name: "MEMEX_INSTANCE_DIR", replacement: "MEMEX_HOME" },
];

/** The retired variables that are set and not empty, in contract order. Apps warn once per entry. */
export function retiredVariables(env: Env): Array<{ name: string; replacement: string | null }> {
  return RETIRED_VARIABLES.filter((v) => nonEmpty(env[v.name]) !== undefined).map((v) => ({ ...v }));
}

export type SyncCheckedKey = "data" | "cache" | "logs" | "state" | "packs" | "apps";
export const SYNC_CHECKED_KEYS: readonly SyncCheckedKey[] = ["data", "cache", "logs", "state", "packs", "apps"];

export interface SyncWarning {
  key: SyncCheckedKey;
  path: string;
  client: string;
}

const SEGMENT_CLIENTS: Array<{ test: (s: string) => boolean; client: string }> = [
  { test: (s) => s === "onedrive" || s.startsWith("onedrive - "), client: "OneDrive" },
  { test: (s) => s === "dropbox" || s.startsWith("dropbox ("), client: "Dropbox" },
  { test: (s) => s === "iclouddrive" || s === "icloud drive" || s === "mobile documents", client: "iCloud Drive" },
  { test: (s) => s === "google drive" || s === "my drive", client: "Google Drive" },
  { test: (s) => s === "proton drive", client: "Proton Drive" },
  { test: (s) => s === "nextcloud", client: "Nextcloud" },
  { test: (s) => s === "pcloud drive", client: "pCloud" },
];

/** @internal */
export function segments(p: path.PlatformPath, value: string): string[] {
  return clean(p, value).split(p === path.win32 ? /[\\/]+/ : /\/+/).filter((s) => s.length > 0);
}

/** @internal */
export function isInside(p: path.PlatformPath, child: string, parent: string): boolean {
  const c = segments(p, child).map((s) => s.toLowerCase());
  const r = segments(p, parent).map((s) => s.toLowerCase());
  return r.length > 0 && r.length <= c.length && r.every((s, i) => s === c[i]);
}

/** The client that covers a path, or null. Reads only the path. */
export function syncClientFor(value: string, options: { platform: string; env: Env; home: string }): string | null {
  const p = pathApi(options.platform);
  if (options.platform === "win32") {
    for (const name of ["OneDrive", "OneDriveConsumer", "OneDriveCommercial"]) {
      const root = optional(p, options.env[name]);
      if (root !== undefined && isInside(p, value, root)) return "OneDrive";
    }
  }
  if (options.platform === "darwin") {
    const storage = p.join(options.home, "Library", "CloudStorage");
    if (isInside(p, value, storage)) {
      const rest = segments(p, value).slice(segments(p, storage).length);
      if (rest.length > 0) {
        const name = rest[0]!;
        const dash = name.indexOf("-");
        return dash > 0 ? name.slice(0, dash) : name;
      }
    }
  }
  for (const segment of segments(p, value)) {
    const s = segment.toLowerCase();
    for (const entry of SEGMENT_CLIENTS) {
      if (entry.test(s)) return entry.client;
    }
  }
  return null;
}

/** One warning per checked folder that a sync client covers. The archive is exempt. */
export function syncWarnings(
  paths: Partial<MemexPaths>,
  options: { platform: string; env: Env; home: string },
): SyncWarning[] {
  const out: SyncWarning[] = [];
  for (const key of SYNC_CHECKED_KEYS) {
    const value = paths[key];
    if (value === undefined) continue;
    const client = syncClientFor(value, options);
    if (client !== null) out.push({ key, path: value, client });
  }
  return out;
}
