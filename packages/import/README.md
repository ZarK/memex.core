# @tjalve/memex-import

The import pipeline that the Memex apps share: walk the folders and files the user chose (and the zip and gzip files in them), detect which reader reads each file, read and normalize its records, hash them, dedupe on provenance (`source`, `content_hash`), and write the new ones with provenance v2 (`batch_id`, `file_hash`, `reader`). A preview runs the writes in a transaction and rolls it back. A commit writes each file in its own transaction and records it in the change journal, so a whole batch can be undone. Every file and every record gets an outcome, so a report accounts for all of the input.

Readers are domain code: they stay in the apps. This package does the rest. It builds on [`@tjalve/memex-sqlite`](../sqlite/README.md) (transactions and the change journal), [`@tjalve/memex-schema`](../schema/README.md) (the entity spine and provenance v2), [`@tjalve/memex-folders`](../folders/README.md) (listing without downloading online-only files), and the zip reader of [`@tjalve/memex-archive`](../archive/README.md). See [contracts/connector.md](../../contracts/connector.md) and [contracts/derived-facts.md](../../contracts/derived-facts.md#provenance-v2).

It comes from Finance's import (`src/import/*`: one-file preview and commit, provenance dedupe, numbered identical rows, the date, amount, CSV, and XLSX helpers) and Health's import (`import/archive.mjs`, `run.mjs`, `jobs.mjs`: walking folders and archives, detection by score, copies read once, the import record and its undo).

## Use

```ts
import { openDatabase } from "@tjalve/memex-sqlite";
import { nodeSqlite } from "@tjalve/memex-sqlite/node-sqlite";
import { createImporter, setupImport, parseCsv, tableRecords, type Reader } from "@tjalve/memex-import";

const db = openDatabase(join(paths.data, "app.db"), { driver: nodeSqlite });
setupImport(db); // core migrations, the change journal, and the import tables
migrate(db, "app", APP_MIGRATIONS); // the app's own tables

const statements: Reader<Row> = {
  id: "finance.csv.sparebank1",
  version: 2, // the provenance reader is "finance.csv.sparebank1/2"
  source: "import:csv:sparebank1",
  repeats: "number", // identical rows in one file are both kept
  detect: (sample) => (sample.head.startsWith("Dato;Beskrivelse") ? 90 : 0),
  async *read(entry) {
    const { records } = tableRecords(parseCsv(await entry.text()));
    for (const r of records) {
      const row = normalize(r.values);
      yield row ? { ref: `row ${r.row}`, identity: { date: row.date, amount: row.amount, text: row.text }, data: row }
                : { ref: `row ${r.row}`, skip: "the date cannot be read" };
    }
  },
  write(row, ctx) {
    const id = ctx.createEntity("finance.transaction");
    ctx.insert("finance_transaction", { entity_id: id, posted_at: row.date, amount_minor: row.amount });
    return id; // the provenance row is written for this entity
  },
};

const importer = createImporter(db, { readers: [statements], origin: "user" });
const plan = await importer.preview([folder]); // nothing is written
const report = await importer.commit([folder]); // report.batchId
importer.undo(report.batchId); // the earlier state is back
```

## What a run does

1. **Walk.** Each root is a folder or a file. A folder is listed by `listFolder`: links are not followed, hidden files are left out (reported as `ignored`), and online-only files are reported as `online-only` and not read unless `allowOnlineOnly` is set after the user confirmed the download. System files (`.DS_Store`, `__MACOSX`, `Thumbs.db`, `desktop.ini`) are `ignored`. A file given as a root is checked the same way, from a listing of its folder: online-only, it is not read without `allowOnlineOnly`. A root that is a link is not followed (`ignored`), and a root that is not there is refused before a batch starts (`ImportError`, code `not-found`).
2. **Detect.** Each reader scores the file's name and first 64 KiB from 0 to 100; the highest score of at least `minScore` (15) reads it. A zip or gzip that no reader reads whole is opened, and its entries are walked the same way (`archive`, with paths such as `drop.zip › march/quakes.csv`). A zip inside a zip is copied to a scratch folder first and removed after. Zip entries are checked against their CRC-32.
3. **Hash.** The file's SHA-256 is its `file_hash`. The same bytes read by the same reader again in this run are a `copy`, and are not read twice. The same bytes imported by the same reader version in an earlier batch are `unchanged` and are not read again, unless `reread` is set, a batch was undone since, or the app forgot the file (`forget`). A reader whose records depend on the file's name or folder (a daily file whose name holds its date) gives a `fileKey(sample)`: then a copy or an unchanged file needs the same bytes and the same key, and the key is kept as `file_key`. `read` gets the file's `hash` and `key` in its context.
4. **Read.** The reader yields records (`ref`, `identity`, `data`) and skips (`ref`, `skip`). A reader that throws makes the file `failed`; nothing from it is written.
5. **Dedupe.** The content hash is the SHA-256 of the canonical JSON of `identity`. Records in one file with the same identity are numbered (`repeats: "number"`, the default: the second gets ordinal 1, so both are kept and a repeated import adds nothing), or counted as `repeated` (`repeats: "duplicate"`, for records with an id of their own). A record whose `(source, content_hash)` is in `provenance` already is a `duplicate`.
6. **Write.** The reader's `write` creates the entity and the domain rows through the context (`createEntity`, `insert`, `link`), which tracks them in the change journal. The import writes the provenance row with `batch_id`, `file_hash`, `reader`, and `source_ref` (`<path>#<ref>`). A record the reader finds in the database already as another entity (matched by its own rules) returns `{ entity, existing: true }`: the provenance row is written for that entity, so the next run finds the key, and the record counts as a `duplicate`, not as `new`.

### Preview

`preview(roots)` reads every file first, then runs all the writes in one transaction and rolls it back. The report is exactly what a commit would do now: outcomes, record counts, the rows per table, and the first new records. It holds the records of all files in memory at once.

### Commit

`commit(roots)` writes each file in its own transaction: the file's rows, its journal change, and its `import_file` row. A file that fails is rolled back alone. The batch is `committed` when the run ends, or `stopped` when it ended early (its finished files stay). Each batch records the process that runs it: a `running` batch whose process is gone (a crash, a closed app, a killed process) is marked `stopped` by the next `commit`, `undo`, `batches` or `batch`, so that it can be undone. The CLI stops a run on Ctrl+C after the current file.

### Undo

`undo(batchId)` undoes the journal change of each file of the batch, newest first, in one transaction. It refuses (`ImportError`, code `conflict`) when rows the batch wrote changed since, or when other rows refer to them (a later batch linked to them): undo that batch first. Nothing is undone then.

### Forget

`forget([{ hash, reader, key }])` marks files as no longer imported, for an app that took away what they gave (a folder the user removed, an older version of a file that changed). The next run reads them again instead of finding them `unchanged`.

### Accounting

Each file has one outcome: `imported`, `unchanged`, `copy`, `archive`, `unrecognised`, `online-only`, `ignored`, or `failed`. For each file read, `read = new + duplicate + repeated + skipped`. `report.accounted` is true when that holds for every file and the totals are the sums. The `import_batch` and `import_file` tables keep the outcome and counts of every file of every batch.

## Helpers for readers

| Function | Does |
|---|---|
| `decodeText`, `repairDoubleEncoding` | Bytes as text: UTF-16 with a byte order mark, UTF-8 (double encoding repaired), else Windows-1252. |
| `parseCsv`, `detectDelimiter`, `tableRecords`, `readTable`, `readXlsx` | Delimited text and the first sheet of an XLSX workbook as rows, and rows as records by header with row numbers. |
| `parseDate`, `detectDateFormat`, `clearDateFormat`, `writesMonthFirst`, `toIsoUtc` | Dates to `YYYY-MM-DD` (day or month first decided over all values) and times to ISO 8601 UTC. |
| `parseAmount`, `detectDecimal`, `clearDecimal`, `toMinorUnits` | Amounts with signs, symbols, and separators, and integer minor units. |
| `findHeaderRow`, `headerSignature`, `normalizeHeader` | The header row after opening lines, and an id of a header layout. |
| `canonicalJson`, `contentHash`, `sha256`, `hashChunks` | The hashes the import uses. |
| `digestData` | Row counts and a SHA-256 of the data tables (not the import and journal history), to compare states. |

## CLI

```text
memex-import preview <folder or file>... --db <file> --readers <module> [--allow-online-only] [--include-hidden] [--reread] [--json]
memex-import commit  <folder or file>... --db <file> --readers <module> [--allow-online-only] [--include-hidden] [--reread] [--json]
memex-import batches --db <file> [--json]
memex-import show    <batch-id> --db <file> [--json]
memex-import undo    <batch-id> --db <file> [--json]
memex-import digest  --db <file> [--readers <module>] [--json]
```

The readers module exports `readers` and may export `setup(db)`, which makes the app's tables. [examples/public-data](examples/public-data/README.md) has readers for public USGS and Natural Earth files, and a worked run.

## Tables

`setupImport` adds the scope `memex-import`: `import_batch` (id, origin, state, roots, times, totals) and `import_file` (batch, order, path, size, outcome, reason, file hash, reader, source, record counts, journal change, file key, when it was forgotten). It also applies the core migrations and the change journal.
