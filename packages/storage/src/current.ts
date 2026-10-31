import os from "node:os";
import { readLocationsSync } from "./locations.js";
import { dataSource, locationsFilePath, memexPaths, nonEmpty, packsSource, type AppId, type DataSource, type MemexPathsInput, type MemexPaths, type PacksSource } from "./paths.js";

function currentInput(app: AppId, flag: string | undefined): MemexPathsInput {
  const context = { platform: process.platform, env: process.env, home: os.homedir() };
  const locations = nonEmpty(process.env.MEMEX_HOME) === undefined ? readLocationsSync(locationsFilePath(context)) : undefined;
  return { app, ...context, flag, locations };
}

/** memexPaths() for the running process. Reads locations.json unless MEMEX_HOME is set. */
export function currentMemexPaths(app: AppId, options: { flag?: string } = {}): MemexPaths {
  return memexPaths(currentInput(app, options.flag));
}

/** dataSource() for the running process, with the same inputs as currentMemexPaths(). */
export function currentDataSource(app: AppId, options: { flag?: string } = {}): DataSource {
  return dataSource(currentInput(app, options.flag));
}

/** packsSource() for the running process, with the same inputs as currentMemexPaths(). */
export function currentPacksSource(app: AppId = "node"): PacksSource {
  return packsSource(currentInput(app, undefined));
}
