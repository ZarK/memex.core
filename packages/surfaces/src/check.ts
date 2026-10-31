import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { checkAccountOnly } from "./account-acl.js";
import { appRecordPath, discover, localRequest, parseAppRecord, type AppRecord, type HttpAnswer } from "./app-record.js";
import { readTokenFile } from "./guard.js";
import { isCapabilityId } from "./registry.js";

export type CheckStatus = "pass" | "fail" | "warn" | "skip";

export interface CheckResult {
  /** A stable id, for example http.host. */
  id: string;
  status: CheckStatus;
  message: string;
}

export interface CheckOptions {
  /** The apps folder. Defaults to the one of contracts/storage.md. */
  apps?: string;
  /** How long one request or command may take. Defaults to 10 seconds. */
  timeoutMs?: number;
  /** Leave out the MCP and CLI checks, which start the app's command. */
  skipCommands?: boolean;
}

interface Listed {
  app?: string;
  version?: string;
  capabilities?: Array<{ id: string; title: string; kind: string; description: string }>;
  openapi?: string;
}

function isErrorBody(value: unknown, code?: string): boolean {
  const error = (value as { error?: { code?: unknown; message?: unknown } } | null)?.error;
  return (
    typeof error?.code === "string" &&
    /^[a-z][a-z0-9_]*$/.test(error.code) &&
    typeof error.message === "string" &&
    error.message.length > 0 &&
    (code === undefined || error.code === code)
  );
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Checks an installed app against contracts/surfaces.md: the app record; when the app runs, /health, the request
 * checks, /api/v1, and OpenAPI; and the stdio MCP server and the CLI through the record's mcp command.
 */
export async function checkApp(app: string, options: CheckOptions = {}): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const add = (id: string, status: CheckStatus, message: string) => results.push({ id, status, message });
  const expect = (id: string, ok: boolean, pass: string, fail: string) => add(id, ok ? "pass" : "fail", ok ? pass : fail);
  const timeoutMs = options.timeoutMs ?? 10_000;

  // ---------- the app record ----------
  const file = appRecordPath(app, options);
  let record: AppRecord;
  try {
    const text = await fs.readFile(file, "utf8");
    record = parseAppRecord(JSON.parse(text));
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    add("record", "fail", missing ? `${file} is missing: the app is not installed.` : `${file}: ${(error as Error).message}`);
    return results;
  }
  expect("record", true, `${file} is a valid memex.app/1 record.`, "");
  if (process.platform !== "win32") {
    const mode = (await fs.stat(file)).mode & 0o777;
    expect("record.mode", mode === 0o600, "The app record has mode 0600.", `The app record has mode ${mode.toString(8)}, not 600: other accounts can read it.`);
  } else {
    await checkAcl("record.acl", "The app record", file, add);
  }
  expect("record.name", record.app === app, `The record names the app ${app}.`, `The file ${app}.json names the app ${record.app}.`);
  expect("record.executable", path.isAbsolute(record.executable), "executable is an absolute path.", `executable is not absolute: ${record.executable}`);
  if (record.kind !== "service") {
    expect("record.mcp", record.mcp !== undefined, `mcp starts the stdio MCP server: ${record.mcp?.command} ${record.mcp?.args.join(" ")}`, "The record has no mcp command.");
  }

  // ---------- HTTP ----------
  let listed: Listed | undefined;
  const found = await discover(app, { ...options, timeoutMs });
  const run = record.running;
  if (!run) add("http", "skip", "The app is stopped (running is null). Start it to check the HTTP API.");
  else if (found.state !== "running") add("http", "fail", `The record says the app runs, but it is stale: ${found.stale}`);
  else if (!run.url || !run.tokenFile) add("http", "skip", "The app has a socket endpoint; its own contract applies.");
  else listed = await checkHttp(app, record, run.url, run.tokenFile, { add, expect, timeoutMs });

  // ---------- MCP and CLI ----------
  if (options.skipCommands) add("mcp", "skip", "Commands were not run (skipCommands).");
  else if (record.mcp) {
    await checkMcp(app, record.mcp, listed, { add, expect, timeoutMs });
    if (path.basename(record.mcp.command).replace(/\.(cmd|exe)$/i, "") === `memex-${app}`) {
      await checkCli(app, record.mcp.command, { add, expect, timeoutMs });
    } else add("cli", "skip", `The mcp command is not memex-${app}; the CLI was not checked.`);
  }
  return results;
}

