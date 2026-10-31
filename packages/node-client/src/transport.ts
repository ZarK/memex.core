import { request as httpRequest, type IncomingMessage } from "node:http";
import { readTokenFile, type RunningInfo } from "@tjalve/memex-surfaces";

/**
 * Where a running service listens: the named pipe or Unix socket of Memex.Node (node-api.md, Transport), or a loopback
 * URL with its token (surfaces.md; Memex.Node with --dev-loopback, Memex.User, and apps).
 */
export type Endpoint = { socket: string } | { url: string; token: string };

/** The endpoint of a running record. Reads the token file for a loopback URL. */
export async function endpointOf(running: RunningInfo): Promise<Endpoint> {
  if (running.socket) return { socket: running.socket };
  if (running.url && running.tokenFile) return { url: running.url, token: await readTokenFile(running.tokenFile) };
  throw new Error("The record names no endpoint.");
}

export interface RawRequest {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: Uint8Array;
  /** Gives up when no answer starts in this time. Default 60 s; 0 waits without limit. */
  timeoutMs?: number;
}

/**
 * A connection error that proves the request never reached the service, so the caller may read the record again and
 * send it once more: the pipe or socket is gone (ENOENT) or refuses the connection (ECONNREFUSED). A reset or broken
 * pipe counts only on a reused keep-alive connection, for a method that may run twice (GET, HEAD, PUT, DELETE): the
 * service closed that idle connection. A reset in any other case may come after the service started the work, so it is
 * not retried.
 */
export function isConnectError(error: unknown): boolean {
  const e = error as (NodeJS.ErrnoException & { reusedSocket?: boolean; method?: string }) | null;
  const code = e?.code;
  if (code === "ENOENT" || code === "ECONNREFUSED") return true;
  if (code !== "ECONNRESET" && code !== "EPIPE") return false;
  return e?.reusedSocket === true && ["GET", "HEAD", "PUT", "DELETE"].includes((e.method ?? "").toUpperCase());
}

/** Sends one request and returns the response with its body still to read (for server-sent events). */
export function openRequest(endpoint: Endpoint, req: RawRequest): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...(req.headers ?? {}) };
    let target: { socketPath: string; path: string } | { host: string; port: number; path: string };
    if ("socket" in endpoint) {
      // The pipe or socket takes no token; the Host header is localhost (node-api.md, Transport).
      headers.host = "localhost";
      target = { socketPath: endpoint.socket, path: req.path };
    } else {
      const url = new URL(endpoint.url);
      headers.host = url.host;
      headers.authorization = `Bearer ${endpoint.token}`;
      target = { host: url.hostname, port: Number(url.port), path: req.path };
    }
    if (req.body !== undefined) headers["content-length"] = String(req.body.byteLength);
    const timeoutMs = req.timeoutMs ?? 60_000;
    const r = httpRequest({ ...target, method: req.method, headers }, (res) => {
      r.setTimeout(0);
      resolve(res);
    });
    if (timeoutMs > 0) {
      r.setTimeout(timeoutMs, () => {
        const connected = r.socket !== undefined && r.socket !== null && !r.socket.connecting;
        r.destroy(Object.assign(new Error(`No answer to ${req.method} ${req.path} in ${timeoutMs} ms.`), { code: connected ? "ETIMEDOUT" : "ECONNREFUSED" }));
      });
    }
    r.on("error", (error) => reject(Object.assign(error, { reusedSocket: r.reusedSocket, method: req.method })));
    r.end(req.body);
  });
}

export interface RawResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

export function flatHeaders(res: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) out[k] = Array.isArray(v) ? v.join(", ") : v;
  return out;
}

/** Sends one request and reads the whole response. */
export async function sendRequest(endpoint: Endpoint, req: RawRequest): Promise<RawResponse> {
  const res = await openRequest(endpoint, req);
  const chunks: Buffer[] = [];
  for await (const chunk of res) chunks.push(chunk as Buffer);
  return { status: res.statusCode ?? 0, headers: flatHeaders(res), body: Buffer.concat(chunks) };
}

/** Reads server-sent events from a response: each event with its name and its data (JSON when it parses). */
export async function* readEvents(res: IncomingMessage): AsyncGenerator<{ event: string; data: unknown }> {
  res.setEncoding("utf8");
  let buffer = "";
  for await (const chunk of res) {
    buffer += chunk as string;
    let end: number;
    while ((end = buffer.search(/\r?\n\r?\n/)) >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(buffer[end] === "\r" ? end + 4 : end + 2);
      let event = "message";
      const data: string[] = [];
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
        if (field === "event") event = value;
        else if (field === "data") data.push(value);
      }
      if (!data.length) continue;
      const text = data.join("\n");
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        // not JSON: the text
      }
      yield { event, data: parsed };
    }
  }
}

