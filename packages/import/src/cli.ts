// The memex-import CLI: preview, commit, list, show, and undo imports into a
// SQLite database, with the readers of an app or an example given as a module.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { openDatabase, type SqliteDatabase } from "@tjalve/memex-sqlite";
import { nodeSqlite } from "@tjalve/memex-sqlite/node-sqlite";
import { digestData } from "./digest.js";
import { createImporter, ImportError } from "./importer.js";
import { batchesText, recordsText, reportText, undoText } from "./report.js";
import { setupImport } from "./schema.js";
import type { Reader } from "./types.js";

const USAGE = `memex-import: import files with an app's readers into a SQLite database.

  memex-import preview <folder or file>... --db <file> --readers <module> [--allow-online-only] [--include-hidden] [--reread] [--json]
  memex-import commit  <folder or file>... --db <file> --readers <module> [--allow-online-only] [--include-hidden] [--reread] [--json]
  memex-import batches --db <file> [--json]
  memex-import show    <batch-id> --db <file> [--json]
  memex-import undo    <batch-id> --db <file> [--json]
  memex-import digest  --db <file> [--readers <module>] [--json]

preview  runs the import in a transaction and rolls it back: it shows what commit would do and writes nothing.
commit   imports; each file is committed in its own transaction and recorded for undo.
undo     undoes every file of a batch, newest first, in one transaction.
digest   row counts and a SHA-256 of the data (not the import and change history), to compare states.

With --readers, every command first makes the app's tables, so that a digest before the first import covers them.
The readers module exports \`readers\` (an array of readers) and may export \`setup(db)\`, which makes the app's tables.
`;

interface Args {
  command: string;
  positional: string[];
  db?: string;
  readers?: string;
  json: boolean;
  allowOnlineOnly: boolean;
  includeHidden: boolean;
  reread: boolean;
}

function parseArgs(argv: string[]): Args | string {
  const args: Args = { command: argv[0] ?? "", positional: [], json: false, allowOnlineOnly: false, includeHidden: false, reread: false };
  for (let i = 1; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (a === "--db" || a === "--readers") {
      const value = argv[i + 1];
      if (!value) return `${a} needs a value.`;
      args[a === "--db" ? "db" : "readers"] = value;
      i += 1;
    } else if (a === "--json") args.json = true;
    else if (a === "--allow-online-only") args.allowOnlineOnly = true;
    else if (a === "--include-hidden") args.includeHidden = true;
    else if (a === "--reread") args.reread = true;
    else if (a.startsWith("--")) return `Unknown option ${a}.`;
    else args.positional.push(a);
  }
  return args;
}

interface ReadersModule {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readers: Reader<any>[];
  setup?: (db: SqliteDatabase) => void;
}

async function loadReaders(file: string): Promise<ReadersModule> {
  const mod = (await import(pathToFileURL(path.resolve(file)).href)) as Partial<ReadersModule> & { default?: Partial<ReadersModule> };
  const readers = mod.readers ?? mod.default?.readers;
  if (!Array.isArray(readers) || !readers.length) throw new ImportError("invalid-reader", `${file} exports no readers.`);
  const setup = mod.setup ?? mod.default?.setup;
  return { readers, ...(setup ? { setup } : {}) };
}

export async function main(argv: string[], out: (text: string) => void = (t) => process.stdout.write(t), err: (text: string) => void = (t) => process.stderr.write(t)): Promise<number> {
  const args = parseArgs(argv);
  if (typeof args === "string") {
    err(`${args}\n\n${USAGE}`);
    return 2;
  }
  if (!["preview", "commit", "batches", "show", "undo", "digest"].includes(args.command)) {
    err(args.command && args.command !== "help" && args.command !== "--help" ? `Unknown command ${args.command}.\n\n${USAGE}` : USAGE);
    return args.command === "help" || args.command === "--help" ? 0 : 2;
  }
  if (!args.db) {
    err(`--db is required.\n\n${USAGE}`);
    return 2;
  }
  const db = openDatabase(path.resolve(args.db), { driver: nodeSqlite });
  try {
    setupImport(db);
    // With --readers, the app's tables are made first for every command, so a digest covers them from the start.
    const mod = args.readers ? await loadReaders(args.readers) : null;
    mod?.setup?.(db);
    const print = (value: unknown, text: string) => out(args.json ? `${JSON.stringify(value, null, 2)}\n` : text);
    switch (args.command) {
      case "preview":
      case "commit": {
        if (!args.readers) {
          err(`--readers is required.\n\n${USAGE}`);
          return 2;
        }
        if (!args.positional.length) {
          err(`Name at least one folder or file.\n\n${USAGE}`);
          return 2;
        }
        const importer = createImporter(db, { readers: mod!.readers, origin: "cli" });
        // Ctrl+C stops the run after the file it is on, so a commit ends as a stopped batch that can be undone.
        const stop = new AbortController();
        const onSigint = () => stop.abort(new Error("The import was stopped with Ctrl+C."));
        process.once("SIGINT", onSigint);
        const options = {
          allowOnlineOnly: args.allowOnlineOnly,
          reread: args.reread,
          signal: stop.signal,
          ...(args.includeHidden ? { listing: { includeHidden: true } } : {}),
        };
        try {
          const report = args.command === "preview" ? await importer.preview(args.positional, options) : await importer.commit(args.positional, options);
          print(report, reportText(report));
          return report.accounted ? 0 : 3;
        } catch (error) {
          if (!stop.signal.aborted) throw error;
          err(
            args.command === "commit"
              ? "The import was stopped. The files committed before it stay; undo the batch to remove them (memex-import batches lists it).\n"
              : "The preview was stopped. Nothing was written.\n",
          );
          return 130;
        } finally {
          process.off("SIGINT", onSigint);
        }
      }
      case "batches": {
        const importer = createImporter(db, { readers: [] });
        const batches = importer.batches();
        print(batches, batchesText(batches));
        return 0;
      }
      case "show": {
        const id = args.positional[0];
        if (!id) {
          err(`Name a batch.\n\n${USAGE}`);
          return 2;
        }
        const found = createImporter(db, { readers: [] }).batch(id);
        if (!found) {
          err(`There is no import batch ${id}.\n`);
          return 1;
        }
        const text = [
          `Batch ${found.batch.id}: ${found.batch.state}, started ${found.batch.started_at}${found.batch.undone_at ? `, undone ${found.batch.undone_at}` : ""}`,
          ...found.files.map((f) => `  ${f.outcome.padEnd(12)} ${f.path}${f.reader ? ` [${f.reader}]` : ""}: ${f.outcome === "imported" || f.outcome === "unchanged" ? recordsText(f.records) : (f.reason ?? "")}`),
        ].join("\n");
        print(found, `${text}\n`);
        return 0;
      }
      case "undo": {
        const id = args.positional[0];
        if (!id) {
          err(`Name a batch.\n\n${USAGE}`);
          return 2;
        }
        const result = createImporter(db, { readers: [], origin: "cli" }).undo(id);
        print(result, undoText(result));
        return 0;
      }
      case "digest": {
        const digest = digestData(db);
        const text = `${Object.entries(digest.tables)
          .map(([t, c]) => `${t} ${c.toLocaleString("en-US")}`)
          .join(", ")}\nsha256 ${digest.hash}\n`;
        print(digest, text);
        return 0;
      }
    }
    return 2;
  } catch (error) {
    if (error instanceof ImportError) {
      err(`${error.message}\n`);
      return 1;
    }
    throw error;
  } finally {
    db.close();
  }
}
