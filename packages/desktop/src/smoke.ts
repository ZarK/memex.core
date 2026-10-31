import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { BrowserWindow } from "electron";

/**
 * MEMEX_DESKTOP_SMOKE=<folder> starts the app in smoke-test mode, for the release workflow: the shell records its
 * events in <folder>/events.jsonl, and when the first app page has loaded it writes a picture and the text of the
 * window and <folder>/result.json, and quits. When the crash screen shows instead, result.json says why. The app
 * itself runs as always: its own server, its own folders, the token cookie and the sandbox.
 */
export const SMOKE_ENV = "MEMEX_DESKTOP_SMOKE";

export interface SmokeResult {
  ok: boolean;
  app: string;
  productName: string;
  version: string;
  platform: string;
  arch: string;
  electron: string;
  /** What failed, when ok is false. */
  reason?: string;
  /** The HTTP status of the first app page. */
  status?: number;
  /** The window's title and the length of its text, when the page loaded. */
  title?: string;
  textLength?: number;
  /** The milliseconds from the shell's start to the loaded page or the crash screen. */
  elapsedMs: number;
}

export type SmokeOutcome = { ok: true; status?: number } | { ok: false; reason: string; status?: number };

export interface SmokeRecorder {
  readonly folder: string;
  event(event: { type: string } & Record<string, unknown>): void;
  finish(win: SmokeWindow | null, outcome: SmokeOutcome): Promise<SmokeResult | null>;
}

/** What finish reads of the window (a BrowserWindow). */
export type SmokeWindow = Pick<BrowserWindow, "isDestroyed" | "getTitle"> & {
  webContents: Pick<BrowserWindow["webContents"], "executeJavaScript" | "capturePage">;
};

/**
 * The outcome of the first app page: it passes only with an HTTP 2xx answer. A server that answers 500, 404 or 401
 * still loads a page in the window, so the page alone proves nothing. A status of null means the shell saw no answer.
 */
export function pageOutcome(status: number | null): SmokeOutcome {
  if (status === null) return { ok: false, reason: "The first page loaded without an HTTP answer." };
  if (status >= 200 && status < 300) return { ok: true, status };
  return { ok: false, reason: `The first page answered HTTP ${status}.`, status };
}

/** The smoke folder from the environment: an absolute path, or null when the variable is not set. */
export function smokeFolder(env: Readonly<Record<string, string | undefined>> = process.env): string | null {
  const value = env[SMOKE_ENV];
  if (value === undefined || value === "") return null;
  if (!path.isAbsolute(value)) throw new Error(`${SMOKE_ENV} must be an absolute path.`);
  return value;
}

/** Only plain values of an event go into events.jsonl (no windows, no tokens: the shell's events carry none). */
export function smokeEventLine(event: { type: string } & Record<string, unknown>, at = new Date()): string {
  const plain: Record<string, unknown> = { at: at.toISOString() };
  for (const [key, value] of Object.entries(event)) {
    if (value === null || ["string", "number", "boolean"].includes(typeof value)) plain[key] = value;
    else if (key === "announcement" && typeof value === "object") {
      const { app, url } = value as { app?: unknown; url?: unknown };
      plain[key] = { app, url };
    }
  }
  return `${JSON.stringify(plain)}\n`;
}

/** Text that the first page must show; the shell waits for it (pages fill in after load), up to SmokeSettings.waitMs. */
export const SMOKE_EXPECT_ENV = "MEMEX_DESKTOP_SMOKE_EXPECT";

export interface SmokeSettings {
  /** Text the page must show before the picture is taken. */
  expect?: string;
  /** How long to wait for that text after the page has loaded. Defaults to 20 seconds. */
  waitMs?: number;
  /** How often to try the picture of the window. Defaults to 5. */
  captureAttempts?: number;
}

export function createSmokeRecorder(folder: string, info: Omit<SmokeResult, "ok" | "reason" | "title" | "textLength" | "elapsedMs">, settings: SmokeSettings = {}): SmokeRecorder {
  mkdirSync(folder, { recursive: true });
  const started = Date.now();
  let finished: Promise<SmokeResult | null> | null = null;
  return {
    folder,
    event(event) {
      try {
        appendFileSync(path.join(folder, "events.jsonl"), smokeEventLine(event));
      } catch {
        // the record is best effort; result.json decides
      }
    },
    finish(win, outcome) {
      if (finished) return finished;
      finished = (async () => {
        const result: SmokeResult = { ...info, ok: outcome.ok, elapsedMs: Date.now() - started };
        if (outcome.status !== undefined) result.status = outcome.status;
        const fail = (reason: string) => {
          result.ok = false;
          result.reason = `${result.reason ? `${result.reason}; ` : ""}${reason}`;
        };
        if (!outcome.ok) fail(outcome.reason);
        // A passing page must also show text and a picture: an empty page or a failed capture fails the test.
        if (win && !win.isDestroyed()) {
          try {
            const read = async () => String(await win.webContents.executeJavaScript("document.body ? document.body.innerText : ''"));
            let text = await read();
            // A page fills in after load (its own requests to the server): wait for the expected text.
            const expect = outcome.ok ? settings.expect : undefined;
            if (expect) {
              const until = Date.now() + (settings.waitMs ?? 20_000);
              while (!text.includes(expect) && Date.now() < until && !win.isDestroyed()) {
                await new Promise((resolve) => setTimeout(resolve, 200));
                text = await read();
              }
              if (!text.includes(expect)) fail(`The first page does not show "${expect}".`);
            }
            writeFileSync(path.join(folder, "window.txt"), text);
            result.title = win.getTitle();
            result.textLength = text.length;
            if (outcome.ok && text.trim() === "") fail("The first page shows no text.");
            // Software drawing (Xvfb on Linux) can refuse a capture now and then (UnknownVizError): a few tries.
            let picture: Buffer | null = null;
            for (let attempt = 1; picture === null; attempt++) {
              try {
                picture = (await win.webContents.capturePage()).toPNG();
              } catch (error) {
                if (attempt >= (settings.captureAttempts ?? 5) || win.isDestroyed()) throw error;
                await new Promise((resolve) => setTimeout(resolve, 500));
              }
            }
            writeFileSync(path.join(folder, "window.png"), picture);
          } catch (error) {
            fail(`the window could not be captured: ${error instanceof Error ? error.message : String(error)}`);
          }
        } else if (outcome.ok) {
          fail("The window was gone before it could be captured.");
        }
        writeFileSync(path.join(folder, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
        return result;
      })();
      return finished;
    },
  };
}
