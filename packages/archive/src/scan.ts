import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { PARTIAL_SUFFIX } from "./closed.js";
import { readIndex, type ArchiveIndex } from "./index-file.js";
import { DATABASES_DIR, IMPORTS_DIR, INDEX_FILE, STATUS_FILE, isSegment } from "./layout.js";
import { MANIFEST_ENTRY, listPacks, openPack, type PackInfo, type PackManifest } from "./pack.js";
import { isStale, readStatus, type ArchiveStatus } from "./status.js";

export const DEFAULT_STALE_DAYS = 3;

export interface SourceEntry {
  kind: "source" | "import";
  /** Relative to the root, with forward slashes: messages/imessage/mac-mini or imports/2026-10-23-takeout. */
  path: string;
  dir: string;
  status: ArchiveStatus | null;
  /** Set when status.json exists but cannot be read. */
  statusError: string | null;
  stale: boolean;
  failing: boolean;
  /** The number of pack files. */
  packs: number;
  /** The size of the packs and database snapshots on disk. */
  bytes: number;
}

async function listDirs(dir: string): Promise<Dirent[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory() && !e.name.startsWith("."));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function entry(
  root: string,
  kind: SourceEntry["kind"],
  parts: string[],
  staleDays: number,
  now: Date,
): Promise<SourceEntry> {
  const dir = path.join(root, ...parts);
  let status: ArchiveStatus | null = null;
  let statusError: string | null = null;
  try {
    status = await readStatus(dir);
  } catch (error) {
    statusError = (error as Error).message;
  }
  const packs = await listPacks(dir);
  let bytes = packs.reduce((total, p) => total + p.bytes, 0);
  await walk(path.join(dir, DATABASES_DIR), async (file) => {
    if (!file.endsWith(PARTIAL_SUFFIX)) bytes += (await fs.stat(file)).size;
  });
  return {
    kind,
    path: parts.join("/"),
    dir,
    status,
    statusError,
    stale: isStale(status, staleDays, now),
    failing: statusError !== null || status?.lastRun.outcome === "failed",
    packs: packs.length,
    bytes,
  };
}

export interface ListOptions {
  staleDays?: number;
  now?: Date;
}

/** Every source folder (<domain>/<source>/<device>) and import folder under the root. */
export async function listSources(root: string, options: ListOptions = {}): Promise<SourceEntry[]> {
  const staleDays = options.staleDays ?? DEFAULT_STALE_DAYS;
  const now = options.now ?? new Date();
  const out: SourceEntry[] = [];
  for (const domain of await listDirs(root)) {
    if (domain.name === IMPORTS_DIR) {
      for (const imp of await listDirs(path.join(root, IMPORTS_DIR))) {
        out.push(await entry(root, "import", [IMPORTS_DIR, imp.name], staleDays, now));
      }
      continue;
    }
    for (const source of await listDirs(path.join(root, domain.name))) {
      for (const device of await listDirs(path.join(root, domain.name, source.name))) {
        out.push(await entry(root, "source", [domain.name, source.name, device.name], staleDays, now));
      }
    }
  }
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

export interface Problem {
  path: string;
  kind:
    | "missing-root"
    | "invalid-name"
    | "missing-status"
    | "invalid-status"
    | "status-mismatch"
    | "failing"
    | "stale"
    | "partial-file"
    | "invalid-pack"
    | "missing-index"
    | "invalid-index"
    | "index-mismatch";
  message: string;
}

export interface CheckResult {
  ok: boolean;
  root: string;
  sources: SourceEntry[];
  problems: Problem[];
}

async function walk(dir: string, visit: (file: string, dirent: Dirent) => Promise<void> | void): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walk(full, visit);
    else await visit(full, e);
  }
}

function rel(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join("/");
}

/** The manifest entries that the index does not describe. */
function unindexed(manifest: PackManifest, pack: PackInfo, index: ArchiveIndex): string[] {
  const key = (...parts: string[]) => JSON.stringify(parts);
  const revisions = new Set(index.files.flatMap((f) => f.revisions.map((r) => key(f.id, r.run, r.file, r.entry))));
  const attachments = new Set(index.attachments.map((a) => a.sha256));
  const records = new Set(index.records.map((r) => key(r.run, r.file, r.entry)));
  const items = new Set(index.items.map((i) => i.id));
  const missing: string[] = [];
  for (const e of manifest.entries) {
    const found =
      e.kind === "full" || e.kind === "append"
        ? revisions.has(key(e.id, manifest.runId, pack.file, e.entry))
        : e.kind === "attachment"
          ? attachments.has(e.sha256)
          : e.kind === "records"
            ? records.has(key(manifest.runId, pack.file, e.entry))
            : items.has(e.id);
    if (!found) missing.push("entry" in e ? e.entry : `item ${e.id}`);
  }
  return missing;
}

