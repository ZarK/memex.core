/**
 * The ready line: the one line a Memex app's local server writes on its standard output when its listener is ready.
 *
 *   MEMEX_READY {"app":"photos","url":"http://127.0.0.1:53124","tokenFile":"<state>/token"}
 *
 * The desktop shell waits for it, checks it, reads the token from the token file, sets the token cookie and loads
 * the URL. The token itself is never on the line, so a server started by hand in a terminal does not show it.
 */
export const READY_PREFIX = "MEMEX_READY ";

/** How many other output lines the reader keeps, for the crash screen. */
export const TAIL_LINES = 40;

export interface ReadyAnnouncement {
  app: string;
  port: number;
  /** Always http://127.0.0.1:<port>, with no path. */
  url: string;
  /** The absolute path of the token file of this launch. */
  tokenFile: string;
}

const APP_ID = /^[a-z][a-z0-9]*$/;

/** The ready line for an announcement, without the line break. */
export function formatReadyLine(announcement: { app: string; url: string; tokenFile: string }): string {
  return READY_PREFIX + JSON.stringify({ app: announcement.app, url: announcement.url, tokenFile: announcement.tokenFile });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("/") || value.startsWith("\\\\");
}

/**
 * Parses one line. Returns null unless it is a ready line of the expected app with a loopback http URL on
 * 127.0.0.1 with a port and no path, query, fragment or user name, and an absolute token file path.
 */
export function parseReadyLine(line: unknown, expectedApp: string): ReadyAnnouncement | null {
  const trimmed = String(line ?? "").trim();
  if (!trimmed.startsWith(READY_PREFIX)) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(trimmed.slice(READY_PREFIX.length));
  } catch {
    return null;
  }
  if (!isRecord(payload)) return null;
  const { app, url, tokenFile } = payload;
  if (typeof app !== "string" || !APP_ID.test(app) || app !== expectedApp) return null;
  if (typeof url !== "string" || typeof tokenFile !== "string") return null;
  if (tokenFile.length === 0 || /[\0\r\n]/.test(tokenFile) || !isAbsolutePath(tokenFile)) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1") return null;
  if (parsed.username || parsed.password) return null;
  if (parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") return null;
  const port = Number(parsed.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { app, port, url: `http://127.0.0.1:${port}`, tokenFile };
}

export interface ReadyLineReader {
  /** Takes a chunk of standard output. Returns the announcement when this chunk completed the ready line. */
  push(chunk: unknown): ReadyAnnouncement | null;
  /** The last lines of output that were not the ready line, oldest first. */
  tail(): string[];
}

/** Reads a server's standard output line by line. Lines that are not the ready line go to onLine and the tail. */
export function createReadyLineReader(expectedApp: string, onLine?: (line: string) => void): ReadyLineReader {
  let buffer = "";
  const kept: string[] = [];
  return {
    push(chunk) {
      buffer += String(chunk);
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      let found: ReadyAnnouncement | null = null;
      for (const line of lines) {
        const ready: ReadyAnnouncement | null = found ? null : parseReadyLine(line, expectedApp);
        if (ready) {
          found = ready;
          continue;
        }
        keepLine(kept, line);
        onLine?.(line);
      }
      return found;
    },
    tail() {
      return [...kept];
    },
  };
}

/** Keeps the last TAIL_LINES lines of a stream. */
export function keepLine(kept: string[], line: string): void {
  if (line.trim() === "") return;
  kept.push(line.length > 500 ? `${line.slice(0, 500)}...` : line);
  if (kept.length > TAIL_LINES) kept.splice(0, kept.length - TAIL_LINES);
}

/** Splits a stream into lines for keepLine and a callback; the last part waits for its line break. */
export function createLineSplitter(onLine: (line: string) => void): (chunk: unknown) => void {
  let buffer = "";
  return (chunk) => {
    buffer += String(chunk);
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) onLine(line);
  };
}

/** Whether a URL is a page of the app's own server: http://127.0.0.1:<port>. */
export function isAllowedAppUrl(url: string, port: number): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === "http:" && parsed.hostname === "127.0.0.1" && parsed.port === String(port) && !parsed.username && !parsed.password;
}

/** Whether a link may open in the user's browser: https only, no user name, never a loopback host. */
export function isAllowedExternalUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (parsed.username || parsed.password) return false;
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host || isLoopbackHost(host)) return false;
  return true;
}

function isLoopbackHost(host: string): boolean {
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (/^127(?:\.\d{1,3}){3}$/.test(host)) return true;
  if (host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
  if (host === "0.0.0.0" || host === "::") return true;
  const mapped = ipv4MappedHost(host);
  return mapped !== null && isLoopbackHost(mapped);
}

function ipv4MappedHost(host: string): string | null {
  if (!host.startsWith("::ffff:")) return null;
  const mapped = host.slice("::ffff:".length);
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(mapped)) return mapped;
  const parts = mapped.split(":");
  if (parts.length !== 2 || !parts.every((part) => /^[0-9a-f]{1,4}$/.test(part))) return null;
  const high = Number.parseInt(parts[0]!, 16);
  const low = Number.parseInt(parts[1]!, 16);
  return `${(high >> 8) & 255}.${high & 255}.${(low >> 8) & 255}.${low & 255}`;
}
