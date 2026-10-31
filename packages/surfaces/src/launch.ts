import path from "node:path";
import type { AppLock } from "@tjalve/memex-storage";
import { markStopped, writeAppRecord, type AppRecord, type AppsOptions } from "./app-record.js";
import { writeTokenFile } from "./guard.js";
import { holdAppLock } from "./lock.js";
import type { Registry } from "./registry.js";
import { startServer, type SurfaceServer, type UiHandler } from "./server.js";

export interface ServeAppOptions extends AppsOptions {
  registry: Registry;
  kind: AppRecord["kind"];
  /** The program that starts this app, for the service launcher. Defaults to process.execPath. */
  executable?: string;
  /** The command that starts the stdio MCP server. Defaults to memex-<app> mcp. */
  mcp?: AppRecord["mcp"];
  /** The app's data folder (memexPaths().data). The app lock is for this folder. */
  data: string;
  /** The app's state folder (memexPaths().state). The token file is <state>/token, and the app lock is in <state>/locks. */
  state: string;
  /**
   * The app lock, when the app took it itself at its start (acquireAppLock of @tjalve/memex-storage). Without it,
   * serveApp takes the lock before it listens and releases it in stop(). Either way the app holds the lock while it
   * serves, so that memex-<app> call never writes its database from a second process.
   */
  lock?: AppLock;
  ui?: UiHandler;
}

export interface RunningApp {
  server: SurfaceServer;
  record: AppRecord;
  tokenFile: string;
  /** Sets running to null in the record, closes the server, then releases the app lock that serveApp took. */
  stop(): Promise<void>;
}

/**
 * Takes the app lock (unless the app passes the one it holds), then starts the HTTP surface and announces it: writes
 * the token file first, then the app record when the listener is ready (contracts/surfaces.md, App record, writer
 * rules). Throws AppLockedError when another process holds the lock.
 */
export async function serveApp(options: ServeAppOptions): Promise<RunningApp> {
  const { registry } = options;
  const release = options.lock ? async () => {} : await holdAppLock({ app: registry.app, data: options.data, state: options.state });
  let server: SurfaceServer;
  try {
    server = await startServer({ registry, ui: options.ui });
  } catch (error) {
    await release();
    throw error;
  }
  const tokenFile = path.join(options.state, "token");
  try {
    await writeTokenFile(tokenFile, server.token);
    const record: AppRecord = {
      format: "memex.app/1",
      app: registry.app,
      name: registry.name,
      kind: options.kind,
      version: registry.version,
      executable: options.executable ?? process.execPath,
      mcp: options.mcp ?? { command: `memex-${registry.app}`, args: ["mcp"] },
      running: { pid: process.pid, startedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), url: server.url, tokenFile },
    };
    await writeAppRecord(record, options);
    let stopped = false;
    return {
      server,
      record,
      tokenFile,
      async stop() {
        if (stopped) return;
        stopped = true;
        try {
          await markStopped(registry.app, options);
        } finally {
          try {
            await server.close();
          } finally {
            await release();
          }
        }
      },
    };
  } catch (error) {
    try {
      await server.close();
    } finally {
      await release();
    }
    throw error;
  }
}
