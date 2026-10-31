import { NodeClient, type NodeClientOptions } from "./client.js";
import { ensureService, type Launch, type LauncherOptions } from "./launcher.js";

export interface EnsureNodeOptions extends LauncherOptions {
  /** Gives up on a call when no answer starts in this time. Default 60 s. */
  callTimeoutMs?: number;
}

/**
 * Makes sure that Memex.Node runs, and returns a client for it (contracts/surfaces.md, Service launcher): it reads the
 * app record node.json, checks the process and GET /health over the pipe or socket that the record names, starts the
 * newest installed copy when none runs, and lets a newer copy take over while the older one drains. It waits at most
 * 10 s for a start. The client finds Node again in the same way when a connection fails or Node drains.
 */
export async function ensureNode(options: EnsureNodeOptions = {}): Promise<NodeClient> {
  const launch: Launch = await ensureService("node", options);
  const reconnect: NodeClientOptions["reconnect"] = async () => (await ensureService("node", options)).endpoint;
  return new NodeClient(launch.endpoint, { reconnect, timeoutMs: options.callTimeoutMs, launch });
}
