import { randomBytes } from "node:crypto";
import path from "node:path";

export const KNOWN_DOMAINS = [
  "messages",
  "calls",
  "mail",
  "contacts",
  "calendar",
  "reminders",
  "notes",
  "voicememos",
  "code-sessions",
  "location",
  "health",
  "social",
  "finance",
] as const;

export const IMPORTS_DIR = "imports";
export const PACKS_DIR = "packs";
export const DATABASES_DIR = "databases";
export const STATUS_FILE = "status.json";
export const INDEX_FILE = "index.jsonl";
export const README_FILE = "README.md";
export const DEFAULT_STREAM = "records";

const SEGMENT = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const RUN_ID = /^(\d{4})\d{4}T\d{6}Z-[0-9a-f]{8}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const EXTENSION = /^[a-z0-9]{1,16}$/;

export class ArchiveError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ArchiveError";
    this.code = code;
  }
}

export function isSegment(value: string): boolean {
  return SEGMENT.test(value) && value !== "." && value !== "..";
}

export function assertSegment(name: string, value: string): void {
  if (!isSegment(value)) {
    throw new ArchiveError("invalid-segment", `${name} must match [a-z0-9][a-z0-9._-]{0,63}: ${JSON.stringify(value)}`);
  }
}

export interface SourceRef {
  domain: string;
  source: string;
  device: string;
}

/** <root>/<domain>/<source>/<device>. */
export function sourceDir(root: string, ref: SourceRef): string {
  assertSegment("domain", ref.domain);
  assertSegment("source", ref.source);
  assertSegment("device", ref.device);
  if (ref.domain === IMPORTS_DIR) throw new ArchiveError("invalid-segment", "imports is not a domain");
  return path.join(root, ref.domain, ref.source, ref.device);
}

/** <root>/imports/<yyyy-mm-dd>-<name>. */
export function importDir(root: string, ref: { date: string; name: string }): string {
  if (!DATE.test(ref.date)) throw new ArchiveError("invalid-date", `date must be yyyy-mm-dd: ${ref.date}`);
  assertSegment("name", ref.name);
  return path.join(root, IMPORTS_DIR, `${ref.date}-${ref.name}`);
}

/**
 * <yyyymmdd>T<hhmmss>Z-<8 hex>, the UTC start time of the run and a random suffix.
 * With `after` (the source's latest run id), a run started in the same second gets a larger
 * suffix, so that the runs of one source still sort in the order they ran.
 */
export function newRunId(now: Date = new Date(), after?: string): string {
  const iso = now.toISOString(); // 2026-10-23T10:15:00.000Z
  const stamp = iso.slice(0, 19).replace(/[-:]/g, "") + "Z";
  let suffix = randomBytes(4).readUInt32BE(0);
  if (after !== undefined && isRunId(after) && after.slice(0, 16) === stamp) {
    const last = parseInt(after.slice(17), 16);
    if (suffix <= last) suffix = Math.min(last + 1 + (suffix % 0x10000), 0xffffffff);
  }
  return `${stamp}-${suffix.toString(16).padStart(8, "0")}`;
}

export function isRunId(value: string): boolean {
  return RUN_ID.test(value);
}

/** The year of a run id, which names its pack folder: packs/<yyyy>/. */
export function runYear(runId: string): string {
  const match = RUN_ID.exec(runId);
  if (match === null) throw new ArchiveError("invalid-run-id", `Not a run id: ${runId}`);
  return match[1]!;
}

/** The lowercase extension without the dot, "" when none. */
export function normalizeExtension(ext: string | undefined): string {
  if (ext === undefined || ext === "") return "";
  const e = ext.replace(/^\./, "").toLowerCase();
  if (!EXTENSION.test(e)) throw new ArchiveError("invalid-extension", `Not a usable file extension: ${JSON.stringify(ext)}`);
  return e;
}

/**
 * Checks a collector's relative path for a file: forward slashes, no leading slash, no empty,
 * "." or ".." segments, no backslashes or control characters.
 */
export function assertRelativePath(value: string): void {
  const bad =
    typeof value !== "string" ||
    value === "" ||
    /[\\\u0000-\u001f]/.test(value) ||
    value.split("/").some((part) => part === "" || part === "." || part === "..");
  if (bad) throw new ArchiveError("invalid-path", `Not a usable relative path: ${JSON.stringify(value)}`);
}
