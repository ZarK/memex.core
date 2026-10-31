import { z } from "zod";
import { SurfaceError } from "./errors.js";
import type { FileRef, FileStore, StoredFile } from "./files.js";

/** Who called: the app's own UI (user), an MCP client (agent), another program over HTTP (api), or the CLI (cli). */
export type Origin = "user" | "agent" | "api" | "cli";

export type Kind = "read" | "write";

/** What a handler gets besides its parsed input. */
export interface CallContext {
  app: string;
  origin: Origin;
  /** Runs another capability of this app with the same origin. */
  call<T = unknown>(id: string, input?: unknown): Promise<T>;
  /** An upload named by an uploadId input field. It is removed when the outermost call ends. */
  upload(id: string): StoredFile;
  /** Keeps a file the capability made and returns its reference: { url, mediaType, bytes, sha256 }. */
  file(data: Buffer, mediaType: string): FileRef;
}

export interface Annotations {
  /** Deletes or merges records (MCP destructiveHint). */
  destructive?: boolean;
  /** A repeat of the same call changes nothing further (MCP idempotentHint). */
  idempotent?: boolean;
}

/** An input is a zod object without transforms, so that it converts to JSON Schema for MCP and OpenAPI. */
export type InputSchema = z.ZodObject;

export interface Capability<I extends InputSchema = InputSchema> {
  /** <app>.<noun>.<verb>, for example photos.meals.list. The noun is plural. */
  id: string;
  /** A short name for people. */
  title: string;
  kind: Kind;
  /** Written for agents: what it does, units, limits, and which capability to call next. At most 600 characters. */
  description: string;
  input: I;
  output?: z.ZodType;
  annotations?: Annotations;
  /** false leaves the capability out of MCP. The server description names it. */
  mcp?: boolean;
  handler(input: z.output<I>, ctx: CallContext): unknown;
}

type Definition<I extends InputSchema> = Omit<Capability<I>, "kind">;

/** A read capability: it changes nothing. */
export function defineRead<I extends InputSchema>(definition: Definition<I>): Capability {
  return { ...definition, kind: "read" } as unknown as Capability;
}

/** The input fields every write takes (contracts/surfaces.md, Data rules). */
export const writeFields = {
  dryRun: z.boolean().optional().describe("true: check and report the change, and save nothing."),
  idempotencyKey: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe("A repeat with the same key returns the first result and changes nothing."),
};

/**
 * A write capability. Adds dryRun and idempotencyKey to the input; the handler gets them and does what they say.
 * The output has changeId and summary (see writeResult).
 */
export function defineWrite<I extends InputSchema>(definition: Definition<I>): Capability {
  return { ...definition, kind: "write", input: definition.input.extend(writeFields) } as unknown as Capability;
}

// ---------- shared schema pieces ----------

/** limit and cursor, for a list input: z.object({ ...listInput(), ... }). */
export function listInput(options: { limit?: number; max?: number } = {}) {
  const max = options.max ?? 500;
  const limit = Math.min(options.limit ?? 50, max);
  return {
    limit: z.number().int().min(1).max(max).default(limit).describe(`Items per page, default ${limit}, at most ${max}.`),
    cursor: z.string().min(1).max(500).optional().describe("The next value of the previous page."),
  };
}

/** A list output: { items, next }. next is null on the last page. */
export function listOutput<T extends z.ZodType>(item: T) {
  return z.object({ items: z.array(item), next: z.string().nullable() });
}

/** A write output: changeId, summary (one sentence for people), and the fields of the capability. */
export function writeResult<S extends z.ZodRawShape>(shape: S = {} as S) {
  return z.object({ changeId: z.string().nullable(), summary: z.string(), ...shape });
}

/** A reference to a record in another app: { app, kind, id }. */
export const recordRef = z.object({
  app: z.string().regex(/^[a-z][a-z0-9]*$/),
  kind: z.string().min(1),
  id: z.string().min(1),
});

export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("A local date, YYYY-MM-DD.");
export const isoTime = z.iso.datetime().describe("ISO 8601 in UTC with Z.");
export const currencyCode = z.string().regex(/^[A-Z]{3}$/).describe("ISO 4217 code, for example NOK.");
export const amountMinor = z.number().int().describe("An amount in minor units of the currency.");

// ---------- the registry ----------

const APP = /^[a-z][a-z0-9]*$/;
const SEGMENT = "[a-z][a-z0-9]*";

export interface RegistryOptions {
  /** The app id from contracts/storage.md, for example photos. */
  app: string;
  /** The display name, for example Memex Photos. */
  name: string;
  version: string;
  capabilities: Capability[];
}

export interface InvokeOptions {
  origin: Origin;
  /** The file store of the running app. Without one, upload() and file() fail with unavailable. */
  files?: FileStore;
}

