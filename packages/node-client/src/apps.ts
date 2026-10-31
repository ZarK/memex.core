import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { SurfaceError, appsFolder, errorFromBody, readAppRecord, toolName, type AppRecord } from "@tjalve/memex-surfaces";

export interface EnsureAppOptions {
  /** The apps folder. Default: the apps folder of contracts/storage.md, or MEMEX_APPS_DIR. */
  apps?: string;
  /** The command that starts the MCP server, when the app record has none (or there is no record). */
  command?: { command: string; args: string[] };
  /** The environment of the MCP server. Default process.env, so it uses the same Memex folders as the caller. */
  env?: NodeJS.ProcessEnv;
  /** How long to wait for the server to start and answer initialize. Default 10 s. */
  timeoutMs?: number;
  /** Where the server's standard error goes. Default ignore. */
  stderr?: "ignore" | "inherit" | "pipe";
  /** The name of the calling app, sent in initialize. Default memex-node-client. */
  clientName?: string;
}

/** A headless Memex tool reached over its stdio MCP server. */
export interface AppConnection {
  app: string;
  /** The app record, when the tool has one. */
  record: AppRecord | null;
  /** The command that runs the MCP server. */
  command: { command: string; args: string[] };
  /** The process of the MCP server. */
  pid: number | null;
  client: Client;
  /** The tools of the server (tools/list, every page). */
  listTools(): Promise<Tool[]>;
  /** Calls one tool by its MCP name, for example contacts_people_list. */
  callTool(name: string, args?: Record<string, unknown>): Promise<CallToolResult>;
  /**
   * Runs a capability by its id (contacts.people.list) and returns its output. A tool error throws a SurfaceError with
   * the app's error body.
   */
  call<T = unknown>(id: string, input?: Record<string, unknown>): Promise<T>;
  /** Ends the MCP server. */
  close(): Promise<void>;
}

const open = new Map<string, Promise<AppConnection>>();

/**
 * Starts a headless Memex tool (Contacts, Conversations, Calendar) on demand over its stdio MCP server, so an app reaches
 * it without a server that the user starts (contracts/surfaces.md, Service launcher). The command comes from the app
 * record (mcp), else from options.command. A second call in the same process returns the same connection while it is
 * open. The server takes the app lock or sends calls to the running app itself, as memex-<app> mcp does.
 */
export function ensureApp(app: string, options: EnsureAppOptions = {}): Promise<AppConnection> {
  const key = `${path.resolve(options.apps ?? appsFolder())}\n${app}`;
  const existing = open.get(key);
  if (existing) return existing;
  const created = connectApp(app, options, () => {
    if (open.get(key) === created) open.delete(key);
  });
  open.set(key, created);
  created.catch(() => {
    if (open.get(key) === created) open.delete(key);
  });
  return created;
}

async function connectApp(app: string, options: EnsureAppOptions, forget: () => void): Promise<AppConnection> {
  const record = await readAppRecord(app, { apps: options.apps });
  if (record && record.kind === "service") {
    throw new SurfaceError("invalid_input", `${app} is a service; use its own client.`, { field: "app" });
  }
  const command = options.command ?? record?.mcp;
  if (!command) {
    throw new SurfaceError("unavailable", record ? `The app record of ${app} names no MCP command.` : `${app} is not installed: it has no app record.`, {
      hint: record ? undefined : `Install Memex ${app[0]!.toUpperCase()}${app.slice(1)}, or pass the command.`,
    });
  }
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(options.env ?? process.env)) if (v !== undefined) env[k] = v;
  const transport = new StdioClientTransport({ command: command.command, args: command.args, env, stderr: options.stderr ?? "ignore" });
  const client = new Client({ name: options.clientName ?? "memex-node-client", version: "0.1.0" });
  const timeoutMs = options.timeoutMs ?? 10_000;
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      client.connect(transport),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new SurfaceError("unavailable", `memex-${app} mcp did not answer within ${timeoutMs} ms.`)), timeoutMs);
      }),
    ]);
  } catch (error) {
    await transport.close().catch(() => {});
    if (error instanceof SurfaceError) throw error;
    throw new SurfaceError("unavailable", `memex-${app} mcp could not start (${command.command}): ${(error as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
  let closed = false;
  // client.onclose, not transport.onclose: connect() set transport.onclose to the SDK's handler, which fails the
  // pending requests at once when the server stops.
  client.onclose = () => {
    closed = true;
    forget();
  };
  const connection: AppConnection = {
    app,
    record,
    command,
    pid: transport.pid,
    client,
    async listTools() {
      const tools: Tool[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined);
        tools.push(...page.tools);
        cursor = page.nextCursor;
      } while (cursor);
      return tools;
    },
    async callTool(name, args = {}) {
      return (await client.callTool({ name, arguments: args })) as CallToolResult;
    },
    async call<T>(id: string, input: Record<string, unknown> = {}) {
      const result = (await client.callTool({ name: toolName(id), arguments: input })) as CallToolResult;
      const text = result.content.find((c) => c.type === "text")?.text ?? "null";
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        value = text;
      }
      if (result.isError) throw errorFromBody(value, 422);
      return value as T;
    },
    async close() {
      if (closed) return;
      closed = true;
      forget();
      await client.close();
    },
  };
  return connection;
}
