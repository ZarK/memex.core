/** The status of each error code of contracts/surfaces.md. An app can add codes for its own domain. */
export const ERROR_STATUS: Readonly<Record<string, number>> = {
  invalid_input: 400,
  invalid_json: 400,
  unauthorized: 401,
  invalid_origin: 403,
  forbidden: 403,
  not_found: 404,
  unknown_capability: 404,
  method_not_allowed: 405,
  conflict: 409,
  too_large: 413,
  unsupported_media_type: 415,
  invalid_host: 421,
  rejected: 422,
  internal: 500,
  unavailable: 503,
};

/** The one error body of every surface: HTTP, MCP tool errors, and CLI --json failures. */
export interface ErrorBody {
  error: { code: string; message: string; field?: string; hint?: string };
}

export interface SurfaceErrorOptions {
  /** The HTTP status. Defaults to the status of the code, or 422 for a code of the app's own. */
  status?: number;
  /** The input field that is wrong. */
  field?: string;
  /** How to fix the call. */
  hint?: string;
}

/** An error with a code, a status, and how to fix the call. Every surface renders it as the error body. */
export class SurfaceError extends Error {
  readonly code: string;
  readonly status: number;
  readonly field?: string;
  readonly hint?: string;
  constructor(code: string, message: string, options: SurfaceErrorOptions = {}) {
    super(message);
    this.name = "SurfaceError";
    this.code = code;
    this.status = options.status ?? ERROR_STATUS[code] ?? 422;
    if (options.field !== undefined) this.field = options.field;
    if (options.hint !== undefined) this.hint = options.hint;
  }

  get body(): ErrorBody {
    return makeBody(this.code, this.message, this.field, this.hint);
  }
}

function makeBody(code: string, message: string, field?: string, hint?: string): ErrorBody {
  return { error: { code, message, ...(field ? { field } : {}), ...(hint ? { hint } : {}) } };
}

/** A SurfaceError from an error body that a client received, for example from connect(app).call(). */
export function errorFromBody(body: unknown, status: number): SurfaceError {
  const error = (body as Partial<ErrorBody> | null)?.error;
  if (error && typeof error.code === "string" && typeof error.message === "string") {
    return new SurfaceError(error.code, error.message, { status, field: error.field, hint: error.hint });
  }
  return new SurfaceError(status >= 500 ? "internal" : "rejected", `The app answered with status ${status}.`, { status });
}

/**
 * Parses JSON that a caller sent as input. A parse failure is the caller's: SurfaceError invalid_json, with the field
 * when the text is the value of one input field.
 */
export function parseInputJson(text: string, field?: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new SurfaceError("invalid_json", `${field ? `${field}: ` : ""}The input is not valid JSON: ${reason}`, field ? { field } : {});
  }
}

/**
 * Any thrown value as a status and the error body. A SurfaceError keeps its code. Anything else, also a ZodError or a
 * SyntaxError from inside a handler, is 500 internal: the surfaces turn the caller's own bad input into a SurfaceError
 * before the handler runs.
 */
export function errorBody(err: unknown): { status: number; body: ErrorBody } {
  if (err instanceof SurfaceError) return { status: err.status, body: err.body };
  const message = err instanceof Error ? err.message : String(err);
  return { status: 500, body: makeBody("internal", message || "The capability failed.") };
}