export interface Registry {
  app: string;
  name: string;
  version: string;
  capabilities: readonly Capability[];
  get(id: string): Capability | undefined;
  /** Parses the input and runs a capability. Throws SurfaceError (invalid_input for a bad input), or the handler's error. */
  invoke(id: string, input: unknown, options: InvokeOptions): Promise<unknown>;
}

/** The MCP tool name of a capability id: the dots become underscores. */
export const toolName = (id: string) => id.replace(/\./g, "_");

/** Whether a string is a capability id of the app: <app>.<noun>.<verb>. */
export function isCapabilityId(id: string, app: string): boolean {
  return new RegExp(`^${app}\\.${SEGMENT}\\.${SEGMENT}$`).test(id);
}

/** A failed parse of a call's input as invalid_input with the first wrong field. */
function invalidInput(error: z.ZodError): SurfaceError {
  const first = error.issues[0];
  const keys = first?.code === "unrecognized_keys" ? first.keys : [];
  const field = [...(first?.path.map(String) ?? []), ...keys.slice(0, 1)].join(".") || undefined;
  const more = error.issues.length > 1 ? ` (${error.issues.length - 1} more)` : "";
  return new SurfaceError("invalid_input", `${field ? `${field}: ` : ""}${first?.message ?? "Invalid input."}${more}`, {
    field,
    hint: "The input schema is in the tool definition, `capabilities --json`, or GET /api/v1/openapi.json.",
  });
}

export function createRegistry(options: RegistryOptions): Registry {
  const { app, name, version } = options;
  if (!APP.test(app)) throw new Error(`The app id ${app} must be lower case letters and digits, for example photos.`);
  const byId = new Map<string, { cap: Capability; input: InputSchema }>();
  for (const cap of options.capabilities) {
    if (!isCapabilityId(cap.id, app)) throw new Error(`Capability id ${cap.id} must be ${app}.<noun>.<verb>, for example ${app}.items.list.`);
    if (byId.has(cap.id)) throw new Error(`Capability ${cap.id} is defined twice.`);
    if (!(cap.input instanceof z.ZodObject)) throw new Error(`Capability ${cap.id} needs a z.object input.`);
    if (cap.description.length > 600) throw new Error(`The description of ${cap.id} is longer than 600 characters.`);
    // An unknown field is an error, so that an agent learns which fields there are.
    byId.set(cap.id, { cap, input: cap.input.strict() });
  }

  const run = async (id: string, input: unknown, invoke: InvokeOptions, used: Set<string>): Promise<unknown> => {
    const entry = byId.get(id);
    if (!entry) {
      throw new SurfaceError("unknown_capability", `There is no capability ${id}.`, {
        hint: `GET /api/v1 or \`memex-${app} capabilities\` lists them.`,
      });
    }
    const { cap } = entry;
    const result = entry.input.safeParse(input ?? {});
    if (!result.success) {
      const unknown = result.error.issues.find((i) => i.code === "unrecognized_keys" && i.path.length === 0);
      if (unknown?.code === "unrecognized_keys") {
        throw new SurfaceError("invalid_input", `${cap.id} has no field ${unknown.keys.map((k) => `"${k}"`).join(", ")}.`, {
          field: unknown.keys[0],
          hint: `Fields: ${Object.keys(cap.input.shape).join(", ") || "none"}.`,
        });
      }
      throw invalidInput(result.error);
    }
    const files = invoke.files;
    const noFiles = () =>
      new SurfaceError("unavailable", "Files need the running app.", { hint: `Start it with \`memex-${app} open\`, or call it over HTTP.` });
    const ctx: CallContext = {
      app,
      origin: invoke.origin,
      call: (other, otherInput) => run(other, otherInput, invoke, used) as Promise<never>,
      upload(uploadId) {
        if (!files) throw noFiles();
        const file = files.getUpload(uploadId);
        if (!file) {
          throw new SurfaceError("invalid_input", `There is no upload ${uploadId}.`, {
            field: "uploadId",
            hint: "Send the file to POST /api/v1/uploads again; an upload lasts one hour and one call.",
          });
        }
        used.add(uploadId);
        return file;
      },
      file(data, mediaType) {
        if (!files) throw noFiles();
        return files.addFile(data, mediaType);
      },
    };
    return cap.handler(result.data, ctx);
  };

  return {
    app,
    name,
    version,
    capabilities: options.capabilities,
    get: (id) => byId.get(id)?.cap,
    async invoke(id, input, invoke) {
      const used = new Set<string>();
      try {
        return await run(id, input, invoke, used);
      } finally {
        for (const uploadId of used) invoke.files?.removeUpload(uploadId);
      }
    },
  };
}
