import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { ORIGIN_HEADER, forwardedOrigin, handleApiV1 } from "./api-v1.js";
import { SurfaceError, errorBody } from "./errors.js";
import { FileStore } from "./files.js";
import { AuthCodes, checkRequest, newToken, routeKind, tokenCookie } from "./guard.js";
import type { Registry } from "./registry.js";

/** A UI route handler. It runs after the request checks: the cookie is valid, and a mutation came from the app's origin. */
export type UiHandler = (request: IncomingMessage, response: ServerResponse) => void | Promise<void>;

export interface ServerOptions {
  registry: Registry;
  /** The token of this launch. Defaults to a new one. */
  token?: string;
  /** The pages of the app and the routes only its own pages use. A headless tool has none: other paths are 404. */
  ui?: UiHandler;
  /** The largest upload. Defaults to 1 GB. */
  maxUploadBytes?: number;
}

export interface SurfaceServer {
  /** http://127.0.0.1:<port>, for the app record. */
  url: string;
  port: number;
  token: string;
  files: FileStore;
  server: Server;
  close(): Promise<void>;
}

const HEADERS = { "cache-control": "no-store", "x-content-type-options": "nosniff" };

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { ...HEADERS, "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function sendError(response: ServerResponse, error: unknown): void {
  const { status, body } = errorBody(error);
  sendJson(response, status, body);
}

function readBody(request: IncomingMessage, limit: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    let over = false;
    request.on("data", (chunk: Buffer) => {
      length += chunk.length;
      if (length > limit) over = true;
      else chunks.push(chunk);
    });
    request.on("end", () => resolve(over ? null : Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

/**
 * Starts the HTTP surface on 127.0.0.1 with a port the OS chooses: GET /health, /api/v1 (capabilities, OpenAPI,
 * uploads, files, auth codes), GET /auth, and the UI routes. Every request passes the checks of guard.ts first.
 * The server sends no CORS headers.
 */
export async function startServer(options: ServerOptions): Promise<SurfaceServer> {
  const { registry } = options;
  const token = options.token ?? newToken();
  const files = new FileStore();
  const authCodes = options.ui ? new AuthCodes() : undefined;
  let port = 0;

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const method = (request.method ?? "GET").toUpperCase();
      const kind = routeKind(url.pathname);
      const guarded = { method, headers: request.headers };
      // A headless tool has no UI routes; only the Host check comes before its 404.
      const failure =
        kind === "ui" && !options.ui
          ? (checkRequest(guarded, "health", { app: registry.app, port, token }) ??
            new SurfaceError("not_found", `There is no route ${url.pathname}.`))
          : checkRequest(guarded, kind, { app: registry.app, port, token });
      if (failure) return sendError(response, failure);

      if (kind === "health") {
        if (method !== "GET" && method !== "HEAD") throw new SurfaceError("method_not_allowed", "Use GET /health.");
        return sendJson(response, 200, { status: "ok", app: registry.app, version: registry.version });
      }
      if (kind === "auth") {
        if (method !== "GET") throw new SurfaceError("method_not_allowed", "Use GET /auth?code=<code>.");
        if (!authCodes) throw new SurfaceError("not_found", "This app has no UI.");
        if (!authCodes.redeem(url.searchParams.get("code") ?? "")) {
          throw new SurfaceError("unauthorized", "The code is used or expired.", { hint: `Run memex-${registry.app} open again.` });
        }
        response.writeHead(302, { ...HEADERS, "set-cookie": tokenCookie(registry.app, token), location: "/" });
        return response.end();
      }
      if (kind === "api" || kind === "upload") {
        const answer = await handleApiV1(
          registry,
          {
            method,
            path: url.pathname,
            query: url.searchParams,
            contentType: String(request.headers["content-type"] ?? ""),
            body: (limit) => readBody(request, limit),
          },
          // The token check passed, so the caller may name the origin of a call it sends on.
          { files, authCodes, maxUploadBytes: options.maxUploadBytes, origin: forwardedOrigin(request.headers[ORIGIN_HEADER]) },
        );
        if ("data" in answer) {
          response.writeHead(answer.status, { ...HEADERS, "content-type": answer.mediaType, "content-length": answer.data.length });
          return response.end(answer.data);
        }
        return sendJson(response, answer.status, answer.body);
      }
      await options.ui!(request, response);
    } catch (error) {
      if (!response.headersSent) sendError(response, error);
      else response.destroy();
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    token,
    files,
    server,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}
