import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { SMOKE_ENV, SMOKE_EXPECT_ENV, type SmokeResult } from "./smoke.js";

export interface SmokeRunOptions {
  /** The app's program: the installed .exe, the program in Contents/MacOS of the .app, or the Linux program. */
  program: string;
  args?: string[];
  /** An empty folder for the results. */
  out: string;
  /** How long the app may take to show its first page. Defaults to 180 seconds. */
  timeoutMs?: number;
  /** Text that the first page must show (checked in window.txt). */
  expect?: string;
  /** How long the app may take to quit after the page. Defaults to 30 seconds. */
  quitTimeoutMs?: number;
  env?: Record<string, string | undefined>;
  log?: (line: string) => void;
}

export interface SmokeRunResult {
  result: SmokeResult;
  exitCode: number | null;
  quit: boolean;
}

function killTree(pid: number): void {
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  }
}

/**
 * Starts an installed app in smoke-test mode (MEMEX_DESKTOP_SMOKE) and waits for its result: the app must start its
 * server, show its first page and quit by itself. Throws when it does not.
 */
export async function runSmoke(options: SmokeRunOptions): Promise<SmokeRunResult> {
  const log = options.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const out = path.resolve(options.out);
  if (!existsSync(options.program)) throw new Error(`The program is missing: ${options.program}`);
  if (existsSync(out) && readdirSync(out).length > 0) throw new Error(`The folder is not empty: ${out}`);
  mkdirSync(out, { recursive: true });
  const resultFile = path.join(out, "result.json");
  log(`Starting ${options.program} in smoke-test mode.`);
  const child = spawn(options.program, options.args ?? [], {
    env: { ...process.env, ...options.env, [SMOKE_ENV]: out, [SMOKE_EXPECT_ENV]: options.expect || undefined, ELECTRON_RUN_AS_NODE: undefined },
    stdio: ["ignore", "inherit", "inherit"],
    detached: process.platform !== "win32",
  });
  let exitCode: number | null = null;
  let exited = false;
  const exit = new Promise<void>((resolve) => {
    child.on("exit", (code) => {
      exitCode = code;
      exited = true;
      resolve();
    });
    child.on("error", (error) => {
      log(`The program did not start: ${error.message}`);
      exited = true;
      resolve();
    });
  });
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const deadline = Date.now() + (options.timeoutMs ?? 180_000);
  while (!existsSync(resultFile) && !exited && Date.now() < deadline) await sleep(250);
  if (!existsSync(resultFile)) {
    if (!exited && child.pid !== undefined) killTree(child.pid);
    throw new Error(exited ? `The app exited (code ${exitCode ?? "unknown"}) without a smoke result.` : "The app showed no page and no crash screen in time.");
  }
  await sleep(200);
  const result = JSON.parse(readFileSync(resultFile, "utf8")) as SmokeResult;
  const quitBy = Date.now() + (options.quitTimeoutMs ?? 30_000);
  await Promise.race([exit, (async () => { while (!exited && Date.now() < quitBy) await sleep(250); })()]);
  const quit = exited;
  if (!quit && child.pid !== undefined) killTree(child.pid);
  if (!result.ok) throw new Error(`The smoke test failed: ${(result.reason ?? "no reason given").replace(/\.$/, "")}.`);
  if (!quit) throw new Error("The app showed its page but did not quit by itself.");
  if (options.expect !== undefined && options.expect !== "") {
    const textFile = path.join(out, "window.txt");
    const text = existsSync(textFile) ? readFileSync(textFile, "utf8") : "";
    if (!text.includes(options.expect)) throw new Error(`The first page does not show "${options.expect}" (window.txt).`);
  }
  return { result, exitCode, quit };
}
