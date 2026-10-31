import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import { MemexPathsError, isAbsolute, isAppId, pathApi, type AppId, type AppLocations, type LocationsFile } from "./paths.js";
import { writeFileWhole } from "./write.js";

export const LOCATIONS_FORMAT = "memex.locations/1";

export function emptyLocations(): LocationsFile {
  return { format: LOCATIONS_FORMAT, apps: {} };
}

/**
 * Checks a parsed locations.json and returns it. Unknown app ids and unknown keys are kept, so that an older
 * app does not drop what a newer one wrote. Throws MemexPathsError "invalid-locations" for a wrong shape.
 */
export function parseLocations(value: unknown, file = "locations.json"): LocationsFile {
  const invalid = (why: string) => new MemexPathsError("invalid-locations", `${file} is not valid: ${why}`);
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid("it is not a JSON object");
  const v = value as Record<string, unknown>;
  if (v.format !== LOCATIONS_FORMAT) throw invalid(`format must be "${LOCATIONS_FORMAT}"`);
  const apps = v.apps ?? {};
  if (typeof apps !== "object" || apps === null || Array.isArray(apps)) throw invalid("apps must be an object");
  for (const [app, entry] of Object.entries(apps)) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw invalid(`apps.${app} must be an object`);
    for (const key of ["data", "cache"] as const) {
      const folder = (entry as Record<string, unknown>)[key];
      if (folder !== undefined && typeof folder !== "string") throw invalid(`apps.${app}.${key} must be a string`);
    }
  }
  if (v.packs !== undefined && typeof v.packs !== "string") throw invalid("packs must be a string");
  return { ...v, format: LOCATIONS_FORMAT, apps: apps as LocationsFile["apps"] };
}

/** Reads locations.json. A missing file is an empty one. Throws MemexPathsError "invalid-locations". */
export async function readLocations(file: string): Promise<LocationsFile> {
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyLocations();
    throw error;
  }
  return parseText(text, file);
}

/** readLocations() for start-up code that cannot wait. */
export function readLocationsSync(file: string): LocationsFile {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyLocations();
    throw error;
  }
  return parseText(text, file);
}

function parseText(text: string, file: string): LocationsFile {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new MemexPathsError("invalid-locations", `${file} is not valid: it is not JSON`);
  }
  return parseLocations(value, file);
}

/** Writes locations.json whole. */
export async function writeLocations(file: string, locations: LocationsFile): Promise<void> {
  await writeFileWhole(file, JSON.stringify(parseLocations(locations, file), null, 2) + "\n");
}

/**
 * Sets or clears the folders the user chose for one app, and keeps everything else in the file. A value of null
 * clears that folder, so the app goes back to the default. Returns the new file.
 */
export async function setAppLocations(
  file: string,
  app: AppId,
  change: { [K in keyof AppLocations]?: string | null },
  options: { platform?: string } = {},
): Promise<LocationsFile> {
  if (!isAppId(app)) throw new MemexPathsError("unknown-app", `Unknown Memex app id: ${app}`);
  const p = pathApi(options.platform ?? process.platform);
  for (const [key, value] of Object.entries(change)) {
    if (typeof value === "string" && !isAbsolute(p, value)) {
      throw new MemexPathsError("relative-path", `The ${key} folder must be an absolute path: ${value}`);
    }
  }
  const current = await readLocations(file);
  const entry: Record<string, unknown> = { ...(current.apps[app] ?? {}) };
  for (const [key, value] of Object.entries(change)) {
    if (value === null) delete entry[key];
    else if (value !== undefined) entry[key] = value;
  }
  const apps = { ...current.apps };
  if (Object.keys(entry).length === 0) delete apps[app];
  else apps[app] = entry as AppLocations;
  const next: LocationsFile = { ...current, apps };
  await writeLocations(file, next);
  return next;
}
