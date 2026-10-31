import path from "node:path";
import { isFile, readJson } from "./files.js";

export const CONFIG_FORMAT = "memex.licenses/1";
export const CONFIG_FILE = "memex-licenses.json";

export interface AllowEntry {
  /** `name`, `name@version`, or `<ecosystem>:name[@version]`. */
  match: string;
  /** The license expression the entry allows. A changed license needs a new entry. */
  license: string;
  /** The rules the entry silences: copyleft, custom-license, limits (weak-copyleft is a note). Default: copyleft. */
  rules?: string[];
  reason: string;
}

export interface Config {
  format?: string;
  product?: string;
  /** pnpm importers to read (default: every importer), and whether dev dependencies ship (default: no). */
  pnpm?: { importers?: string[]; dev?: boolean } | false;
  /** Vite build folders. */
  vite?: string[];
  /** project.assets.json files or project folders. */
  dotnet?: string[] | false;
  electron?: { dist?: string; zip?: string } | false;
  /** Extra folders with font files. */
  fonts?: string[];
  /** Folders whose subfolders are copied libraries, each with its license file. */
  vendor?: string[];
  /** third-party.json files. */
  thirdParty?: string[];
  /** memex.pack/1 manifests or folders of them. */
  packs?: string[];
  /** Folders (relative to the root) that the repository walk skips. */
  ignore?: string[];
  allow?: AllowEntry[];
  /** Why the product has no third-party components, for a repository whose check reads none (without it, that check fails). */
  noDependencies?: string;
}

export class ConfigError extends Error {}

/** The rules an allow entry may name. The check itself allows only copyleft, custom-license and limits. */
const ALLOW_RULES = ["copyleft", "weak-copyleft", "custom-license", "limits"];

function strings(v: unknown, field: string): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new ConfigError(`${field} must be a list of strings`);
  return v as string[];
}

/** Reads the config from --config, else memex-licenses.json in the root, else an empty config. */
export function loadConfig(root: string, file?: string): { config: Config; file: string | null } {
  const target = file !== undefined ? path.resolve(file) : path.join(root, CONFIG_FILE);
  if (!isFile(target)) {
    if (file !== undefined) throw new ConfigError(`config not found: ${target}`);
    return { config: {}, file: null };
  }
  let raw: unknown;
  try {
    raw = readJson(target);
  } catch (error) {
    throw new ConfigError(`${target}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const c = raw as Config;
  if (c.format !== undefined && c.format !== CONFIG_FORMAT) throw new ConfigError(`${target}: format must be ${CONFIG_FORMAT}`);
  for (const k of ["vite", "fonts", "vendor", "thirdParty", "packs", "ignore"] as const) strings(c[k], k);
  if (c.dotnet !== undefined && c.dotnet !== false) strings(c.dotnet, "dotnet");
  if (c.pnpm !== undefined && c.pnpm !== false) strings(c.pnpm.importers, "pnpm.importers");
  if (c.noDependencies !== undefined && (typeof c.noDependencies !== "string" || c.noDependencies.trim() === "")) {
    throw new ConfigError(`${target}: noDependencies must be a reason`);
  }
  for (const [i, a] of (c.allow ?? []).entries()) {
    if (typeof a?.match !== "string" || typeof a.license !== "string") throw new ConfigError(`allow[${i}]: match and license are required`);
    if (typeof a.reason !== "string" || a.reason.trim() === "") throw new ConfigError(`allow[${i}] (${a.match}): reason is required`);
    for (const r of strings(a.rules, `allow[${i}].rules`) ?? []) {
      if (!ALLOW_RULES.includes(r)) {
        throw new ConfigError(`allow[${i}] (${a.match}): rule ${r} cannot be allowed; an allow entry takes only ${ALLOW_RULES.join(", ")}`);
      }
    }
  }
  return { config: c, file: target };
}
