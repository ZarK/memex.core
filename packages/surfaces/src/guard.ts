import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import type { IncomingHttpHeaders } from "node:http";
import path from "node:path";
import { restrictToAccount } from "./account-acl.js";
import { SurfaceError } from "./errors.js";

/** A new token for one launch: 32 random bytes, base64url without padding. */
export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

/** The cookie of the app's UI: memex_<app>_token. Cookies are not isolated by port, so each app has its own name. */
export function cookieName(app: string): string {
  return `memex_${app}_token`;
}

/** The Set-Cookie value of the app's UI. */
export function tokenCookie(app: string, token: string): string {
  return `${cookieName(app)}=${token}; HttpOnly; SameSite=Strict; Path=/`;
}

function sameSecret(observed: string, expected: string): boolean {
  const a = Buffer.from(observed);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function bearer(headers: IncomingHttpHeaders): string | null {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(String(headers.authorization ?? ""));
  return match ? match[1]! : null;
}

function cookie(headers: IncomingHttpHeaders, name: string): string | null {
  for (const part of String(headers.cookie ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

/**
 * Which rules a route follows: health and auth need no token, api needs the bearer token, ui needs the app's cookie.
 * upload is api that takes any content type.
 */
export type RouteKind = "health" | "auth" | "api" | "upload" | "ui";

export interface GuardRequest {
  method: string;
  headers: IncomingHttpHeaders;
}

export interface GuardOptions {
  app: string;
  /** The port the server listens on. */
  port: number;
  token: string;
}

/** The kind of a path: /health, /auth, /api/v1/uploads, /api/v1..., or a UI route. */
export function routeKind(pathname: string): RouteKind {
  if (pathname === "/health") return "health";
  if (pathname === "/auth") return "auth";
  if (pathname === "/api/v1/uploads") return "upload";
  if (pathname === "/api/v1" || pathname.startsWith("/api/v1/")) return "api";
  return "ui";
}

const MUTATIONS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function hasBody(headers: IncomingHttpHeaders): boolean {
  return headers["transfer-encoding"] !== undefined || (headers["content-length"] !== undefined && headers["content-length"] !== "0");
}

/**
 * The request checks of contracts/surfaces.md, in order: Host (421), token (401), Origin (403), content type (415).
 * Returns the first failure, or null. Stops DNS rebinding, pages of other origins, and pages of other apps on 127.0.0.1.
 */
export function checkRequest(request: GuardRequest, kind: RouteKind, options: GuardOptions): SurfaceError | null {
  const { headers } = request;
  const method = request.method.toUpperCase();
  const host = String(headers.host ?? "").toLowerCase();
  if (host !== `127.0.0.1:${options.port}` && host !== `localhost:${options.port}`) {
    return new SurfaceError("invalid_host", "The app only accepts the Host 127.0.0.1 or localhost with its port.");
  }

  if (kind === "api" || kind === "upload") {
    const token = bearer(headers);
    if (token === null || !sameSecret(token, options.token)) {
      return new SurfaceError("unauthorized", "This call needs the token of this launch.", {
        hint: "Send Authorization: Bearer <token>, with the token from the file that the app record names.",
      });
    }
  } else if (kind === "ui") {
    const value = cookie(headers, cookieName(options.app));
    if (value === null || !sameSecret(value, options.token)) {
      return new SurfaceError("unauthorized", "Open the app with its desktop window or memex-" + options.app + " open.");
    }
  }

  const origin = headers.origin;
  if (origin !== undefined ? origin !== `http://${host}` : kind === "ui" && MUTATIONS.has(method)) {
    return new SurfaceError("invalid_origin", "The request must come from the app's own origin.");
  }

  if (kind !== "upload" && hasBody(headers)) {
    const type = String(headers["content-type"] ?? "").split(";", 1)[0]!.trim().toLowerCase();
    if (type !== "application/json") {
      return new SurfaceError("unsupported_media_type", "Send the body as application/json.", {
        hint: "Set Content-Type: application/json. Files go to POST /api/v1/uploads.",
      });
    }
  }
  return null;
}

/** One-use codes for GET /auth, valid for 60 seconds. The token itself is never in a URL. */
export class AuthCodes {
  private readonly codes = new Map<string, number>();
  private readonly now: () => number;
  private readonly ttl: number;

  constructor(options: { ttlMs?: number; now?: () => number } = {}) {
    this.ttl = options.ttlMs ?? 60_000;
    this.now = options.now ?? Date.now;
  }

  issue(): { code: string; expiresAt: string } {
    const now = this.now();
    for (const [code, expires] of this.codes) if (expires <= now) this.codes.delete(code);
    const code = randomBytes(24).toString("base64url");
    this.codes.set(code, now + this.ttl);
    return { code, expiresAt: new Date(now + this.ttl).toISOString() };
  }

  /** true once for a valid code. */
  redeem(code: string): boolean {
    const expires = this.codes.get(code);
    this.codes.delete(code);
    return expires !== undefined && expires > this.now();
  }
}

/**
 * Writes the token file whole: mode 0600 on macOS and Linux, and on Windows an access list with only this account. The
 * app writes it before the app record.
 */
export async function writeTokenFile(file: string, token: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await writePrivateFile(file, token);
}

/**
 * Writes a file whole that only this OS account can read: a temporary file in the same folder, renamed over the file.
 * The temporary file is made empty (mode 0600) and gets its access list (Windows) before any byte goes in, so no other
 * account can read the content at any moment; writing into an existing file keeps its access list, and so does the
 * rename. When the access list cannot be set, nothing is written.
 */
export async function writePrivateFile(file: string, data: string): Promise<void> {
  const partial = `${file}.${process.pid}-${randomBytes(4).toString("hex")}.partial`;
  try {
    await fs.writeFile(partial, "", { flag: "wx", mode: 0o600 });
    await restrictToAccount(partial);
    await fs.writeFile(partial, data, { flag: "r+" });
    await renameOver(partial, file);
  } finally {
    await fs.rm(partial, { force: true });
  }
}

/** Reads a token file. */
export async function readTokenFile(file: string): Promise<string> {
  return (await fs.readFile(file, "utf8")).trim();
}

/** Renames a file over another; Windows refuses for a moment while another process has the target open. */
export async function renameOver(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 4 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
}

