import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { describeLocation, formatBytes } from "@tjalve/memex-storage";
import { FolderListingError } from "./errors.js";
import { emptyJournal, readJournal, writeJournal } from "./journal.js";
import { listFolder } from "./listing.js";
import { plan, type ImportPlan } from "./plan.js";
import { scanFolder, type ScanResult } from "./scan.js";
import type { FolderListing, ListedFile } from "./types.js";
import { watchFolder } from "./watch.js";

const USAGE = `Usage:
  memex-folders scan  <folder> [--plan] [--journal <file>] [--hash] [--include-hidden] [--settle-ms <ms>] [--json]
  memex-folders watch <folder> [--journal <file>] [--settle-ms <ms>] [--quiet-ms <ms>] [--periodic-ms <ms>] [--max-scans <n>]

scan lists the folder without reading or downloading any file and compares it with the journal (--journal, which
it then updates). --plan shows what an import would read and how much it would download, by provider.
--hash reads local files that may have moved, to prove the move by content; it never reads an online-only file.
--settle-ms: a file written or copied less than this long ago is settling (default 10000).
watch scans on start, after changes once the folder is quiet for --quiet-ms (default 10000), and every
--periodic-ms (default 30 minutes), and prints the counts of each scan.
The output has counts and sizes only, never file names. Exit 0 on success, 1 on an error, 2 on a usage error.`;

export interface CliIo {
  out?: (line: string) => void;
  err?: (line: string) => void;
}

function sha256(file: string): Promise<string | null> {
  return new Promise((resolve) => {
    const hash = createHash("sha256");
    createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")))
      .on("error", () => resolve(null));
  });
}

function n(value: number): string {
  return value.toLocaleString("en-US");
}

function countBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) out[key(item)] = (out[key(item)] ?? 0) + 1;
  return out;
}

function summary(listing: FolderListing): Record<string, unknown> {
  const onlineOnly = listing.files.filter((f) => f.onlineOnly);
  return {
    root: listing.root,
    fileSystem: listing.fileSystem,
    idReliability: listing.idReliability,
    ignoresCase: listing.ignoresCase,
    complete: listing.complete,
    elapsedMs: listing.elapsedMs,
    files: listing.files.length,
    bytes: listing.files.reduce((s, f) => s + f.size, 0),
    onlineOnlyFiles: onlineOnly.length,
    onlineOnlyBytes: onlineOnly.reduce((s, f) => s + f.size, 0),
    folders: listing.listedFolders.length,
    unlistedFolders: listing.unlistedFolders.length,
    skippedFolders: listing.skippedFolders.length,
    skippedFiles: listing.skippedFiles.length,
    links: listing.links.length,
    warnings: countBy(listing.warnings, (w) => w.code),
  };
}

function printScan(out: (line: string) => void, listing: FolderListing, scan: ScanResult, importPlan: ImportPlan | null): void {
  const s = summary(listing);
  const location = describeLocation(listing.root, { platform: process.platform, env: process.env, home: os.homedir() });
  out(`Folder: ${listing.root}`);
  out(`Location: ${location.kind}${location.provider !== null ? `, ${location.provider}` : ""}`);
  out(`File system: ${listing.fileSystem} (file ids ${listing.idReliability}), ${listing.ignoresCase ? "ignores case" : "case-sensitive"}`);
  out(
    `Listed: ${n(listing.files.length)} files, ${formatBytes(s.bytes as number)}, in ${n(listing.listedFolders.length)} folders in ${(listing.elapsedMs / 1000).toFixed(1)} s` +
      (listing.complete ? " (complete)" : ` (incomplete: ${n(listing.unlistedFolders.length)} folders not listed)`),
  );
  out(`Online-only: ${n(s.onlineOnlyFiles as number)} files, ${formatBytes(s.onlineOnlyBytes as number)}`);
  out(`Left out: ${n(listing.skippedFolders.length)} folders and ${n(listing.skippedFiles.length)} files (hidden, system, or name collisions), ${n(listing.links.length)} links not followed`);
  const warnings = Object.entries(s.warnings as Record<string, number>);
  if (warnings.length > 0) out(`Warnings: ${warnings.map(([code, c]) => `${code} ${n(c)}`).join(", ")}`);
  const c = scan.counts;
  out(
    `Scan: new ${n(c.new)}, unchanged ${n(c.unchanged)}, changed ${n(c.changed)}, moved ${n(c.moved)}, missing ${n(c.missing)}, found again ${n(c.foundAgain)}, settling ${n(c.settling)}, vanished ${n(c.vanished)}`,
  );
  if (importPlan === null) return;
  out(`Plan: read ${n(importPlan.read.files)} files, ${formatBytes(importPlan.read.bytes)}`);
  out(`  local: ${n(importPlan.local.files)} files, ${formatBytes(importPlan.local.bytes)} (nothing to download)`);
  out(`  online-only: ${n(importPlan.onlineOnly.files)} files, ${formatBytes(importPlan.onlineOnly.bytes)}`);
  for (const p of importPlan.onlineOnly.providers) out(`    ${p.provider ?? `no known provider (${p.root})`}: ${n(p.files)} files, ${formatBytes(p.bytes)}`);
  if (importPlan.settling.files > 0) out(`  settling (left for a later scan): ${n(importPlan.settling.files)} files, ${formatBytes(importPlan.settling.bytes)}`);
  out(importPlan.needsConfirmation ? `Ask before reading: ${importPlan.text}` : "No confirmation needed: nothing would be downloaded.");
}

