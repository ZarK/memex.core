import fs from "node:fs/promises";
import path from "node:path";
import { writeFileClosed } from "./closed.js";
import { ArchiveError, STATUS_FILE } from "./layout.js";

export const STATUS_FORMAT = "memex.archive.status/1";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface RunCounts {
  read: number;
  written: number;
  unchanged: number;
  filtered: number;
  failed: number;
}

export interface FilteredRecord {
  id: string;
  reason: string;
}

export interface ArchiveStatus {
  format: typeof STATUS_FORMAT;
  domain: string;
  source: string;
  device: string;
  lastRun: {
    runId: string;
    startedAt: string;
    finishedAt: string;
    outcome: "success" | "failed";
    error: string | null;
    missingPermissions: string[];
    /** The pack files the run published, relative to the source folder. */
    packs: string[];
  };
  lastSuccess: { runId: string; finishedAt: string } | null;
  highWater: JsonValue;
  counts: RunCounts;
  filtered: FilteredRecord[];
}

const COUNT_KEYS = ["read", "written", "unchanged", "filtered", "failed"] as const;

export function emptyCounts(): RunCounts {
  return { read: 0, written: 0, unchanged: 0, filtered: 0, failed: 0 };
}

/**
 * The reasons a run cannot be a success (contracts/archive.md, Status file).
 * An empty list means the counts add up.
 */
export function countProblems(counts: RunCounts, filtered: readonly FilteredRecord[]): string[] {
  const problems: string[] = [];
  for (const key of COUNT_KEYS) {
    const value = counts[key];
    if (!Number.isInteger(value) || value < 0) problems.push(`counts.${key} must be a whole number of 0 or more`);
  }
  if (problems.length > 0) return problems;
  const sum = counts.written + counts.unchanged + counts.filtered + counts.failed;
  if (sum !== counts.read) {
    problems.push(
      `counts do not add up: read ${counts.read}, but written ${counts.written} + unchanged ${counts.unchanged} + filtered ${counts.filtered} + failed ${counts.failed} = ${sum}`,
    );
  }
  if (filtered.length !== counts.filtered) {
    problems.push(`counts.filtered is ${counts.filtered}, but ${filtered.length} filtered records are listed`);
  }
  if (counts.failed > 0) problems.push(`${counts.failed} records failed`);
  return problems;
}

export interface RunReport {
  domain: string;
  source: string;
  device: string;
  runId: string;
  startedAt: string;
  finishedAt?: string;
  counts: RunCounts;
  filtered?: FilteredRecord[];
  /** The new resume point. Used only when the run succeeds. Omit to keep the earlier one. */
  highWater?: JsonValue;
  error?: string | null;
  missingPermissions?: string[];
  /** The pack files the run published, relative to the source folder. */
  packs?: string[];
}

/**
 * The status after a run. A run succeeds only when its counts add up, nothing failed, no error was
 * reported, and no permission is missing. A failed run keeps the earlier lastSuccess and highWater.
 */
