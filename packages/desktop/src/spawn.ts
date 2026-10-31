import { spawn as spawnChild } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { utilityProcess } from "electron";
import { isLaunchToken } from "./cookie.js";
import { createLineSplitter, createReadyLineReader, keepLine, type ReadyAnnouncement } from "./ready-line.js";
import { DESKTOP_ENV } from "./server.js";

/** A server in JavaScript, run in an Electron utility process with Electron's own Node.js. */
export interface NodeServerSpec {
  kind: "node";
  /** The absolute path of the server's entry module. */
  entry: string;
  args?: string[];
  /** The name in the OS task list. Defaults to memex-<app>-server. */
  serviceName?: string;
}

/** A server that is its own program (for example a .NET engine), run as a child process. */
export interface ExecServerSpec {
  kind: "exec";
  /** The absolute path of the program. */
  command: string;
  args?: string[];
  cwd?: string;
}

export type ServerSpec = NodeServerSpec | ExecServerSpec;

export interface StartServerOptions {
  app: string;
  /** The token file the ready line must name: <state>/token. */
  tokenFile: string;
  env: Record<string, string | undefined>;
  /** How long to wait for the ready line. */
  readyTimeoutMs: number;
  /** Each line of output that is not the ready line. */
  onOutput?: (stream: "stdout" | "stderr", line: string) => void;
}

export interface ServerReady {
  announcement: ReadyAnnouncement;
  token: string;
}

export interface RunningServer {
  readonly pid: number | undefined;
  /** Resolves with the ready line and the token; rejects when the server exits or times out first. */
  readonly ready: Promise<ServerReady>;
  /** Called once when the process exits, also after a stop. */
  onExit(listener: (code: number | null) => void): void;
  /** The last lines the server wrote on both streams. */
  tail(): string[];
  /** Asks the server to stop, and kills it after graceMs. Resolves when it has exited. */
  stop(graceMs?: number): Promise<void>;
  readonly exited: boolean;
}

interface Proc {
  pid: number | undefined;
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  askStop(): void;
  kill(): void;
  onExit(listener: (code: number | null) => void): void;
}

function startProcess(spec: ServerSpec, app: string, env: Record<string, string | undefined>): Proc {
  if (spec.kind === "node") {
    const child = utilityProcess.fork(spec.entry, spec.args ?? [], {
      serviceName: spec.serviceName ?? `memex-${app}-server`,
      stdio: "pipe",
      env: { ...env, [DESKTOP_ENV.stop]: "message" } as Record<string, string>,
    });
    return {
      get pid() {
        return child.pid;
      },
      stdout: child.stdout,
      stderr: child.stderr,
      askStop: () => child.postMessage({ type: "memex:stop" }),
      kill: () => void child.kill(),
      onExit: (listener) => void child.once("exit", (code) => listener(code)),
    };
  }
  if (!path.isAbsolute(spec.command)) throw new Error(`The server program must be an absolute path: ${spec.command}`);
  const child = spawnChild(spec.command, spec.args ?? [], {
    cwd: spec.cwd,
    env: { ...env, [DESKTOP_ENV.stop]: "stdin" },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    shell: false,
  });
  let exitListener: ((code: number | null) => void) | null = null;
  let exitedCode: number | null | undefined;
  child.once("exit", (code) => {
    exitedCode = code;
    exitListener?.(code);
  });
  child.once("error", () => {
    if (exitedCode === undefined) {
      exitedCode = null;
      exitListener?.(null);
    }
  });
  child.stdin?.on("error", () => {});
  return {
    pid: child.pid,
    stdout: child.stdout,
    stderr: child.stderr,
    askStop: () => void child.stdin?.end(),
    kill: () => void child.kill(),
    onExit: (listener) => {
      if (exitedCode !== undefined) listener(exitedCode);
      else exitListener = listener;
    },
  };
}

async function readLaunchToken(file: string, startedAt: number): Promise<string> {
  const info = await stat(file);
  // A token file older than this launch is the last launch's: the server did not write its own.
  if (info.mtimeMs < startedAt - 2000) throw new Error(`The token file ${file} is older than this launch.`);
  const token = (await readFile(file, "utf8")).trim();
  if (!isLaunchToken(token)) throw new Error(`The token file ${file} does not hold a launch token.`);
  return token;
}

function samePath(a: string, b: string): boolean {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/** Starts the server and waits for its ready line, then reads the token of this launch. */
export function startServer(spec: ServerSpec, options: StartServerOptions): RunningServer {
  const startedAt = Date.now();
  const proc = startProcess(spec, options.app, { ...options.env, [DESKTOP_ENV.app]: options.app });
  const kept: string[] = [];
  const listeners: Array<(code: number | null) => void> = [];
  let exited = false;
  let exitCode: number | null = null;
  let resolveExit: () => void = () => {};
  const exitPromise = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });

  const reader = createReadyLineReader(options.app, (line) => {
    keepLine(kept, line);
    options.onOutput?.("stdout", line);
  });
  const stderrLines = createLineSplitter((line) => {
    keepLine(kept, line);
    options.onOutput?.("stderr", line);
  });

  const ready = new Promise<ServerReady>((resolve, reject) => {
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    const timer = setTimeout(() => {
      fail(new Error(`The server did not write its ready line within ${Math.round(options.readyTimeoutMs / 1000)} seconds.`));
      proc.kill();
    }, options.readyTimeoutMs);
    proc.stdout?.on("data", (chunk: Buffer) => {
      const found = reader.push(chunk);
      if (!found || settled) return;
      if (!samePath(found.tokenFile, options.tokenFile)) {
        fail(new Error(`The ready line names the token file ${found.tokenFile}, not ${options.tokenFile}.`));
        proc.kill();
        return;
      }
      readLaunchToken(found.tokenFile, startedAt).then(
        (token) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ announcement: found, token });
        },
        (error: unknown) => {
          fail(error instanceof Error ? error : new Error(String(error)));
          proc.kill();
        },
      );
    });
    proc.stderr?.on("data", stderrLines);
    proc.onExit((code) => {
      exited = true;
      exitCode = code;
      fail(new Error(`The server exited before it was ready (exit code ${code ?? "unknown"}).`));
      for (const listener of listeners.splice(0)) listener(code);
      resolveExit();
    });
  });
  ready.catch(() => {});

  return {
    get pid() {
      return proc.pid;
    },
    ready,
    onExit(listener) {
      if (exited) listener(exitCode);
      else listeners.push(listener);
    },
    tail: () => [...kept],
    get exited() {
      return exited;
    },
    async stop(graceMs = 5000) {
      if (exited) return;
      try {
        proc.askStop();
      } catch {
        proc.kill();
      }
      const timer = setTimeout(() => proc.kill(), graceMs);
      await exitPromise;
      clearTimeout(timer);
    },
  };
}
