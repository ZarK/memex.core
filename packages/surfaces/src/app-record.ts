import fs from "node:fs/promises";
import { request as httpRequest } from "node:http";
import os from "node:os";
import path from "node:path";
import { memexPaths } from "@tjalve/memex-storage";
import { z } from "zod";
import { ORIGIN_HEADER } from "./api-v1.js";
import { SurfaceError, errorFromBody } from "./errors.js";
import { readTokenFile, writePrivateFile } from "./guard.js";

export const APP_RECORD_FORMAT = "memex.app/1";

const running = z
  .object({
    pid: z.number().int().min(1),
    startedAt: z.iso.datetime(),
    url: z.string().regex(/^http:\/\/127\.0\.0\.1:[0-9]{1,5}$/).optional(),
    tokenFile: z.string().min(1).optional(),
    socket: z
      .string()
      .regex(/^(\\\\\.\\pipe\\[^\\/]+|\/.+)$/, "socket is a Windows named pipe (\\\\.\\pipe\\<name>) or an absolute Unix socket path.")
      .optional(),
  })
  .strict()
  .refine((r) => (r.url !== undefined && r.tokenFile !== undefined && r.socket === undefined) || (r.socket !== undefined && r.url === undefined), {
    message: "running needs url and tokenFile, or socket alone.",
  });

/** The app record, memex.app/1 (schemas/surfaces/app.json). */
export const appRecordSchema = z
  .object({
    format: z.literal(APP_RECORD_FORMAT),
    app: z.string().regex(/^[a-z][a-z0-9]*$/),
    name: z.string().min(1),
    kind: z.enum(["app", "service", "tool"]),
    version: z.string().min(1),
    executable: z.string().min(1),
    mcp: z.object({ command: z.string().min(1), args: z.array(z.string()) }).strict().optional(),
    running: running.nullable(),
  })
  .strict();

export type AppRecord = z.infer<typeof appRecordSchema>;
export type RunningInfo = NonNullable<AppRecord["running"]>;

export interface AppsOptions {
  /** The apps folder. Defaults to the apps folder of contracts/storage.md for this user (MEMEX_APPS_DIR overrides it). */
  apps?: string;
}

/** The apps folder of this user: where every installed app writes its record. */
export function appsFolder(options: AppsOptions = {}): string {
  return options.apps ?? memexPaths({ app: "node", platform: process.platform, env: process.env, home: os.homedir() }).apps;
}

/** <apps>/<app>.json */
export function appRecordPath(app: string, options: AppsOptions = {}): string {
  return path.join(appsFolder(options), `${app}.json`);
}

/** Checks a parsed record. Throws a SurfaceError that names the first wrong field. */
export function parseAppRecord(value: unknown): AppRecord {
  const format = (value as { format?: unknown } | null)?.format;
  if (format !== APP_RECORD_FORMAT) {
    throw new SurfaceError("invalid_input", `The app record format is ${JSON.stringify(format)}, not ${APP_RECORD_FORMAT}.`, { field: "format" });
  }
  const result = appRecordSchema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0]!;
    const field = issue.path.join(".");
    throw new SurfaceError("invalid_input", `The app record is not valid: ${field ? `${field}: ` : ""}${issue.message}`, { field });
  }
  return result.data;
}

/** Reads <apps>/<app>.json. null when it is missing: the app is not installed. */
export async function readAppRecord(app: string, options: AppsOptions = {}): Promise<AppRecord | null> {
  let text: string;
  try {
    text = await fs.readFile(appRecordPath(app, options), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const record = parseAppRecord(JSON.parse(text));
  if (record.app !== app) throw new SurfaceError("invalid_input", `The record ${app}.json names the app ${record.app}.`, { field: "app" });
  return record;
}

/**
 * Writes the record whole: a temporary file in the same folder, renamed over the record. Only this OS account can read
 * it: on macOS and Linux the file has mode 0600 and a new apps folder mode 0700; on Windows the temporary file gets an
 * access list with one entry, this account, before any byte is written, so the record does not take the entries of the apps
 * folder (Administrators, or any folder that MEMEX_APPS_DIR names). Memex.Node puts its random pipe name in its record,
 * so the record is as private as the token file. When the access list cannot be set, nothing is written.
 */
export async function writeAppRecord(record: AppRecord, options: AppsOptions = {}): Promise<string> {
  const checked = parseAppRecord(record);
  const file = appRecordPath(checked.app, options);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writePrivateFile(file, JSON.stringify(checked, null, 2) + "\n");
  return file;
}

/** Sets running to null, as an app does when it stops. Does nothing when the record is missing or names another process. */
export async function markStopped(app: string, options: AppsOptions & { pid?: number } = {}): Promise<void> {
  const record = await readAppRecord(app, options);
  if (!record?.running || record.running.pid !== (options.pid ?? process.pid)) return;
  await writeAppRecord({ ...record, running: null }, options);
}

// ---------- readers ----------

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface HttpAnswer {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
}

/** One HTTP request to a local app, with any Host header (fetch cannot set it). */
export function localRequest(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string | Buffer; timeoutMs?: number } = {},
): Promise<HttpAnswer> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: options.method ?? "GET", headers: options.headers, timeout: options.timeoutMs ?? 5000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", reject);
    });
    // ETIMEDOUT: the connection was made but no answer came, so a process listens there and is busy.
    req.on("timeout", () => {
      const connected = req.socket !== undefined && req.socket !== null && !req.socket.connecting;
      req.destroy(Object.assign(new Error(`No answer from ${url}.`), connected ? { code: "ETIMEDOUT" } : {}));
    });
    req.on("error", reject);
    req.end(options.body);
  });
}