export function nextStatus(previous: ArchiveStatus | null, report: RunReport): ArchiveStatus {
  const filtered = report.filtered ?? [];
  const missingPermissions = report.missingPermissions ?? [];
  const problems = countProblems(report.counts, filtered);
  if (missingPermissions.length > 0) problems.push(`missing permissions: ${missingPermissions.join(", ")}`);
  const reportedError = report.error ?? null;
  const success = problems.length === 0 && reportedError === null;
  const finishedAt = report.finishedAt ?? new Date().toISOString();
  const error = success ? null : [reportedError, ...problems].filter((e) => e !== null).join("; ");

  return {
    format: STATUS_FORMAT,
    domain: report.domain,
    source: report.source,
    device: report.device,
    lastRun: {
      runId: report.runId,
      startedAt: report.startedAt,
      finishedAt,
      outcome: success ? "success" : "failed",
      error,
      missingPermissions,
      packs: [...(report.packs ?? [])],
    },
    lastSuccess: success ? { runId: report.runId, finishedAt } : previous?.lastSuccess ?? null,
    highWater: success && report.highWater !== undefined ? report.highWater : previous?.highWater ?? null,
    counts: { ...report.counts },
    filtered: filtered.map((f) => ({ id: f.id, reason: f.reason })),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Checks the shape of a parsed status file. Returns the problems found. */
export function statusProblems(value: unknown): string[] {
  if (!isObject(value)) return ["not a JSON object"];
  const problems: string[] = [];
  if (value.format !== STATUS_FORMAT) problems.push(`format is ${JSON.stringify(value.format)}, not ${STATUS_FORMAT}`);
  for (const key of ["domain", "source", "device"]) {
    if (typeof value[key] !== "string") problems.push(`${key} is missing`);
  }
  const lastRun = value.lastRun;
  if (!isObject(lastRun)) {
    problems.push("lastRun is missing");
  } else {
    for (const key of ["runId", "startedAt", "finishedAt"]) {
      if (typeof lastRun[key] !== "string") problems.push(`lastRun.${key} is missing`);
    }
    if (lastRun.outcome !== "success" && lastRun.outcome !== "failed") problems.push("lastRun.outcome is not success or failed");
    if (!Array.isArray(lastRun.packs) || lastRun.packs.some((p) => typeof p !== "string")) problems.push("lastRun.packs is not a list of paths");
  }
  const lastSuccess = value.lastSuccess;
  if (lastSuccess !== null && !(isObject(lastSuccess) && typeof lastSuccess.finishedAt === "string")) {
    problems.push("lastSuccess is not null or { runId, finishedAt }");
  }
  if (!("highWater" in value)) problems.push("highWater is missing");
  const counts = value.counts;
  if (!isObject(counts)) {
    problems.push("counts is missing");
  } else if (!Array.isArray(value.filtered)) {
    problems.push("filtered is not a list");
  } else {
    const c = Object.fromEntries(COUNT_KEYS.map((k) => [k, counts[k]])) as unknown as RunCounts;
    const listProblems = countProblems(c, value.filtered as FilteredRecord[]);
    // A failed run may record counts that do not add up; a successful one may not.
    if (isObject(lastRun) && lastRun.outcome === "success") problems.push(...listProblems);
    else problems.push(...listProblems.filter((p) => p.startsWith("counts.") && p.includes("whole number")));
  }
  return problems;
}

export class ArchiveStatusError extends ArchiveError {
  constructor(file: string, problems: string[]) {
    super("invalid-status", `${file}: ${problems.join("; ")}`);
    this.name = "ArchiveStatusError";
  }
}

export function statusPath(dir: string): string {
  return path.join(dir, STATUS_FILE);
}

/** Reads status.json of a source folder. Returns null when there is none. Throws on an invalid file. */
export async function readStatus(dir: string): Promise<ArchiveStatus | null> {
  const file = statusPath(dir);
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new ArchiveStatusError(file, [`not valid JSON: ${(error as Error).message}`]);
  }
  const problems = statusProblems(value);
  if (problems.length > 0) throw new ArchiveStatusError(file, problems);
  return value as ArchiveStatus;
}

/** Writes status.json of a source folder with a closed write. */
export async function writeStatus(dir: string, status: ArchiveStatus): Promise<void> {
  const problems = statusProblems(status);
  if (problems.length > 0) throw new ArchiveStatusError(statusPath(dir), problems);
  await writeFileClosed(statusPath(dir), JSON.stringify(status, null, 2) + "\n");
}

/** Applies a run report to status.json: reads the earlier status, computes the next one, writes it. */
export async function recordRun(dir: string, report: RunReport): Promise<ArchiveStatus> {
  const previous = await readStatus(dir);
  const status = nextStatus(previous, report);
  await writeStatus(dir, status);
  return status;
}

/** Whether a source is stale: no success yet, or the last success is older than staleDays. */
export function isStale(status: ArchiveStatus | null, staleDays: number, now: Date = new Date()): boolean {
  if (status === null || status.lastSuccess === null) return true;
  const finished = Date.parse(status.lastSuccess.finishedAt);
  if (Number.isNaN(finished)) return true;
  return now.getTime() - finished > staleDays * 24 * 60 * 60 * 1000;
}
