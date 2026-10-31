import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { writeClosedWith } from "./closed.js";
import { importFolder } from "./import.js";
import { indexLines, readIndex, rebuildIndex, writeIndex, type ArchiveIndex } from "./index-file.js";
import { acquireRunLock } from "./lock.js";
import { resolveArchiveRoot } from "./paths.js";
import { initArchive } from "./run.js";
import { DEFAULT_STALE_DAYS, checkArchive, listSources, type SourceEntry } from "./scan.js";
import { openFileVersion } from "./version.js";

const USAGE = `Usage:
  memex-archive init   [--root <dir>]
  memex-archive status [--root <dir>] [--json] [--stale-days N]
  memex-archive check  [--root <dir>] [--json] [--stale-days N]
  memex-archive ls     <source-folder> [--type file|item|attachment|database|records] [--grep <text>] [--json]
  memex-archive cat    <source-folder> <id> [--run <run-id>] [--out <file>]
  memex-archive index  <source-folder> [--rebuild]
  memex-archive import <folder> --name <name> [--date <yyyy-mm-dd>] [--root <dir>]

The root is --root, then MEMEX_ARCHIVE_HOME, then MEMEX_HOME/Archive, then ~/Memex/Archive.
A source folder is a path, or a path under the root such as code-sessions/editor/main-pc.
import stores every file of a folder whole in imports/<date>-<name>/ (the date defaults to today).
It follows no links, never changes the folder, and refuses a second import with the same date and name.`;

class UsageError extends Error {}

/** The positional arguments each command takes. */
const POSITIONALS: Record<string, number> = { init: 0, status: 0, check: 0, ls: 1, cat: 2, index: 1, import: 1 };

