import { ensureService, probe, type Endpoint, type Launch, type LauncherOptions } from "@tjalve/memex-node-client";
import { SurfaceError } from "@tjalve/memex-surfaces";
import { memexPaths } from "@tjalve/memex-storage";
import os from "node:os";
import { ContactsClient, UserClient, type HubClient } from "./client.js";
import type { Hub } from "./corrections.js";

export interface EnsureHubOptions extends LauncherOptions {
  /** false: use the hub when it runs, never start it. Default true. */
  start?: boolean;
  /** Gives up on a call when no answer starts in this time. Default 30 s. */
  callTimeoutMs?: number;
}

/**
 * Makes sure that a hub runs and returns its launch (contracts/surfaces.md, Service launcher): it reads the app record,
 * checks the process and GET /health, and when none runs, starts the newest installed copy detached and waits until the
 * record names a process that answers, at most 10 s.
 *
 * Memex.User has POST /v1/drain: when a newer copy is installed than the one that runs, the older copy drains and the
 * newer one takes over at once (ensureService). Memex.Contacts has no drain yet, so a copy of it that runs is used as
 * it is, and a newer installed copy takes over at the next start, after the running copy stops when it is idle.
 */
export async function ensureHubService(hub: Hub, options: EnsureHubOptions = {}): Promise<Launch> {
  const apps = options.apps ?? memexPaths({ app: hub, platform: process.platform, env: options.env ?? process.env, home: os.homedir() }).apps;
  const found = await probe(hub, { apps });
  if (found.state === "running" && (hub !== "user" || options.start === false)) return { app: hub, action: "found", record: found.record, endpoint: found.endpoint };
  if (options.start === false) {
    throw new SurfaceError("unavailable", `Memex ${hub} does not run (${"reason" in found ? found.reason : found.state}), and this client does not start it.`, {
      hint: "Edits wait in the outbox until it runs.",
    });
  }
  return ensureService(hub, { ...options, apps });
}

/** ensureUser: Memex.User runs, and a client for it. The client finds User again when it stopped or moved. */
export async function ensureUser(options: EnsureHubOptions = {}): Promise<UserClient> {
  const launch = await ensureHubService("user", options);
  const reconnect = async (): Promise<Endpoint> => (await ensureHubService("user", options)).endpoint;
  return new UserClient(launch.endpoint, { reconnect, launch, timeoutMs: options.callTimeoutMs });
}

/** ensureContacts: the facts API of Memex.Contacts, started on demand the same way. */
export async function ensureContacts(options: EnsureHubOptions = {}): Promise<ContactsClient> {
  const launch = await ensureHubService("contacts", options);
  const reconnect = async (): Promise<Endpoint> => (await ensureHubService("contacts", options)).endpoint;
  return new ContactsClient(launch.endpoint, { reconnect, launch, timeoutMs: options.callTimeoutMs });
}

/** The client of a hub by its name. */
export function ensureHub(hub: Hub, options: EnsureHubOptions = {}): Promise<HubClient> {
  return hub === "user" ? ensureUser(options) : ensureContacts(options);
}