/** On Windows: only this account (and the system account) may open the file, and it takes no entries from its folder. */
async function checkAcl(id: string, what: string, file: string, add: (id: string, status: CheckStatus, message: string) => void): Promise<void> {
  try {
    const acl = await checkAccountOnly(file);
    if (acl.ok) add(id, "pass", `Only this account can read ${what.toLowerCase()}.`);
    else {
      const why = [acl.inherits ? "it takes entries from its folder" : "", acl.others.length ? `it allows ${acl.others.join(", ")}` : ""].filter(Boolean).join(", and ");
      add(id, "fail", `${what} can be read by other accounts: ${why}.`);
    }
  } catch (error) {
    add(id, "fail", `The access list of ${file} cannot be read: ${(error as Error).message}`);
  }
}

interface Reporter {
  add(id: string, status: CheckStatus, message: string): void;
  expect(id: string, ok: boolean, pass: string, fail: string): void;
  timeoutMs: number;
}

async function checkHttp(app: string, record: AppRecord, url: string, tokenFile: string, r: Reporter): Promise<Listed | undefined> {
  const { add, expect, timeoutMs } = r;
  const host = new URL(url).host;
  const get = (route: string, headers: Record<string, string> = {}) => localRequest(`${url}${route}`, { headers, timeoutMs });
  let token: string;
  try {
    token = await readTokenFile(tokenFile);
  } catch (error) {
    add("token.file", "fail", `The token file cannot be read: ${(error as Error).message}`);
    return undefined;
  }
  expect("token.format", /^[A-Za-z0-9_-]{43}$/.test(token), "The token is 32 bytes in base64url.", "The token is not 32 random bytes in base64url without padding.");
  if (process.platform !== "win32") {
    const mode = (await fs.stat(tokenFile)).mode & 0o777;
    expect("token.mode", mode === 0o600, "The token file has mode 0600.", `The token file has mode ${mode.toString(8)}, not 600.`);
  } else {
    await checkAcl("token.acl", "The token file", tokenFile, add);
  }
  const auth = { authorization: `Bearer ${token}` };
  const noCors = (answers: HttpAnswer[]) => answers.every((a) => a.headers["access-control-allow-origin"] === undefined);
  const answers: HttpAnswer[] = [];
  const keep = (a: HttpAnswer) => (answers.push(a), a);

  const health = keep(await get("/health"));
  const healthBody = parse(health.text) as Record<string, unknown> | undefined;
  expect(
    "health",
    health.status === 200 && healthBody?.status === "ok" && healthBody.app === app && healthBody.version === record.version,
    `GET /health answers ok for ${app} ${record.version}.`,
    `GET /health answered ${health.status} ${health.text.slice(0, 200)}; it must be { status: "ok", app: "${app}", version: "${record.version}" }.`,
  );
  const extra = Object.keys(healthBody ?? {}).filter((k) => !["status", "app", "version"].includes(k));
  if (extra.length) add("health.fields", "warn", `GET /health has more fields (${extra.join(", ")}); it must never have paths, user names, or counts.`);

  const badHost = keep(await get("/health", { host: "rebind.example:80" }));
  expect("guard.host", badHost.status === 421 && isErrorBody(parse(badHost.text), "invalid_host"), "A wrong Host gets 421 invalid_host.", `A wrong Host got ${badHost.status}, not 421 invalid_host.`);

  const noToken = keep(await get("/api/v1"));
  expect("guard.token", noToken.status === 401 && isErrorBody(parse(noToken.text), "unauthorized"), "/api/v1 without the token gets 401.", `/api/v1 without the token got ${noToken.status}, not 401 unauthorized.`);

  const wrongToken = keep(await get("/api/v1", { authorization: `Bearer ${"x".repeat(43)}` }));
  expect("guard.token.wrong", wrongToken.status === 401, "/api/v1 with a wrong token gets 401.", `/api/v1 with a wrong token got ${wrongToken.status}.`);

  const cookie = keep(await get("/api/v1", { cookie: `memex_${app}_token=${token}` }));
  expect("guard.cookie", cookie.status === 401, "/api/v1 does not take the cookie.", `/api/v1 took the cookie (status ${cookie.status}).`);

  const list = keep(await get("/api/v1", auth));
  const listed = parse(list.text) as Listed | undefined;
  const caps = listed?.capabilities ?? [];
  if (list.status !== 200 || !Array.isArray(listed?.capabilities)) {
    add("api.list", "fail", `GET /api/v1 answered ${list.status}; it must list the capabilities.`);
    return undefined;
  }
  expect(
    "api.list",
    listed.app === app && listed.version === record.version && listed.openapi === "/api/v1/openapi.json",
    `GET /api/v1 lists ${caps.length} capabilities.`,
    "GET /api/v1 must have app, version, capabilities, and openapi: /api/v1/openapi.json.",
  );
  const badIds = caps.filter((c) => !isCapabilityId(c.id, app)).map((c) => c.id);
  expect("api.ids", badIds.length === 0, `Every id is ${app}.<noun>.<verb>.`, `Ids that are not ${app}.<noun>.<verb>: ${badIds.join(", ")}`);
  const badKinds = caps.filter((c) => c.kind !== "read" && c.kind !== "write").map((c) => c.id);
  expect("api.kinds", badKinds.length === 0, "Every kind is read or write.", `Kinds that are not read or write: ${badKinds.join(", ")}`);
  const long = caps.filter((c) => typeof c.description !== "string" || c.description.length === 0 || c.description.length > 600).map((c) => c.id);
  expect("api.descriptions", long.length === 0, "Every description has 1 to 600 characters.", `Descriptions that are empty or longer than 600: ${long.join(", ")}`);

  const openapi = keep(await get("/api/v1/openapi.json", auth));
  const doc = parse(openapi.text) as { openapi?: string; paths?: Record<string, Record<string, unknown>> } | undefined;
  const missing = caps.filter((c) => {
    const ops = doc?.paths?.[`/api/v1/${c.id}`];
    return !ops?.post || (c.kind === "read") !== Boolean(ops.get);
  });
  expect(
    "api.openapi",
    openapi.status === 200 && typeof doc?.openapi === "string" && doc.openapi.startsWith("3.1") && missing.length === 0,
    "OpenAPI 3.1 has POST for every capability and GET for each read.",
    `GET /api/v1/openapi.json must be OpenAPI 3.1 with every capability${missing.length ? `; wrong or missing: ${missing.map((c) => c.id).join(", ")}` : ""}.`,
  );

  const unknown = keep(await get(`/api/v1/${app}.surfacescheck.unknown`, auth));
  expect("api.unknown", unknown.status === 404 && isErrorBody(parse(unknown.text), "unknown_capability"), "An unknown id gets 404 unknown_capability.", `An unknown id got ${unknown.status}.`);

  // The guard runs before the capability, so these calls never reach it; a read is used all the same.
  const target = caps.find((c) => c.kind === "read") ?? caps[0];
  const route = `/api/v1/${target?.id ?? `${app}.surfacescheck.unknown`}`;
  const evil = keep(
    await localRequest(`${url}${route}`, {
      method: "POST",
      timeoutMs,
      headers: { ...auth, origin: "http://evil.example", "content-type": "application/json", "content-length": "2" },
      body: "{}",
    }),
  );
  expect("guard.origin", evil.status === 403 && isErrorBody(parse(evil.text), "invalid_origin"), "Another Origin gets 403 invalid_origin.", `Another Origin got ${evil.status}, not 403 invalid_origin.`);
  const text = keep(
    await localRequest(`${url}${route}`, {
      method: "POST",
      timeoutMs,
      headers: { ...auth, origin: `http://${host}`, "content-type": "text/plain", "content-length": "2" },
      body: "{}",
    }),
  );
  expect("guard.content-type", text.status === 415 && isErrorBody(parse(text.text), "unsupported_media_type"), "A text/plain body gets 415.", `A text/plain body got ${text.status}, not 415.`);

  expect("guard.cors", noCors(answers), "No answer has CORS headers.", "An answer has Access-Control-Allow-Origin; the server must send no CORS headers.");
  return listed;
}

