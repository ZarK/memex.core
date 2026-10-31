import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { locationsFilePath, memexPaths, packsSource, readLocationsSync, type PacksSource } from "@tjalve/memex-storage";
import { MANIFEST_FILE, PACK_ID_PATTERN, PACK_VERSION_PATTERN, PackError, STORE_FORMAT, checkPackManifest, packDigest, packFolder, type PackManifest } from "./manifest.js";

/** The name of the index of the store. */
export const STORE_INDEX = "packs.json";
/** Downloads in progress: .staging/<id>/<version>-<sha8>/. */
export const STAGING_FOLDER = ".staging";

/** One entry of packs.json: the active version of a pack. */
export interface StoreEntry {
  version: string;
  digest: string;
  /** <id>/<version>-<sha8>, relative to the store, with '/'. */
  folder: string;
  activatedAt: string;
}

/** <packs>/packs.json (memex.packs/1). */
export interface StoreIndex {
  format: typeof STORE_FORMAT;
  packs: Record<string, StoreEntry>;
}

export interface StoreFolderOptions {
  /** The environment. Default process.env. */
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** The user's home folder. Default os.homedir(). */
  home?: string;
}

export interface StoreFolder {
  path: string;
  /** variable (MEMEX_PACKS_DIR), locations (the user moved the store), or default. */
  source: PacksSource;
}

/**
 * The pack store folder (contracts/storage.md): MEMEX_PACKS_DIR, else the folder the user moved the store to (the
 * top-level "packs" of locations.json, which Memex.Node writes; not read when MEMEX_HOME is set), else the OS default.
 */
export function packStoreFolder(options: StoreFolderOptions = {}): StoreFolder {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.home ?? os.homedir();
  const context = { platform, env, home };
  const locations = (env.MEMEX_HOME ?? "") === "" ? readLocationsSync(locationsFilePath(context)) : undefined;
  const input = { app: "node", ...context, locations };
  return { path: memexPaths(input).packs, source: packsSource(input) };
}

function storeRoot(root: string | undefined): string {
  return root ?? packStoreFolder().path;
}

/**
 * Reads packs.json. A missing file is an empty store. Entries that do not follow memex.packs/1 are left out, as
 * Memex.Node leaves them out. Throws PackError "invalid_store" for a file that is not memex.packs/1.
 */
export async function readStoreIndex(root?: string): Promise<StoreIndex> {
  const file = path.join(storeRoot(root), STORE_INDEX);
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { format: STORE_FORMAT, packs: {} };
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new PackError("invalid_store", `${file} is not valid JSON: ${(error as Error).message}`);
  }
  const v = value as { format?: unknown; packs?: unknown } | null;
  if (typeof v !== "object" || v === null || v.format !== STORE_FORMAT || typeof v.packs !== "object" || v.packs === null || Array.isArray(v.packs)) {
    throw new PackError("invalid_store", `${file} must have "format": "${STORE_FORMAT}" and an object "packs".`);
  }
  const packs: Record<string, StoreEntry> = {};
  for (const [id, entry] of Object.entries(v.packs as Record<string, unknown>)) {
    const e = entry as Partial<StoreEntry> | null;
    if (!PACK_ID_PATTERN.test(id) || typeof e !== "object" || e === null) continue;
    if (typeof e.version !== "string" || typeof e.digest !== "string" || typeof e.folder !== "string") continue;
    packs[id] = { version: e.version, digest: e.digest, folder: e.folder, activatedAt: typeof e.activatedAt === "string" ? e.activatedAt : "" };
  }
  return { ...(v as object), format: STORE_FORMAT, packs };
}

/** An installed pack version: its folder and its manifest. */
export interface ResolvedPack {
  id: string;
  version: string;
  digest: string;
  /** <id>/<version>-<sha8>, relative to the store. */
  folder: string;
  /** The absolute path of the version folder. */
  path: string;
  /** True when packs.json names this version as the active one. */
  active: boolean;
  manifest: PackManifest;
}