/** Checks the packs of a source folder against their own zip entries and against the index. */
async function checkPacks(s: SourceEntry, problems: Problem[]): Promise<void> {
  const packs = await listPacks(s.dir);
  let index: ArchiveIndex | null = null;
  try {
    index = await readIndex(s.dir);
  } catch (error) {
    problems.push({ path: `${s.path}/${INDEX_FILE}`, kind: "invalid-index", message: (error as Error).message });
    return;
  }
  if (index === null) {
    if (packs.length > 0) problems.push({ path: s.path, kind: "missing-index", message: `${packs.length} packs but no ${INDEX_FILE}; run memex-archive index --rebuild` });
    return;
  }
  const listed = new Set(index.source.packs.map((p) => p.file));
  for (const p of packs) {
    const where = `${s.path}/${p.file}`;
    let manifest: PackManifest;
    let names: Set<string>;
    try {
      const pack = await openPack(p.path);
      manifest = pack.manifest;
      names = new Set(pack.entries.map((e) => e.name));
    } catch (error) {
      problems.push({ path: where, kind: "invalid-pack", message: (error as Error).message });
      continue;
    }
    const described = manifest.entries.flatMap((e) => ("entry" in e ? [e.entry] : []));
    const wrong: string[] = [];
    if (manifest.runId !== p.runId || manifest.part !== p.part) wrong.push(`the manifest names run ${manifest.runId} part ${manifest.part}`);
    const absent = described.filter((name) => !names.has(name));
    if (absent.length > 0) wrong.push(`${absent.length} manifest entries are missing from the zip, for example ${absent[0]}`);
    const extra = [...names].filter((name) => name !== MANIFEST_ENTRY && !described.includes(name));
    if (extra.length > 0) wrong.push(`${extra.length} zip entries are not in the manifest, for example ${extra[0]}`);
    if (wrong.length > 0) problems.push({ path: where, kind: "invalid-pack", message: wrong.join("; ") });
    if (!listed.has(p.file)) {
      problems.push({ path: where, kind: "index-mismatch", message: `${INDEX_FILE} does not list this pack; run memex-archive index --rebuild` });
      continue;
    }
    const missing = unindexed(manifest, p, index);
    if (missing.length > 0) {
      problems.push({ path: where, kind: "index-mismatch", message: `${INDEX_FILE} does not describe ${missing.length} entries, for example ${missing[0]}` });
    }
  }
}

/**
 * Checks the archive: status files, pack files (readable, manifest matches the zip and the
 * index), leftover .partial files, staleness, and failures. It does not read every entry to verify
 * copies.
 */
export async function checkArchive(root: string, options: ListOptions = {}): Promise<CheckResult> {
  const problems: Problem[] = [];
  try {
    const stat = await fs.stat(root);
    if (!stat.isDirectory()) throw new Error("not a folder");
  } catch {
    return {
      ok: false,
      root,
      sources: [],
      problems: [{ path: ".", kind: "missing-root", message: `The archive root does not exist: ${root}` }],
    };
  }
  const staleDays = options.staleDays ?? DEFAULT_STALE_DAYS;
  const sources = await listSources(root, options);

  for (const s of sources) {
    const parts = s.path.split("/");
    const names = s.kind === "import" ? [parts[1]!] : parts;
    const badName =
      s.kind === "import" ? !/^\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9._-]{0,63}$/.test(names[0]!) : names.some((n) => !isSegment(n));
    if (badName) {
      problems.push({ path: s.path, kind: "invalid-name", message: "Folder names must be lowercase [a-z0-9._-]" });
    }
    if (s.statusError !== null) {
      problems.push({ path: s.path, kind: "invalid-status", message: s.statusError });
    } else if (s.status === null) {
      problems.push({ path: s.path, kind: "missing-status", message: `No ${STATUS_FILE}` });
    } else {
      if (s.kind === "source") {
        const [domain, source, device] = parts;
        if (s.status.domain !== domain || s.status.source !== source || s.status.device !== device) {
          problems.push({
            path: s.path,
            kind: "status-mismatch",
            message: `${STATUS_FILE} names ${s.status.domain}/${s.status.source}/${s.status.device}`,
          });
        }
      }
      if (s.status.lastRun.outcome === "failed") {
        problems.push({ path: s.path, kind: "failing", message: `Last run failed: ${s.status.lastRun.error ?? "no reason given"}` });
      }
    }
    if (s.kind === "source" && s.stale && s.statusError === null) {
      const last = s.status?.lastSuccess?.finishedAt;
      problems.push({
        path: s.path,
        kind: "stale",
        message: last ? `No successful run since ${last} (more than ${staleDays} days)` : "No successful run yet",
      });
    }

    await walk(s.dir, (file) => {
      if (path.basename(file).endsWith(PARTIAL_SUFFIX)) {
        problems.push({ path: rel(root, file), kind: "partial-file", message: "An interrupted copy left this file" });
      }
    });
    await checkPacks(s, problems);
  }

  return { ok: problems.length === 0, root, sources, problems };
}