async function checkMcp(app: string, mcp: NonNullable<AppRecord["mcp"]>, listed: Listed | undefined, r: Reporter): Promise<void> {
  const { add, expect, timeoutMs } = r;
  const client = new Client({ name: "memex-surfaces-check", version: "1" });
  const transport = new StdioClientTransport({
    command: mcp.command,
    args: mcp.args,
    env: Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined)),
    stderr: "ignore",
  });
  try {
    await client.connect(transport, { timeout: timeoutMs });
  } catch (error) {
    add("mcp.start", "fail", `${mcp.command} ${mcp.args.join(" ")} did not start an MCP server: ${(error as Error).message}`);
    await client.close().catch(() => undefined);
    return;
  }
  try {
    expect("mcp.start", true, `${mcp.command} ${mcp.args.join(" ")} starts an MCP server.`, "");
    const { tools } = await client.listTools(undefined, { timeout: timeoutMs });
    const prefix = new RegExp(`^${app}_[a-z][a-z0-9]*_[a-z][a-z0-9]*$`);
    const badNames = tools.filter((t) => !prefix.test(t.name)).map((t) => t.name);
    expect("mcp.names", badNames.length === 0, `Every tool is ${app}_<noun>_<verb> (${tools.length} tools).`, `Tool names that are not ${app}_<noun>_<verb>: ${badNames.join(", ")}`);
    const noHint = tools.filter((t) => typeof t.annotations?.readOnlyHint !== "boolean").map((t) => t.name);
    expect("mcp.annotations", noHint.length === 0, "Every tool has readOnlyHint.", `Tools without readOnlyHint: ${noHint.join(", ")}`);
    if (listed?.capabilities) {
      const kinds = new Map(listed.capabilities.map((c) => [c.id.replace(/\./g, "_"), c.kind]));
      const extra = tools.filter((t) => !kinds.has(t.name)).map((t) => t.name);
      expect("mcp.capabilities", extra.length === 0, "Every tool is a capability of /api/v1.", `Tools that are not capabilities: ${extra.join(", ")}`);
      const wrong = tools.filter((t) => kinds.has(t.name) && t.annotations?.readOnlyHint !== (kinds.get(t.name) === "read")).map((t) => t.name);
      expect("mcp.readonly", wrong.length === 0, "readOnlyHint is true exactly for reads.", `readOnlyHint does not match the kind: ${wrong.join(", ")}`);
    }
    const tool = tools.find((t) => t.annotations?.readOnlyHint === true);
    if (tool) {
      const result = await client.callTool({ name: tool.name, arguments: { surfacesCheckUnknownField: true } }, undefined, { timeout: timeoutMs });
      const content = result.content as Array<{ type: string; text?: string }>;
      const first = content[0];
      expect(
        "mcp.errors",
        result.isError === true && first?.type === "text" && isErrorBody(parse(first.text ?? ""), "invalid_input"),
        "A bad input gets isError with the error body invalid_input.",
        `A bad input to ${tool.name} must get isError true and the error body invalid_input.`,
      );
    } else add("mcp.errors", "skip", "No read tool to call with a bad input.");
  } catch (error) {
    add("mcp", "fail", `The MCP server failed: ${(error as Error).message}`);
  } finally {
    await client.close().catch(() => undefined);
  }
}

