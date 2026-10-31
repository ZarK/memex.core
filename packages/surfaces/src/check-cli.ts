import { parseArgs } from "node:util";
import { checkApp, formatResults } from "./check.js";

const USAGE = `Usage:
  memex-surfaces check <app> [--apps <dir>] [--json] [--skip-commands] [--timeout <seconds>]

Checks an installed app against contracts/surfaces.md: the app record in the apps folder; when the app runs,
GET /health, the request checks, /api/v1, and OpenAPI 3.1; and the stdio MCP server and the memex-<app> CLI
through the mcp command of the record. Start the app first to check its HTTP API.

Exit codes: 0 every check passed, 1 a check failed, 2 usage error.`;

/** The memex-surfaces CLI. Returns the exit code. */
export async function main(argv: string[], out: (text: string) => void = (t) => process.stdout.write(t + "\n")): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        apps: { type: "string" },
        json: { type: "boolean" },
        "skip-commands": { type: "boolean" },
        timeout: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${USAGE}\n`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    out(USAGE);
    return 0;
  }
  const timeout = values.timeout === undefined ? 10 : Number(values.timeout);
  if (positionals[0] !== "check" || positionals.length !== 2 || !/^[a-z][a-z0-9]*$/.test(positionals[1]!) || !(timeout > 0)) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  const results = await checkApp(positionals[1]!, { apps: values.apps, timeoutMs: timeout * 1000, skipCommands: values["skip-commands"] });
  out(values.json ? JSON.stringify({ app: positionals[1], results }, null, 2) : formatResults(results));
  return results.some((r) => r.status === "fail") ? 1 : 0;
}