export interface ResolveOptions {
  /** The store folder. Default packStoreFolder(). */
  root?: string;
  /** A pinned version: its folder when it is installed, active or not. */
  version?: string;
}

const FOLDER_PATTERN = /^([a-z0-9][a-z0-9._-]{0,63})\/([0-9A-Za-z][0-9A-Za-z._+-]{0,63})-([0-9a-f]{8})$/;

async function readInstalled(root: string, folder: string): Promise<PackManifest | null> {
  let text: string;
  try {
    text = await fs.readFile(path.join(root, ...folder.split("/"), MANIFEST_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") return null;
    throw error;
  }
  const manifest = checkPackManifest(JSON.parse(text));
  if (packFolder(manifest) !== folder) {
    throw new PackError("invalid_store", `The manifest in ${folder} describes ${packFolder(manifest)}, not this folder.`);
  }
  return manifest;
}

/**
 * Finds an installed pack without Node (contracts/packs.md, Read the store without Node): the active version of
 * packs.json, or the pinned version when it is installed. Returns null when the pack or the version is not installed.
 * Needs no lock: an installed version folder never changes.
 */
export async function resolvePack(id: string, options: ResolveOptions = {}): Promise<ResolvedPack | null> {
  if (!PACK_ID_PATTERN.test(id)) throw new PackError("invalid_input", `'${id}' is not a pack id.`);
  const root = storeRoot(options.root);
  const index = await readStoreIndex(root);
  const entry = index.packs[id];
  if (options.version === undefined || entry?.version === options.version) {
    if (entry === undefined) return null;
    const match = FOLDER_PATTERN.exec(entry.folder);
    if (match === null || match[1] !== id || match[2] !== entry.version || entry.digest.slice(0, 8) !== match[3]) {
      throw new PackError("invalid_store", `packs.json names the folder '${entry.folder}' for ${id} ${entry.version}, which does not follow <id>/<version>-<sha8>.`);
    }
    const manifest = await readInstalled(root, entry.folder);
    if (manifest === null) return null; // the active folder is gone: Node shows the pack as not installed too
    if (packDigest(manifest.files) !== entry.digest) throw new PackError("invalid_store", `The digest of ${entry.folder} is not the one in packs.json.`);
    return { id, version: entry.version, digest: entry.digest, folder: entry.folder, path: path.join(root, ...entry.folder.split("/")), active: true, manifest };
  }
  if (!PACK_VERSION_PATTERN.test(options.version)) throw new PackError("invalid_input", `'${options.version}' is not a pack version.`);
  let names: string[];
  try {
    names = await fs.readdir(path.join(root, id));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  for (const name of names.sort()) {
    if (!name.startsWith(`${options.version}-`) || !/^[0-9a-f]{8}$/.test(name.slice(options.version.length + 1))) continue;
    const folder = `${id}/${name}`;
    const manifest = await readInstalled(root, folder);
    if (manifest === null || manifest.version !== options.version) continue;
    const digest = packDigest(manifest.files);
    return { id, version: manifest.version, digest, folder, path: path.join(root, id, name), active: false, manifest };
  }
  return null;
}

/** The absolute folder of the active (or pinned) version of a pack, or null when it is not installed. */
export async function activePackPath(id: string, options: ResolveOptions = {}): Promise<string | null> {
  return (await resolvePack(id, options))?.path ?? null;
}

/** Every pack that packs.json names, resolved. A pack whose active folder is gone is left out. */
export async function listInstalledPacks(root?: string): Promise<ResolvedPack[]> {
  const r = storeRoot(root);
  const index = await readStoreIndex(r);
  const out: ResolvedPack[] = [];
  for (const id of Object.keys(index.packs).sort()) {
    const pack = await resolvePack(id, { root: r });
    if (pack !== null) out.push(pack);
  }
  return out;
}
