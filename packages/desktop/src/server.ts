/**
 * @tjalve/memex-desktop/server: what an app's local server uses when the desktop shell starts it. No Electron import,
 * so the same server also runs under plain Node.js.
 */
import { spawn } from "node:child_process";
import { formatReadyLine } from "./ready-line.js";

export { READY_PREFIX, formatReadyLine } from "./ready-line.js";

/** The variables the shell sets for the server it starts. */
export const DESKTOP_ENV = {
  /** The app id. */
  app: "MEMEX_DESKTOP_APP",
  /** The program that starts the app: the installed executable, for the app record. */
  executable: "MEMEX_DESKTOP_EXECUTABLE",
  /** The absolute path of the memex-<app> CLI shim (memex-<app>.exe on Windows), for the app record's mcp command; empty when there is none. */
  cli: "MEMEX_DESKTOP_CLI",
  /** How the shell asks the server to stop: "message" (Electron utility process) or "stdin" (the shell closes standard input). */
  stop: "MEMEX_DESKTOP_STOP",
} as const;

export interface DesktopLaunch {
  /** Whether the desktop shell started this process. */
  desktop: boolean;
  app?: string;
  executable?: string;
  /** The app record's mcp command when the app ships a CLI shim. */
  mcp?: { command: string; args: string[] };
}

/** What the shell told this server. Use executable and mcp in the app record (serveApp of @tjalve/memex-surfaces). */
export function desktopLaunch(env: Readonly<Record<string, string | undefined>> = process.env): DesktopLaunch {
  const app = env[DESKTOP_ENV.app] || undefined;
  if (!app) return { desktop: false };
  const executable = env[DESKTOP_ENV.executable] || undefined;
  const cli = env[DESKTOP_ENV.cli] || undefined;
  return { desktop: true, app, executable, mcp: cli ? { command: cli, args: ["mcp"] } : undefined };
}

/**
 * Writes the ready line. Call it when the listener is ready and the token file is written; the shell then reads the
 * token from tokenFile and loads url.
 */
export function announceReady(
  announcement: { app: string; url: string; tokenFile: string },
  write: (text: string) => unknown = (text) => process.stdout.write(text),
): void {
  write(`${formatReadyLine(announcement)}\n`);
}

interface ParentPortLike {
  on(event: "message", listener: (event: { data: unknown }) => void): unknown;
}

/**
 * Runs stop when the shell asks the server to stop, then exits with 0 (or 1 when stop throws). The shell kills the
 * server when it does not exit within a few seconds.
 */
export function onDesktopStop(
  stop: () => unknown,
  options: { env?: Readonly<Record<string, string | undefined>>; exit?: (code: number) => void } = {},
): void {
  const env = options.env ?? process.env;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  let stopping = false;
  const run = () => {
    if (stopping) return;
    stopping = true;
    Promise.resolve()
      .then(stop)
      .then(
        () => exit(0),
        (error: unknown) => {
          process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
          exit(1);
        },
      );
  };
  const mode = env[DESKTOP_ENV.stop];
  const port = (process as unknown as { parentPort?: ParentPortLike }).parentPort;
  if (mode === "message" && port) {
    port.on("message", (event) => {
      const data = event?.data as { type?: unknown } | undefined;
      if (data && data.type === "memex:stop") run();
    });
  } else if (mode === "stdin") {
    process.stdin.on("end", run);
    process.stdin.on("error", run);
    process.stdin.resume();
  }
}

/**
 * The open command of a desktop app's CLI (runCli's open option of @tjalve/memex-surfaces): starts the app's program
 * without waiting for it. When the app runs, the new start hands over to it, and its window comes to the front.
 *
 * The CLI runs in the app's own program as Node.js (ELECTRON_RUN_AS_NODE), so process.execPath is the app's program;
 * the variable is removed for the new start, so that the program starts as the app. From an AppImage, $APPIMAGE is the
 * program. Pass executable (and args) when the CLI runs somewhere else, for example unpackaged.
 *
 * On macOS a program inside an app bundle is opened through LaunchServices (/usr/bin/open -a <bundle>), as the Dock and
 * Finder open it: a running app is brought to the front (macOS lets the app in front, the terminal, hand over the
 * focus), and a new start runs as the app itself in the user's session, not as a child of the terminal, so its privacy
 * grants stay its own. On current macOS the new start inherits this process's environment; the MEMEX_* variables (the
 * folders of a test run) are also passed with --env, as a fallback for a macOS that does not pass it.
 */
export async function openDesktopApp(
  options: { executable?: string; args?: string[]; env?: Readonly<Record<string, string | undefined>>; platform?: string } = {},
): Promise<void> {
  const env = { ...(options.env ?? process.env) };
  const executable = options.executable ?? (env.APPIMAGE || (process.versions.electron ? process.execPath : undefined));
  if (!executable) throw new Error("This CLI does not run inside the app's program; start the app from its program or its shortcut.");
  delete env.ELECTRON_RUN_AS_NODE;
  for (const key of Object.values(DESKTOP_ENV)) delete env[key];
  const { command, args } = openCommand(executable, options.args ?? [], env, options.platform ?? process.platform);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore", env, windowsHide: false, shell: false });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

/** The app bundle of a macOS program (/Applications/X.app/Contents/MacOS/X gives /Applications/X.app), or undefined. */
export function macAppBundle(executable: string): string | undefined {
  const match = /^(.*\.app)\/Contents\/MacOS\/[^/]+$/.exec(executable);
  return match ? match[1] : undefined;
}

/** The program and arguments that open the app: the program itself, or /usr/bin/open for a macOS app bundle. */
export function openCommand(
  executable: string,
  args: string[],
  env: Readonly<Record<string, string | undefined>>,
  platform: string,
): { command: string; args: string[] } {
  const bundle = platform === "darwin" ? macAppBundle(executable) : undefined;
  if (!bundle) return { command: executable, args };
  const passed = Object.entries(env)
    .filter(([key, value]) => key.startsWith("MEMEX_") && value !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([key, value]) => ["--env", `${key}=${value}`]);
  return { command: "/usr/bin/open", args: ["-a", bundle, ...passed, ...(args.length ? ["--args", ...args] : [])] };
}
