import fs from "node:fs/promises";
import os from "node:os";
import { parseArgs } from "node:util";
import {
  AppLockedError,
  currentMemexPaths,
  isAppId,
  syncWarnings,
  type MemexPaths,
} from "@tjalve/memex-storage";
import { appRecordPath, connect, discover, type Discovery } from "./app-record.js";
import { SurfaceError, errorBody, parseInputJson } from "./errors.js";
import { holdAppLock } from "./lock.js";
import { serveMcp, type McpOptions } from "./mcp.js";
import { inputSchema, jsonSchema } from "./openapi.js";
import type { Registry } from "./registry.js";

export interface DoctorCheck {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
}

export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
  stdin(): Promise<string>;
}

export interface CliOptions {
  registry: Registry;
  /** The license of the app, for example MIT. */
  license: string;
  /** The third-party notices, as text. */
  notices?: string;
  /** The app's folders. Defaults to currentMemexPaths(app) for an app id of contracts/storage.md. */
  paths?: MemexPaths;
  /** The apps folder. Defaults to the one of contracts/storage.md. */
  apps?: string;
  /** Starts the app, or shows its window. A headless tool leaves it out, and `open` fails with exit code 2. */
  open?: () => Promise<void>;
  /** More doctor checks, for example the services the app uses. */
  doctor?: () => Promise<DoctorCheck[]>;
  mcp?: Omit<McpOptions, "invoke">;
  io?: CliIo;
}

const defaultIo: CliIo = {
  stdout: (text) => process.stdout.write(text + "\n"),
  stderr: (text) => process.stderr.write(text + "\n"),
  stdin: async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString("utf8");
  },
};

class UsageError extends Error {}

function usage(app: string): string {
  return `Usage:
  memex-${app} mcp                            Start the stdio MCP server.
  memex-${app} call <id> [<json> | -] [--json]  Run a capability; - reads the input from standard input.
  memex-${app} capabilities [--json]          List the capabilities; --json includes the schemas.
  memex-${app} about [--json]                 Name, version, license, notices, and the data folder.
  memex-${app} open                           Start the app, or show its window.
  memex-${app} doctor [--json]                Check the folders, sync warnings, app record, token file, and services.

Exit codes: 0 success, 1 failure, 2 usage error.`;
}

const POSITIONALS: Record<string, [number, number]> = {
  mcp: [0, 0],
  call: [1, 2],
  capabilities: [0, 0],
  about: [0, 0],
  open: [0, 0],
  doctor: [0, 0],
};

/** How long a call waits for GET /health of an app whose process runs but did not answer in the first two seconds. */
const BUSY_HEALTH_MS = 15_000;

/**
 * Runs a capability where it belongs: through the running app when its record says it runs, else in this process
 * under the app lock of the storage library, so that two processes never write one database. Calls in one process
 * share the lock. When the app's process runs but does not answer GET /health, the call fails with unavailable: the
 * app may be busy, and a local call would write its database beside it.
 */
export async function invokeAnywhere(options: CliOptions, id: string, input: unknown, origin: "agent" | "cli"): Promise<unknown> {
  const { registry } = options;
  const apps = { apps: options.apps };
  let found: Discovery | undefined;
  try {
    found = await discover(registry.app, apps);
    if (found.unresponsive) found = await discover(registry.app, { ...apps, timeoutMs: BUSY_HEALTH_MS });
  } catch {
    // A record that cannot be read does not stop a local call.
  }
  if (found?.state === "running") return (await connect(registry.app, apps)).call(id, input, { origin });
  if (found?.unresponsive) {
    throw new SurfaceError("unavailable", `${registry.name} runs (process ${found.record!.running!.pid}) but does not answer.`, {
      hint: "It may be busy. Try again later.",
    });
  }
  const paths = appPaths(options);
  if (!paths) return registry.invoke(id, input, { origin });
  let release;
  try {
    release = await holdAppLock({ app: registry.app, data: paths.data, state: paths.state });
  } catch (error) {
    if (error instanceof AppLockedError) throw new SurfaceError("unavailable", error.message);
    throw error;
  }
  try {
    return await registry.invoke(id, input, { origin });
  } finally {
    await release();
  }
}