export type AppState = "not-installed" | "stopped" | "running";

export interface Discovery {
  app: string;
  state: AppState;
  /** The record, when the app is installed. */
  record: AppRecord | null;
  /** Why a record with running set counts as stopped. */
  stale?: string;
  /**
   * true when the process of the record runs but GET /health did not answer in time. The app may be busy rather than
   * gone, so a caller must not act as if it were stopped, for example by writing its database.
   */
  unresponsive?: boolean;
}

/**
 * Finds an app by the reader rules of contracts/surfaces.md: a missing record is not installed; running null, a gone
 * process, or a /health that fails or names another app is stopped. A socket endpoint (Memex.Node) is checked by pid only.
 */
export async function discover(app: string, options: AppsOptions & { timeoutMs?: number } = {}): Promise<Discovery> {
  const record = await readAppRecord(app, options);
  if (!record) return { app, state: "not-installed", record: null };
  if (!record.running) return { app, state: "stopped", record };
  const stopped = (stale: string): Discovery => ({ app, state: "stopped", record, stale });
  if (!processAlive(record.running.pid)) return stopped(`The process ${record.running.pid} is gone.`);
  if (record.running.url) {
    try {
      const answer = await localRequest(`${record.running.url}/health`, { timeoutMs: options.timeoutMs ?? 2000 });
      const health = JSON.parse(answer.text) as { status?: string; app?: string };
      if (answer.status !== 200 || health.status !== "ok") return stopped(`GET /health answered ${answer.status}.`);
      if (health.app !== app) return stopped(`GET /health names the app ${String(health.app)}.`);
    } catch (error) {
      const found = stopped(`GET /health failed: ${error instanceof Error ? error.message : String(error)}`);
      return (error as NodeJS.ErrnoException).code === "ETIMEDOUT" ? { ...found, unresponsive: true } : found;
    }
  }
  return { app, state: "running", record };
}

/** All app records in the apps folder, each with its state. A record that cannot be read is left out. */
export async function discoverAll(options: AppsOptions & { timeoutMs?: number } = {}): Promise<Discovery[]> {
  let names: string[];
  try {
    names = await fs.readdir(appsFolder(options));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const apps = names.filter((n) => /^[a-z][a-z0-9]*\.json$/.test(n)).map((n) => n.slice(0, -5));
  const found = await Promise.all(apps.map((app) => discover(app, options).catch(() => null)));
  return found.filter((d): d is Discovery => d !== null);
}

export interface CallOptions {
  /**
   * The origin of a call that this process sends on for its own caller: cli for memex-<app> call, agent for
   * memex-<app> mcp. The app takes only these two, and only with its token. Without it the origin is api.
   */
  origin?: "agent" | "cli";
}

export interface AppClient {
  app: string;
  record: AppRecord;
  url: string;
  /** Runs a capability through POST /api/v1/<id>. Throws a SurfaceError with the app's error body. */
  call<T = unknown>(id: string, input?: unknown, options?: CallOptions): Promise<T>;
  /** GET /api/v1. */
  capabilities(): Promise<{ app: string; version: string; capabilities: Array<{ id: string; title: string; kind: string; description: string }> }>;
}

/** Connects to a running app through its record and token file. Throws unavailable when it does not run. */
export async function connect(app: string, options: AppsOptions & { timeoutMs?: number } = {}): Promise<AppClient> {
  const found = await discover(app, options);
  if (found.state !== "running") {
    throw new SurfaceError("unavailable", `${app} ${found.state === "not-installed" ? "is not installed" : "does not run"}.`, {
      hint: found.state === "stopped" ? `Start it with memex-${app} open.` : undefined,
    });
  }
  const record = found.record!;
  const run = record.running!;
  if (!run.url || !run.tokenFile) {
    throw new SurfaceError("unavailable", `${app} has a socket endpoint; use its own client.`);
  }
  const url = run.url;
  const token = await readTokenFile(run.tokenFile);
  const send = async (method: string, route: string, body?: unknown, origin?: CallOptions["origin"]) => {
    const text = body === undefined ? undefined : JSON.stringify(body);
    const answer = await localRequest(`${url}${route}`, {
      method,
      timeoutMs: options.timeoutMs ?? 120_000,
      headers: {
        authorization: `Bearer ${token}`,
        ...(origin ? { [ORIGIN_HEADER]: origin } : {}),
        ...(text !== undefined ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(text)) } : {}),
      },
      body: text,
    });
    let value: unknown = null;
    try {
      if (answer.text) value = JSON.parse(answer.text);
    } catch {
      throw new SurfaceError("internal", `${app} answered ${route} with status ${answer.status} and a body that is not JSON.`);
    }
    if (answer.status < 200 || answer.status >= 300) throw errorFromBody(value, answer.status);
    return value;
  };
  return {
    app,
    record,
    url,
    call: (id, input, callOptions) => send("POST", `/api/v1/${encodeURIComponent(id)}`, input ?? {}, callOptions?.origin) as Promise<never>,
    capabilities: () => send("GET", "/api/v1") as Promise<never>,
  };
}