function runCommand(command: string, args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    // A program is started the way an outside client starts it: without a shell. Only a .cmd or .bat file on
    // Windows needs cmd.exe; the arguments here are fixed words.
    const windows = process.platform === "win32" && /\.(cmd|bat)$/i.test(command);
    const child = spawn(windows ? `"${command}" ${args.join(" ")}` : command, windows ? [] : args, {
      shell: windows,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    child.on("error", (error) => resolve({ code: null, stdout, stderr: stderr + error.message }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function checkCli(app: string, command: string, r: Reporter): Promise<void> {
  const { expect, timeoutMs } = r;
  const caps = await runCommand(command, ["capabilities", "--json"], timeoutMs);
  const list = parse(caps.stdout);
  expect(
    "cli.capabilities",
    caps.code === 0 && Array.isArray(list) && list.every((c: { id?: string; input?: unknown }) => typeof c.id === "string" && typeof c.input === "object"),
    `memex-${app} capabilities --json lists the capabilities with their schemas.`,
    `memex-${app} capabilities --json exited ${caps.code} without a list with schemas.`,
  );
  const about = await runCommand(command, ["about", "--json"], timeoutMs);
  const aboutBody = parse(about.stdout) as Record<string, unknown> | undefined;
  expect(
    "cli.about",
    about.code === 0 && aboutBody?.app === app && typeof aboutBody.version === "string" && typeof aboutBody.license === "string",
    `memex-${app} about --json has the app, version, and license.`,
    `memex-${app} about --json exited ${about.code} without app, version, and license.`,
  );
  const unknown = await runCommand(command, ["call", `${app}.surfacescheck.unknown`, "{}", "--json"], timeoutMs);
  expect(
    "cli.errors",
    unknown.code === 1 && isErrorBody(parse(unknown.stdout), "unknown_capability"),
    "An unknown capability exits 1 with the error body on standard output.",
    `memex-${app} call <unknown> --json exited ${unknown.code}; it must exit 1 with the error body unknown_capability.`,
  );
  const usage = await runCommand(command, ["surfaces-check-no-such-command"], timeoutMs);
  expect("cli.usage", usage.code === 2, "A usage error exits 2.", `An unknown command exited ${usage.code}, not 2.`);
}

/** The results as lines for people. */
export function formatResults(results: CheckResult[]): string {
  const lines = results.map((r) => `${r.status.toUpperCase().padEnd(4)}  ${r.id.padEnd(20)}  ${r.message}`);
  const count = (s: CheckStatus) => results.filter((r) => r.status === s).length;
  lines.push("", `${count("pass")} passed, ${count("fail")} failed, ${count("warn")} warnings, ${count("skip")} skipped.`);
  return lines.join("\n");
}
