import type { z } from "zod";
import { SurfaceError, errorBody, parseInputJson } from "./errors.js";
import type { FileStore } from "./files.js";
import type { AuthCodes } from "./guard.js";
import { openApi } from "./openapi.js";
import type { Capability, Origin, Registry } from "./registry.js";

/** At most 25 MB in a JSON body. Larger content goes through uploads. */
export const MAX_JSON_BYTES = 25 * 1024 * 1024;

export interface ApiRequest {
  method: string;
  /** The URL path, for example /api/v1/photos.meals.list. */
  path: string;
  query: URLSearchParams;
  contentType: string;
  /** Reads the body; null when it is larger than limit. */
  body(limit: number): Promise<Buffer | null>;
}

/** The header that carries the origin of a call that memex-<app> call or memex-<app> mcp sends on to the running app. */
export const ORIGIN_HEADER = "x-memex-origin";

/**
 * The origin of an /api/v1 request: agent or cli when the ORIGIN_HEADER says so, else api. Use it only after the
 * token check passed, so that only a holder of the token can name the origin.
 */
export function forwardedOrigin(header: string | string[] | undefined): Origin {
  return header === "agent" || header === "cli" ? header : "api";
}

export interface ApiOptions {
  files?: FileStore;
  authCodes?: AuthCodes;
  /** Defaults to api: another program. forwardedOrigin() reads the origin that memex-<app> call or mcp sends on. */
  origin?: Origin;
  /** The largest upload. Defaults to 1 GB. */
  maxUploadBytes?: number;
}

/** A JSON answer, or the bytes of a file. */
export type ApiResponse = { status: number; body: unknown } | { status: number; data: Buffer; mediaType: string };

/** The schema inside optional, default, nullable, and similar wrappers. */
function unwrap(schema: z.ZodType): z.ZodType {
  let s = schema as unknown as { def: { type: string; innerType?: unknown } };
  for (let i = 0; i < 10 && ["optional", "default", "nullable", "prefault", "readonly", "catch"].includes(s.def.type); i += 1) {
    s = s.def.innerType as typeof s;
  }
  return s as unknown as z.ZodType;
}

function coerce(schema: z.ZodType, values: string[], field: string): unknown {
  const s = unwrap(schema) as unknown as { def: { type: string; element?: z.ZodType } };
  if (s.def.type === "array") {
    return values
      .flatMap((v) => v.split(","))
      .map((v) => v.trim())
      .filter(Boolean)
      .map((v) => coerce(s.def.element!, [v], field));
  }
  const v = values[values.length - 1] ?? "";
  switch (s.def.type) {
    case "number":
    case "int":
      return v.trim() === "" ? v : Number(v);
    case "boolean":
      return v === "true" || v === "1" ? true : v === "false" || v === "0" ? false : v;
    case "object":
    case "record":
      return parseInputJson(v, field);
    default:
      return v;
  }
}

/** The input of a GET: ?input=<json>, or one query parameter per field. A list repeats the parameter or uses commas. */
export function inputFromQuery(cap: Capability, query: URLSearchParams): unknown {
  const input = query.get("input");
  if (input !== null) return parseInputJson(input);
  const shape = cap.input.shape as Record<string, z.ZodType>;
  const raw: Record<string, unknown> = {};
  for (const key of new Set(query.keys())) {
    const values = query.getAll(key);
    raw[key] = shape[key] ? coerce(shape[key], values, key) : values[values.length - 1];
  }
  return raw;
}

const json = (status: number, body: unknown): ApiResponse => ({ status, body });

function methodNotAllowed(message: string): SurfaceError {
  return new SurfaceError("method_not_allowed", message);
}

/** Handles a request under /api/v1 after the request checks (guard.ts) passed. */
export async function handleApiV1(registry: Registry, request: ApiRequest, options: ApiOptions = {}): Promise<ApiResponse> {
  try {
    const path = request.path.replace(/\/+$/, "");
    if (path === "/api/v1") {
      if (request.method !== "GET") throw methodNotAllowed("Use GET to list the capabilities.");
      return json(200, {
        app: registry.app,
        version: registry.version,
        capabilities: registry.capabilities.map((c) => ({ id: c.id, title: c.title, kind: c.kind, description: c.description })),
        openapi: "/api/v1/openapi.json",
      });
    }
    if (path === "/api/v1/openapi.json") {
      if (request.method !== "GET") throw methodNotAllowed("Use GET for the OpenAPI document.");
      return json(200, openApi(registry));
    }
    if (path === "/api/v1/uploads") {
      if (request.method !== "POST") throw methodNotAllowed("Use POST to upload a file.");
      if (!options.files) throw new SurfaceError("not_found", "This app takes no uploads.");
      const data = await request.body(options.maxUploadBytes ?? 1024 * 1024 * 1024);
      if (data === null) throw new SurfaceError("too_large", "The file is too large.");
      const mediaType = request.contentType.split(";", 1)[0]!.trim().toLowerCase() || "application/octet-stream";
      return json(200, { upload: options.files.addUpload(data, mediaType) });
    }
    if (path.startsWith("/api/v1/files/")) {
      if (request.method !== "GET") throw methodNotAllowed("Use GET to read a file.");
      const file = options.files?.getFile(decodePath(path.slice("/api/v1/files/".length)));
      if (!file) throw new SurfaceError("not_found", "There is no such file, or it has expired.", { hint: "Run the capability again." });
      return { status: 200, data: file.data, mediaType: file.mediaType };
    }
    if (path === "/api/v1/auth/code") {
      if (request.method !== "POST") throw methodNotAllowed("Use POST to get a code.");
      if (!options.authCodes) throw new SurfaceError("not_found", "This app has no UI.");
      return json(200, options.authCodes.issue());
    }

    const id = decodePath(path.slice("/api/v1/".length));
    const cap = registry.get(id);
    if (!cap) throw new SurfaceError("unknown_capability", `There is no capability ${id}.`, { hint: "GET /api/v1 lists them." });
    let input: unknown;
    if (request.method === "GET") {
      if (cap.kind !== "read") throw methodNotAllowed(`${id} changes data; send it with POST.`);
      input = inputFromQuery(cap, request.query);
    } else if (request.method === "POST") {
      const body = await request.body(MAX_JSON_BYTES);
      if (body === null) throw new SurfaceError("too_large", "The request is larger than 25 MB.", { hint: "Send large content to POST /api/v1/uploads." });
      input = body.length ? parseInputJson(body.toString("utf8")) : {};
    } else {
      throw methodNotAllowed("Use GET for reads, or POST.");
    }
    const output = await registry.invoke(id, input, { origin: options.origin ?? "api", files: options.files });
    return json(200, output ?? null);
  } catch (err) {
    const { status, body } = errorBody(err);
    return json(status, body);
  }
}

/** A %-escaped path part. A bad escape (such as %E0%A4%A or %zz) is the caller's error, 400, not a server error. */
function decodePath(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    throw new SurfaceError("invalid_input", "The path has a bad %-escape.", { hint: "Escape each reserved byte as % and two hex digits, in UTF-8." });
  }
}