async function scanOnce(folder: string, values: Record<string, unknown>): Promise<{ listing: FolderListing; scan: ScanResult }> {
  const listing = await listFolder(folder, { includeHidden: values["include-hidden"] === true });
  const journalFile = typeof values.journal === "string" ? path.resolve(values.journal) : null;
  const journal = journalFile === null ? emptyJournal(listing.root) : await readJournal(journalFile, listing.root);
  const p = listing.platform === "win32" ? path.win32 : path.posix;
  const hash =
    values.hash === true ? (f: ListedFile) => sha256(p.join(listing.root, ...f.path.split("/"))) : undefined;
  const settleMs = typeof values["settle-ms"] === "string" ? Number(values["settle-ms"]) : undefined;
  const scan = await scanFolder(listing, journal, { ...(hash ? { hash } : {}), ...(settleMs !== undefined ? { quietMs: settleMs } : {}) });
  if (journalFile !== null) await writeJournal(journalFile, scan.journal);
  return { listing, scan };
}

export async function main(argv: string[], io: CliIo = {}): Promise<number> {
  const out = io.out ?? ((line: string) => console.log(line));
  const err = io.err ?? ((line: string) => console.error(line));
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        plan: { type: "boolean" },
        journal: { type: "string" },
        hash: { type: "boolean" },
        "include-hidden": { type: "boolean" },
        "quiet-ms": { type: "string" },
        "settle-ms": { type: "string" },
        "periodic-ms": { type: "string" },
        "max-scans": { type: "string" },
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    err((error as Error).message);
    err(USAGE);
    return 2;
  }
  const { values, positionals } = parsed;
  const [command, folder] = positionals;
  if (values.help === true) {
    out(USAGE);
    return 0;
  }
  if ((command !== "scan" && command !== "watch") || folder === undefined || positionals.length !== 2) {
    err(USAGE);
    return 2;
  }
  const absolute = path.resolve(folder);
  try {
    if (command === "scan") {
      const { listing, scan } = await scanOnce(absolute, values);
      const importPlan = values.plan === true ? plan(scan) : null;
      if (values.json === true) {
        out(JSON.stringify({ listing: summary(listing), counts: scan.counts, renameCandidates: scan.renameCandidates.length, plan: importPlan }, null, 2));
      } else {
        printScan(out, listing, scan, importPlan);
      }
      return 0;
    }
    const maxScans = typeof values["max-scans"] === "string" ? Number(values["max-scans"]) : Number.POSITIVE_INFINITY;
    const periodicMs = typeof values["periodic-ms"] === "string" ? Number(values["periodic-ms"]) : undefined;
    const quietMs = typeof values["quiet-ms"] === "string" ? Number(values["quiet-ms"]) : undefined;
    let scans = 0;
    let running: Promise<void> = Promise.resolve();
    await new Promise<void>((resolve) => {
      const keepAlive = setInterval(() => undefined, 1 << 30);
      const finish = (): void => {
        w.close();
        clearInterval(keepAlive);
        resolve();
      };
      const w = watchFolder(absolute, {
        ...(quietMs !== undefined ? { quietMs } : {}),
        ...(periodicMs !== undefined ? { periodicMs } : {}),
        onScan: (reason) => {
          running = running
            .then(async () => {
              if (scans >= maxScans) return;
              scans++;
              const { scan } = await scanOnce(absolute, values);
              const c = scan.counts;
              out(
                `${new Date().toISOString()} ${reason} (${w.mode}): ${n(c.listed)} files; new ${n(c.new)}, unchanged ${n(c.unchanged)}, changed ${n(c.changed)}, moved ${n(c.moved)}, missing ${n(c.missing)}, settling ${n(c.settling)}`,
              );
              if (scans >= maxScans) finish();
            })
            .catch((error: unknown) => {
              err(error instanceof Error ? error.message : String(error));
              finish();
            });
        },
      });
      process.once("SIGINT", finish);
    });
    return 0;
  } catch (error) {
    if (error instanceof FolderListingError) {
      err(error.message);
      return 1;
    }
    throw error;
  }
}
