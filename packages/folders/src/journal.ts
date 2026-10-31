import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { FolderListingError } from "./errors.js";

/** What the journal remembers of one file: the facts it was last seen with (contracts/folder-scan.md, Journal). */
export interface JournalEntry {
  /** Stable for the life of the file in this folder, also across moves and renames. */
  id: string;
  /** Relative to the root, "/" separators, as last seen. */
  path: string;
  size: number;
  modifiedMs: number;
  fileId: string | null;
  volumeId: string | null;
  availability: "local" | "online-only";
  /** "missing": not at its path in the last complete listing of its folder. */
  state: "present" | "missing";
  /** The content hash the app recorded for this file (lowercase hex), or null. The scan never computes it itself. */
  contentHash: string | null;
  firstSeenMs: number;
  /** When the scan first saw the current size and modification time. */
  changedMs: number;
  /** When a scan last saw the file at its path. */
  seenMs: number;
  stateChangedMs: number;
}

export const JOURNAL_FORMAT = "memex.folder-journal/1";

export interface JournalFile {
  format: typeof JOURNAL_FORMAT;
  /** The absolute root the journal belongs to. */
  root: string;
  /** When the last scan was applied, or null. */
  scannedMs: number | null;
  entries: JournalEntry[];
}

export function newEntryId(): string {
  return `f_${randomUUID().replaceAll("-", "")}`;
}

export function emptyJournal(root: string): JournalFile {
  return { format: JOURNAL_FORMAT, root, scannedMs: null, entries: [] };
}

/** Reads a journal file. A missing file is an empty journal; another format or root is an error. */
export async function readJournal(file: string, root: string): Promise<JournalFile> {
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyJournal(root);
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new FolderListingError("invalid-journal", `The journal ${file} is not JSON.`);
  }
  const j = parsed as Partial<JournalFile>;
  if (j.format !== JOURNAL_FORMAT || !Array.isArray(j.entries) || typeof j.root !== "string") {
    throw new FolderListingError("invalid-journal", `The journal ${file} is not a ${JOURNAL_FORMAT} file.`);
  }
  if (j.root !== root) {
    throw new FolderListingError("invalid-journal", `The journal ${file} belongs to ${j.root}, not ${root}.`);
  }
  return { format: JOURNAL_FORMAT, root: j.root, scannedMs: j.scannedMs ?? null, entries: j.entries };
}

/** Writes a journal file whole: to a temporary file in the same folder, then a rename. */
export async function writeJournal(file: string, journal: JournalFile): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(journal)}\n`, "utf8");
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}