async function isFolder(dir: string): Promise<boolean> {
  try {
    return (await fs.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

function staleDays(value: string | undefined): number {
  if (value === undefined) return DEFAULT_STALE_DAYS;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new UsageError(`--stale-days must be a number of 0 or more: ${value}`);
  return n;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = -1;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

function describe(s: SourceEntry): string {
  const state = s.statusError
    ? "invalid status"
    : s.status === null
      ? "no status"
      : s.status.lastRun.outcome === "failed"
        ? "FAILING"
        : s.kind === "source" && s.stale
          ? "STALE"
          : "ok";
  const last = s.status?.lastSuccess?.finishedAt ?? "never";
  return `${state.padEnd(14)} ${s.path}  last success: ${last}  packs: ${s.packs}  size: ${formatBytes(s.bytes)}`;
}

/** A source folder: the path as given when it is a folder, else the path under the root. */
async function sourceFolder(root: string, value: string): Promise<string> {
  const given = path.resolve(value);
  if (await isFolder(given)) return given;
  const underRoot = path.join(root, ...value.split(/[\\/]/));
  if (await isFolder(underRoot)) return underRoot;
  throw new UsageError(`No source folder ${value} (looked at ${given} and ${underRoot})`);
}

async function requireIndex(dir: string): Promise<ArchiveIndex> {
  const index = await readIndex(dir);
  if (index === null) throw new Error(`No index.jsonl in ${dir}; run memex-archive index --rebuild`);
  return index;
}

function lineKey(line: { type: string } & Record<string, unknown>): string {
  return String(line.id ?? line.sha256 ?? line.name ?? `${String(line.run)} ${String(line.entry)}`);
}

export async function main(
  argv: string[],
  out: (line: string) => void = console.log,
  write: (data: Uint8Array) => Promise<void> = (data) =>
    new Promise((resolve, reject) => process.stdout.write(data, (error) => (error ? reject(error) : resolve()))),
): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    out(USAGE);
    return command === undefined ? 2 : 0;
  }
  let values: {
    root?: string;
    json?: boolean;
    "stale-days"?: string;
    type?: string;
    grep?: string;
    run?: string;
    out?: string;
    rebuild?: boolean;
    name?: string;
    date?: string;
  };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: rest,
      options: {
        root: { type: "string" },
        json: { type: "boolean" },
        "stale-days": { type: "string" },
        type: { type: "string" },
        grep: { type: "string" },
        run: { type: "string" },
        out: { type: "string" },
        rebuild: { type: "boolean" },
        name: { type: "string" },
        date: { type: "string" },
      },
      allowPositionals: true,
      strict: true,
    }));
    const expected = POSITIONALS[command];
    if (expected !== undefined && positionals.length !== expected) {
      throw new Error(`${command} takes ${expected} arguments, not ${positionals.length}`);
    }
  } catch (error) {
    out((error as Error).message);
    out(USAGE);
    return 2;
  }
  try {
    const root = resolveArchiveRoot({ flag: values.root === undefined ? undefined : path.resolve(values.root) });
    switch (command) {
      case "init": {
        const { created } = await initArchive(root);
        out(values.json ? JSON.stringify({ root, created }) : `${created ? "Created" : "Exists"}: ${root}`);
        return 0;
      }
      case "status": {
        const days = staleDays(values["stale-days"]);
        if (!(await isFolder(root))) {
          out(`The archive root does not exist: ${root}. Run memex-archive init.`);
          return 1;
        }
        const sources = await listSources(root, { staleDays: days });
        if (values.json) {
          out(
            JSON.stringify(
              {
                root,
                staleDays: days,
                sources: sources.map((s) => ({
                  kind: s.kind,
                  path: s.path,
                  stale: s.kind === "source" ? s.stale : false,
                  failing: s.failing,
                  packs: s.packs,
                  bytes: s.bytes,
                  statusError: s.statusError,
                  status: s.status,
                })),
              },
              null,
              2,
            ),
          );
        } else {
          out(`Archive: ${root}`);
          if (sources.length === 0) out("No sources yet.");
          for (const s of sources) out(describe(s));
        }
        return 0;
      }
      case "check": {
        const result = await checkArchive(root, { staleDays: staleDays(values["stale-days"]) });
        if (values.json) {
          out(JSON.stringify({ ok: result.ok, root, problems: result.problems }, null, 2));
        } else {
          out(`Archive: ${root}`);
          for (const p of result.problems) out(`${p.kind.padEnd(24)} ${p.path}  ${p.message}`);
          out(result.ok ? `OK: ${result.sources.length} sources, no problems.` : `${result.problems.length} problems.`);
        }
        return result.ok ? 0 : 1;
      }
      case "ls": {
        const dir = await sourceFolder(root, positionals[0]!);
        const types = ["file", "item", "attachment", "database", "records"];
        if (values.type !== undefined && !types.includes(values.type)) throw new UsageError(`--type must be one of ${types.join(", ")}`);
        const grep = values.grep?.toLowerCase();
        const lines = (indexLines(await requireIndex(dir)).slice(1) as Array<{ type: string } & Record<string, unknown>>).filter(
          (l) => (values.type === undefined || l.type === values.type) && (grep === undefined || JSON.stringify(l).toLowerCase().includes(grep)),
        );
        if (values.json) {
          out(JSON.stringify(lines, null, 2));
        } else {
          for (const l of lines) {
            const size = typeof l.size === "number" ? formatBytes(l.size) : "";
            const meta = l.meta ? `  ${JSON.stringify(l.meta)}` : "";
            out(`${l.type.padEnd(11)} ${lineKey(l)}  ${size}${meta}`.trimEnd());
          }
        }
        return 0;
      }
      case "cat": {
        const dir = await sourceFolder(root, positionals[0]!);
        // Streamed, so a file of many GB is never held in memory. With --out, a file whose SHA-256
        // does not match is not renamed into place.
        const data = await openFileVersion(dir, positionals[1]!, { run: values.run });
        if (values.out !== undefined) {
          await writeClosedWith(path.resolve(values.out), async (handle) => {
            await handle.writeFile(data);
          });
        } else {
          for await (const chunk of data) await write(chunk);
        }
        return 0;
      }
      case "index": {
        const dir = await sourceFolder(root, positionals[0]!);
        if (values.rebuild) {
          // The run lock keeps a run from writing the index at the same time.
          const lock = await acquireRunLock(dir);
          try {
            const index = await rebuildIndex(dir);
            await writeIndex(dir, index);
            out(`Rebuilt ${dir}: ${index.source.packs.length} packs, ${index.files.length} files, ${index.attachments.length} attachments`);
          } finally {
            await lock.release();
          }
          return 0;
        }
        for (const line of indexLines(await requireIndex(dir))) out(JSON.stringify(line));
        return 0;
      }
      case "import": {
        if (values.name === undefined) throw new UsageError("import needs --name <name>");
        const result = await importFolder({ root, folder: positionals[0]!, name: values.name, date: values.date });
        if (values.json) {
          const { status, ...rest } = result;
          out(JSON.stringify({ ...rest, outcome: status.lastRun.outcome, error: status.lastRun.error }, null, 2));
        } else {
          out(`Imported ${path.resolve(positionals[0]!)} into ${result.dir}`);
          out(`Files: ${result.files} (${formatBytes(result.bytes)})  packs: ${result.packs.length}  skipped: ${result.skipped.length}  failed: ${result.failed.length}`);
          for (const s of result.skipped) out(`skipped  ${s.id}  ${s.reason}`);
          for (const f of result.failed) out(`failed   ${f.id}  ${f.error}`);
          if (!result.ok) out(`Outcome: failed. ${result.status.lastRun.error ?? ""}`.trimEnd());
        }
        // A failed run can have no failed file (the packs could not be published): the outcome decides.
        return result.ok ? 0 : 1;
      }
      default:
        out(`Unknown command: ${command}`);
        out(USAGE);
        return 2;
    }
  } catch (error) {
    if (error instanceof UsageError) {
      out(error.message);
      return 2;
    }
    out(`Error: ${(error as Error).message}`);
    return 1;
  }
}
