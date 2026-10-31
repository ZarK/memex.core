import fs from "node:fs/promises";
import path from "node:path";
import { APP_FOLDERS, appHomeVariable, isAppId, type DataSource } from "./paths.js";
import { writeFileWhole } from "./write.js";

export type DataFolderErrorCode = "missing" | "not-a-folder";

export class DataFolderError extends Error {
  readonly code: DataFolderErrorCode;
  readonly path: string;
  constructor(code: DataFolderErrorCode, folder: string, message: string) {
    super(message);
    this.name = "DataFolderError";
    this.code = code;
    this.path = folder;
  }
}

export interface OpenDataFolderOptions {
  app: string;
  /** memexPaths().data. */
  data: string;
  /** dataSource() for the same input. */
  source: DataSource;
  /** memexPaths().state: where the app records the data folders it has used on this computer. */
  state: string;
}

const SEEN_FILE = "data-folders.json";

function key(folder: string): string {
  const resolved = path.resolve(folder);
  return process.platform === "win32" || process.platform === "darwin" ? resolved.toLowerCase() : resolved;
}

async function seenFolders(state: string): Promise<string[]> {
  try {
    const value = JSON.parse(await fs.readFile(path.join(state, SEEN_FILE), "utf8")) as { folders?: unknown };
    return Array.isArray(value.folders) ? value.folders.filter((f): f is string => typeof f === "string") : [];
  } catch {
    return [];
  }
}

async function recordSeen(state: string, folder: string, seen: string[]): Promise<void> {
  if (seen.some((f) => key(f) === key(folder))) return;
  const folders = [...seen, path.resolve(folder)];
  await writeFileWhole(path.join(state, SEEN_FILE), JSON.stringify({ format: "memex.data-folders/1", folders }, null, 2) + "\n");
}

function chosenBy(app: string, source: DataSource): string {
  switch (source) {
    case "flag":
      return "a command-line option";
    case "variable":
      return isAppId(app) ? `the ${appHomeVariable(app)} variable` : "a variable";
    case "memex-home":
      return "the MEMEX_HOME variable";
    case "locations":
      return "you, in the app's settings (locations.json)";
    case "default":
      return "default";
  }
}

/**
 * Opens the data folder of an app at start-up. A missing data folder stops the app with DataFolderError "missing",
 * instead of making an empty one: the drive may be disconnected or the folder moved, and an empty folder would
 * split the user's data. The app makes the folder only on the first run with the default folder or MEMEX_HOME,
 * when this computer has not used that folder before. Returns whether it made the folder.
 */
export async function openDataFolder(options: OpenDataFolderOptions): Promise<{ created: boolean }> {
  const { app, data, source, state } = options;
  const name = isAppId(app) ? APP_FOLDERS[app] : app;
  const seen = await seenFolders(state);
  try {
    const stat = await fs.stat(data);
    if (!stat.isDirectory()) {
      throw new DataFolderError("not-a-folder", data, `The ${name} data folder ${data} is a file, not a folder. Move the file, or choose another folder.`);
    }
    await recordSeen(state, data, seen);
    return { created: false };
  } catch (error) {
    if (error instanceof DataFolderError || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const usedBefore = seen.some((f) => key(f) === key(data));
  const mayCreate = (source === "default" || source === "memex-home") && !usedBefore;
  if (!mayCreate) {
    const why = usedBefore
      ? `${name} used this folder before on this computer.`
      : `The folder was chosen by ${chosenBy(app, source)}.`;
    throw new DataFolderError(
      "missing",
      data,
      `The ${name} data folder ${data} is missing. ${why} If it is on a drive that is not connected, connect the drive ` +
        `and start ${name} again. If you moved the folder, choose its new place. ${name} does not make an empty folder ` +
        `in its place, so that your data does not split in two.`,
    );
  }
  await fs.mkdir(data, { recursive: true });
  await recordSeen(state, data, seen);
  return { created: true };
}