function appPaths(options: CliOptions): MemexPaths | undefined {
  if (options.paths) return options.paths;
  return isAppId(options.registry.app) ? currentMemexPaths(options.registry.app) : undefined;
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function doctor(options: CliOptions): Promise<DoctorCheck[]> {
  const { registry } = options;
  const checks: DoctorCheck[] = [];
  const paths = appPaths(options);
  if (paths) {
    for (const key of ["data", "state", "cache", "logs"] as const) {
      const found = await exists(paths[key]);
      checks.push({ name: `folder ${key}`, status: found ? "ok" : key === "data" ? "warn" : "ok", detail: `${paths[key]}${found ? "" : " (not made yet)"}` });
    }
    const warnings = syncWarnings(paths, { platform: process.platform, env: process.env, home: os.homedir() });
    if (warnings.length === 0) checks.push({ name: "sync", status: "ok", detail: "No folder is in a folder that a sync client covers." });
    for (const w of warnings) checks.push({ name: "sync", status: "warn", detail: `The ${w.key} folder ${w.path} is in a folder that ${w.client} synchronizes.` });
  } else {
    checks.push({ name: "folders", status: "warn", detail: `${registry.app} is not an app id of contracts/storage.md.` });
  }

  const file = appRecordPath(registry.app, { apps: options.apps });
  try {
    const found = await discover(registry.app, { apps: options.apps });
    if (found.state === "not-installed") {
      checks.push({ name: "app record", status: "warn", detail: `${file} is missing: the app is not installed.` });
    } else {
      const record = found.record!;
      checks.push({
        name: "app record",
        status: found.stale ? "warn" : "ok",
        detail: `${file}: ${found.state}${found.stale ? `. The record is stale: ${found.stale}` : ""}`,
      });
      if (record.version !== registry.version) {
        checks.push({ name: "version", status: "warn", detail: `The record is from version ${record.version}; this is ${registry.version}.` });
      }
      if (found.state === "running" && record.running?.tokenFile) {
        const tokenFile = record.running.tokenFile;
        if (!(await exists(tokenFile))) checks.push({ name: "token file", status: "fail", detail: `${tokenFile} is missing.` });
        else {
          try {
            await connect(registry.app, { apps: options.apps, timeoutMs: 5000 }).then((c) => c.capabilities());
            checks.push({ name: "token file", status: "ok", detail: `${tokenFile} opens /api/v1.` });
          } catch (error) {
            checks.push({ name: "token file", status: "fail", detail: `${tokenFile} does not open /api/v1: ${(error as Error).message}` });
          }
        }
      }
    }
  } catch (error) {
    checks.push({ name: "app record", status: "fail", detail: `${file}: ${(error as Error).message}` });
  }
  if (options.doctor) checks.push(...(await options.doctor()));
  return checks;
}

/** Runs the memex-<app> CLI. Returns the exit code: 0 success, 1 failure, 2 usage error. */
export async function runCli(argv: string[], options: CliOptions): Promise<number> {
  const io = options.io ?? defaultIo;
  const { registry } = options;
  let json = false;
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { json: { type: "boolean" }, help: { type: "boolean", short: "h" } },
    });
    json = values.json === true;
    const [command, ...rest] = positionals;
    if (values.help || command === "help") {
      io.stdout(usage(registry.app));
      return 0;
    }
    if (command === undefined) throw new UsageError("Name a command.");
    const counts = POSITIONALS[command];
    if (!counts) throw new UsageError(`There is no command ${command}.`);
    if (rest.length < counts[0] || rest.length > counts[1]) throw new UsageError(`Wrong arguments for ${command}.`);

    switch (command) {
      case "mcp":
        await serveMcp(registry, { ...options.mcp, invoke: (id, input) => invokeAnywhere(options, id, input, "agent") });
        return 0;
      case "call": {
        const [id, raw] = rest as [string, string | undefined];
        const text = raw === "-" ? await io.stdin() : raw;
        const input: unknown = text === undefined || text.trim() === "" ? {} : parseInputJson(text);
        const output = await invokeAnywhere(options, id, input, "cli");
        io.stdout(JSON.stringify(output ?? null, null, 2));
        return 0;
      }
      case "capabilities": {
        if (json) {
          io.stdout(
            JSON.stringify(
              registry.capabilities.map((c) => ({
                id: c.id,
                title: c.title,
                kind: c.kind,
                description: c.description,
                mcp: c.mcp !== false,
                input: inputSchema(c),
                ...(c.output ? { output: jsonSchema(c.output, "output") } : {}),
              })),
              null,
              2,
            ),
          );
        } else {
          const width = Math.max(0, ...registry.capabilities.map((c) => c.id.length));
          for (const c of registry.capabilities) io.stdout(`${c.id.padEnd(width)}  ${c.kind.padEnd(5)}  ${c.title}`);
        }
        return 0;
      }
      case "about": {
        const about = {
          name: registry.name,
          app: registry.app,
          version: registry.version,
          license: options.license,
          data: appPaths(options)?.data ?? null,
          notices: options.notices ?? "",
        };
        if (json) io.stdout(JSON.stringify(about, null, 2));
        else {
          io.stdout(`${about.name} ${about.version} (${about.app})`);
          io.stdout(`License: ${about.license}`);
          if (about.data) io.stdout(`Data folder: ${about.data}`);
          if (about.notices) io.stdout(`\nThird-party notices:\n${about.notices}`);
        }
        return 0;
      }
      case "open":
        if (!options.open) {
          io.stderr(`${registry.name} has no UI. Use memex-${registry.app} call, the HTTP API, or MCP.`);
          return 2;
        }
        await options.open();
        return 0;
      case "doctor": {
        const checks = await doctor(options);
        if (json) io.stdout(JSON.stringify({ checks }, null, 2));
        else for (const c of checks) io.stdout(`${c.status.padEnd(4)}  ${c.name}: ${c.detail}`);
        return checks.some((c) => c.status === "fail") ? 1 : 0;
      }
    }
    return 2;
  } catch (error) {
    if (error instanceof UsageError || (error as { code?: string }).code?.startsWith?.("ERR_PARSE_ARGS")) {
      io.stderr(`${(error as Error).message}\n\n${usage(registry.app)}`);
      return 2;
    }
    const { body } = errorBody(error);
    if (json) io.stdout(JSON.stringify(body, null, 2));
    else io.stderr(body.error.message + (body.error.hint ? ` ${body.error.hint}` : ""));
    return 1;
  }
}
