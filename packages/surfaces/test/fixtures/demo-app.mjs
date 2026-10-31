// The test app as a program: `serve` starts the HTTP surface and writes the app record; anything else is the CLI.
// MEMEX_APPS_DIR names the apps folder, and SURFACES_TEST_HOME the folder for data and state.
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as lib from "../../dist/index.js";
import { demoRegistry } from "./demo-registry.mjs";

const registry = demoRegistry(lib);
const home = process.env.SURFACES_TEST_HOME;
const paths = {
  data: path.join(home, "data"),
  cache: path.join(home, "cache"),
  logs: path.join(home, "logs"),
  state: path.join(home, "state"),
  packs: path.join(home, "packs"),
  apps: process.env.MEMEX_APPS_DIR,
  archive: path.join(home, "archive"),
};
const argv = process.argv.slice(2);

if (argv[0] === "serve") {
  const running = await lib.serveApp({
    registry,
    kind: "tool",
    data: paths.data,
    state: paths.state,
    executable: process.execPath,
    mcp: { command: process.env.SURFACES_TEST_MCP ?? process.execPath, args: process.env.SURFACES_TEST_MCP ? ["mcp"] : [fileURLToPath(import.meta.url), "mcp"] },
  });
  process.stdout.write(`ready ${running.server.url}\n`);
  const stop = () => running.stop().then(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.stdin.on("end", stop);
  process.stdin.resume();
} else {
  process.exitCode = await lib.runCli(argv, { registry, license: "MIT", notices: "zod: MIT", paths });
}
