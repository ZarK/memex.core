# Archive contract

**Version:** 0.2 (24 October 2026; ZIP64 for large entries added the same day, library 0.2.1).

The archive is a folder of the user's data: the raw originals, stored in daily compressed packs, with an index that people and agents can read without opening a pack. Collectors (Capture, CodeSessions, app connectors, one-time imports) write to it. Apps read from it and can be rebuilt from it. This document is the open format of that folder, so that other tools can write and read it without Memex.

Memex has no backup, restore, or snapshot features. The database snapshots below are working copies of a source's own database, not backups.

**Changes from 0.1:** files, records and attachments go into zip packs instead of thousands of loose files; a changed file that only grew is stored as its new bytes; database snapshots are compressed and only the latest three are kept; an index per source describes everything in its packs; packs are built outside the archive and copied in when finished. There is no conversion from 0.1: no archive in the 0.1 layout holds real data.

## Root

The archive root is one folder, and it is configuration:

1. A `--root` flag, when the tool has one.
2. `MEMEX_ARCHIVE_HOME`.
3. `MEMEX_HOME/Archive`, when `MEMEX_HOME` is set.
4. `~/Memex/Archive`.

This is the storage precedence for the app id `archive` ([storage.md](storage.md)). Any folder works as the root: a local disk, a network share, or a folder that a sync client covers. When several machines write to one archive, the sync client or the share carries the files between them; Memex does not.

## Layout

```
<root>/
  README.md                                guide to this folder for people and agents
  <domain>/<source>/<device>/
    packs/<yyyy>/<run-id>.zip              one pack per run (parts: <run-id>.2.zip, <run-id>.3.zip, ...)
    databases/<name>/<run-id>.<ext>.gz     the latest snapshots of a source database (three kept)
    index.jsonl                            what the packs hold: one line per item, with metadata
    status.json                            state of this source
  imports/<yyyy-mm-dd>-<name>/             one-time drops: data downloads, old exports
    packs/  databases/  index.jsonl  status.json   the same shape as a source folder
```

- **Segments.** `domain`, `source`, `device`, `stream`, the database `name` and the import `name` are lowercase: `[a-z0-9][a-z0-9._-]{0,63}`. Known domains: `messages`, `calls`, `mail`, `contacts`, `calendar`, `reminders`, `notes`, `voicememos`, `code-sessions`, `location`, `health`, `social`, `finance`. A new domain needs no change to this contract.
- **Device.** The account or device that the data came from, for example `mac-mini` or `work-laptop`. One device folder has one writer machine. Two machines never write the same `<domain>/<source>/<device>/` folder, so a sync client never sees two writers of one file.
- **Run id.** `<yyyymmdd>T<hhmmss>Z-<8 hex>`, the UTC start time of the run and a random suffix, for example `20261023T101500Z-3f9a0c1e`. Run ids sort by time; a run of a source that starts in the same second as its run before gets a larger suffix, so that the runs of one source sort in the order they ran. `<yyyy>` in a pack path is the year of the run id.
- **Imports.** `memex-archive import <folder> --name <name> [--date <yyyy-mm-dd>]` (library: `importFolder`) stores a one-time drop in `imports/<yyyy-mm-dd>-<name>/` as one run: every file of the folder is a `full` entry, `files/<path>`, whose `id` is its path relative to the folder, in packs with parts at 1 GiB, through the same staging and closed writes as a collector run, followed by `index.jsonl` and `status.json`. The manifests and the status name domain `imports`, source `<yyyy-mm-dd>-<name>` and device `import`. The date defaults to the local date of the import. Links are not followed: each one is listed in `filtered` with the reason `link, not followed`, as is any entry that is not a file or a folder. A file that cannot be stored (too large for a pack, which is more than 64 GiB; a name that is not a usable path, a read error) counts as failed, and so does a folder that cannot be read (no permission, removed during the import); the walk goes on with the next entry, and the import is then a failed run. An import whose packs cannot be published is also a failed run, and its files are not counted as stored. The source folder is only read; nothing in it is changed or deleted. Files are read as streams, one at a time. An import whose folder exists already is refused, so a second import with the same date and name never adds to the first.
- **Schedule.** Each collector picks its schedule. CodeSessions runs once a day. Capture runs every hour, because a phone or a Mac can remove its local copies of messages. A run that finds nothing new writes no pack, so a source gets one pack a day, or a few small ones.

## Packs

A pack is a standard zip file: deflate compression, UTF-8 entry names with `/` separators, no encryption. Any zip tool can open it, and a reader can read one entry without unpacking the others.

ZIP64 is used only for the entries and packs that need it, so a pack of small files has no ZIP64 structures:

- An entry whose size the writer knows to be close to 4 GiB or more before it writes it (so that its deflated size can reach 4 GiB) has a ZIP64 extended information field (`0x0001`) in its local header, with both sizes, and `0xFFFFFFFF` in the 32-bit size fields. Its central header has the sizes in a ZIP64 field as well. Version needed to extract is 45 for such an entry.
- An entry whose local header starts at 4 GiB or more has its offset in a ZIP64 field of its central header (version needed 45).
- A pack with such an entry, with its central directory at 4 GiB or more, or with 65,535 entries or more ends with the ZIP64 end of central directory record and locator before the end record.

Every current zip tool reads ZIP64 (Python `zipfile`, Info-ZIP `unzip` 6, 7-Zip, bsdtar, Windows Explorer). A reader of this archive must read ZIP64 fields in local and central headers and the ZIP64 end records.

| Entry | Holds |
|---|---|
| `records/<stream>.jsonl` | The records the run read, as JSON Lines (see Records). The default stream is `records`. |
| `files/<path>` | A whole file: a file seen for the first time, a file that changed in another way than growing, or a whole-file capture such as a vCard export. |
| `appends/<path>` | The bytes that were added to the end of a file since its last stored revision. |
| `attachments/<aa>/<sha256>.<ext>` | A media file or attachment, stored once per source under its content hash. |
| `manifest.json` | The pack's own description, written as the last entry. |

- `<path>` is the collector's relative path for the file, for example `home/projects/F--code-demo/s1.jsonl`. It has no `..` segments and no leading `/`.
- `<sha256>` is the lowercase hex SHA-256 of the bytes; `<aa>` is its first two characters; `<ext>` is the lowercase original extension without the dot, or no extension and no dot. An attachment whose hash the index already lists is not stored again.
- **Parts.** A pack closes its current part and starts the next one (`<run-id>.2.zip`, ...) before an entry when the part already holds 1 GiB of compressed data or 65,000 entries (below the 65,535 at which a zip needs ZIP64 end records). An entry larger than 1 GiB uncompressed goes into a part of its own: the part closes before it when it holds other entries, and closes after it. Every part has its own `manifest.json` for its own entries; the `item` entries go into the last part's manifest. One entry can be at most 64 GiB uncompressed; a larger file fails as that item, with the error `too large for a pack`.

### manifest.json

```json
{
  "format": "memex.archive.pack/1",
  "domain": "code-sessions", "source": "editor", "device": "main-pc",
  "runId": "20261024T031500Z-3f9a0c1e", "part": 1, "createdAt": "2026-10-24T03:16:02.511Z",
  "entries": [
    { "entry": "files/home/projects/p/s1.jsonl", "kind": "full", "id": "home/projects/p/s1.jsonl",
      "size": 18233, "sha256": "…", "mtime": "2026-10-23T22:01:13.000Z", "meta": { "kind": "session" } },
    { "entry": "appends/home/projects/p/s0.jsonl", "kind": "append", "id": "home/projects/p/s0.jsonl",
      "offset": 90112, "size": 2048, "base": "…", "sha256": "…", "mtime": "…" },
    { "entry": "attachments/3f/3f9a….jpg", "kind": "attachment", "size": 381022, "sha256": "3f9a…" },
    { "entry": "records/records.jsonl", "kind": "records", "stream": "records", "count": 117, "size": 52811, "sha256": "…" }
  ]
}
```

- `kind` is `full`, `append`, `attachment`, `records` or `item`. An `item` has no zip entry: it carries the `id` and `meta` that the collector set with `note()`, so that the index can be rebuilt from the manifests.
- For an `append`: `offset` is the size of the file at its previous revision, `base` is the SHA-256 of the whole file at that revision, `size` is the number of new bytes, and `sha256` is the SHA-256 of the whole file after this append (so that a reader can check the result).
- `sha256` of a `full` entry is the SHA-256 of the file. `mtime` is the source file's modification time, when known.
- `meta` is optional collector metadata (see Index).

### Reading a file back

The latest version of a file is its last `full` revision followed by every later `append` in run order. Each append starts at its `offset`, which equals the size reached so far, and its `base` equals the SHA-256 reached so far. A reader that finds a mismatch stops and reports it. `memex-archive cat` does this.

## Records

- The records of a run are JSON Lines: one JSON object per line, UTF-8, `\n` line ends, a final `\n`. Each stream gets at most one entry per pack.
- Each line should carry the source's own identifier for the record (`id`), so that later runs and converters can deduplicate. The rest of the object is the source record, with as little processing as possible.
- When a record disappears from the source, a later run records that, for example `{"id": "...", "deleted": true, "seenMissingAt": "..."}`. Earlier packs stay as they are.
- Records refer to attachments by hash, never by path. A reader finds the bytes through the `attachment` item for that hash in `index.jsonl`; the stored extension is the one in that item.

## Database snapshots

- A collector that needs a consistent copy of a source database (for example a SQLite store, copied with SQLite's online backup API) stores it as `databases/<name>/<run-id>.<ext>.gz`: one gzip file, where `<ext>` is the database's own extension (`sqlite`, `db`, `storedata`).
- After a new snapshot is stored, the older snapshots of that database are deleted until three remain (the count is configurable per collector). This is the only deletion in the archive. Snapshots are working state; the records, files and attachments in the packs are the record and are never deleted.
- A collector stores a snapshot only when the database changed since its last snapshot, and by default at most once a day, so that an hourly collector does not copy a large database every hour.

## Index

`index.jsonl` describes everything the source's packs and snapshots hold, so that people and agents can find things without opening packs. It is JSON Lines and is rewritten at the end of every run. It is derived data: `memex-archive index --rebuild` makes it again from the manifests and the `databases/` folder.

The first line describes the source; the other lines are items, sorted by `type`, then by `id`, `sha256` or `name`:

| `type` | Fields |
|---|---|
| `source` | `format` (`memex.archive.index/1`), `domain`, `source`, `device`, `updatedAt`, `runs`, `packs` (list of `{ "file", "runId", "part", "bytes" }`), `totals` (`files`, `bytes` as stored, `sourceBytes`) |
| `file` | `id`, `path` (latest entry path), `size`, `sha256`, `mtime`, `firstRun`, `lastRun`, `revisions` (list of `{ "run", "file", "entry", "kind", "offset", "size", "sha256" }`), `meta` |
| `attachment` | `sha256`, `ext`, `size`, `file`, `entry`, `firstRun` |
| `records` | `run`, `file`, `entry`, `stream`, `count` |
| `database` | `name`, `snapshots` (list of `{ "run", "file", "size", "sha256", "sourceSize" }`, newest first) |
| `item` | `id`, `meta`, `firstRun`, `lastRun`: something that is not a file, for example a chat or a contact list |

- `file` in a revision or attachment is the pack path relative to the source folder, for example `packs/2026/20261024T031500Z-3f9a0c1e.zip`.
- **Metadata for agents.** `meta` is a small JSON object (at most 4 KiB) that the collector fills in so that an agent can decide what is worth opening. It is the latest value; a later run replaces it. Examples: a coding session has `{ "kind": "session", "app", "sessionId", "project", "cwd", "gitBranch", "startedAt", "lastAt", "messages": { "user", "assistant" }, "firstPrompt", "summary", "models" }`; a chat has `{ "kind": "chat", "chatId", "service", "handles", "firstAt", "lastAt", "messages", "attachments" }`. Text fields are short (a first prompt at most 300 characters).

## Closed writes

- Packs and database snapshots are built in the archive's local cache folder (the OS cache folder of the app id `archive`, [storage.md](storage.md)), never inside the archive.
- A finished file is copied into the archive as `<name>.<pid>-<random>.partial`, flushed (`fsync`), and published as `<name>` after a check that `<name>` does not exist. `index.jsonl` and `status.json` are renamed over the earlier ones. No hard links are used.
- A reader ignores `*.partial` files. An interrupted copy leaves a `.partial` file, which `memex-archive check` reports. A sync client never sees a half-written file under a final name.
- A run that fails after it staged content still publishes the pack parts it finished, so that the next run knows what is already stored.
- When a part cannot be finished (its `manifest.json` or central directory cannot be written, for example because the cache disk is full), the run refuses every later entry and fails. It publishes the parts that did close. The entries of the unfinished part are not in the archive, and its part number is not used for another part. Because the run failed, `highWater` does not move, and the next run reads those entries again if the source still has them.

## Status file

`status.json` in each source folder holds the state of that source. It is written with a closed write at the end of every run.

```json
{
  "format": "memex.archive.status/1",
  "domain": "messages",
  "source": "imessage",
  "device": "mac-mini",
  "lastRun": {
    "runId": "20261023T101500Z-3f9a0c1e",
    "startedAt": "2026-10-23T10:15:00.000Z",
    "finishedAt": "2026-10-23T10:15:04.210Z",
    "outcome": "success",
    "error": null,
    "missingPermissions": [],
    "packs": ["packs/2026/20261023T101500Z-3f9a0c1e.zip"]
  },
  "lastSuccess": {
    "runId": "20261023T101500Z-3f9a0c1e",
    "finishedAt": "2026-10-23T10:15:04.210Z"
  },
  "highWater": 184467,
  "counts": { "read": 120, "written": 117, "unchanged": 0, "filtered": 2, "failed": 1 },
  "filtered": [
    { "id": "8812", "reason": "empty system message" },
    { "id": "8813", "reason": "empty system message" }
  ]
}
```

| Field | Meaning |
|---|---|
| `format` | Always `memex.archive.status/1`. A reader refuses other values. |
| `domain`, `source`, `device` | The folder's own path segments. A run does not start when they differ from the folder's segments (error `status-mismatch`). |
| `lastRun` | The most recent run, successful or not. `outcome` is `success` or `failed`. `error` is a short message or `null`. `missingPermissions` lists what the OS blocked, for example `"Full Disk Access"`. `packs` lists the pack files that the run published (empty when it found nothing new). |
| `lastSuccess` | The most recent successful run, or `null` before the first one. Consumers use `finishedAt` to show stale sources. |
| `highWater` | The collector's resume point: the last source row id, a timestamp, or any JSON value the collector understands. `null` before the first success. |
| `counts` | The counts of the last run. `read` = `written` + `unchanged` + `filtered` + `failed`. |
| `filtered` | Every record that the last run read on purpose but did not write, with the reason. Its length equals `counts.filtered`. |

Rules:

- A run succeeds only when its counts add up, `filtered` has one entry per filtered record, `failed` is 0, and the collector reports no error.
- A run that does not meet these rules is a failed run. Its `lastRun` and `counts` are written, but `lastSuccess` and `highWater` keep their earlier values, so the next run starts again from the last good point.
- A source that the OS blocks is a failed run with `missingPermissions` filled in. It is never an empty success.
- A source whose `lastSuccess` is older than a few days (the CLI default is 3) is stale and raises a visible warning. A failure is never silent.

## README.md

`memex-archive init` writes `README.md` at the root, and every run writes it again when it is missing or older than the library's version of it. It explains, for a person or an agent that finds the folder: what the archive is, the layout, how to find things (read `index.jsonl`, search its `meta`), how to read a pack with any zip tool or with `memex-archive cat`, how appends are joined, and what the archive does not keep.

## What the archive does not keep

Credentials are filtered by the collectors and never stored. There is no copy verification; backups of the archive folder are the user's own setup, and Memex does not make, schedule, or check them. Database snapshots are kept three deep. Open-format conversions (the `open/` folder of 0.1) are reserved for a later version: when converters exist, they write their own packs.

## Run lock

Two runs of the same source on one machine never overlap. The lock is a file in the OS cache folder of the app id `archive` ([storage.md](storage.md)), not in the archive, so that a sync client never copies it. A lock on the same machine whose process is gone, or that was taken before the last boot, is stale. A stale lock is taken over atomically: it is renamed to a unique name first, so that when two runs find the same stale lock, only one of them takes it.

## The `memex-archive` CLI

| Command | Does |
|---|---|
| `memex-archive init [--root <dir>]` | Creates the root folder and its `README.md`, and prints the root. |
| `memex-archive status [--root <dir>] [--json] [--stale-days N]` | Lists every source and import with its last run, last success, packs and size, and whether it is stale or failing. |
| `memex-archive check [--root <dir>] [--json] [--stale-days N]` | Checks status files, pack files (readable, manifest matches the index), `*.partial` leftovers, staleness and failures. Exits 1 when it finds a problem. |
| `memex-archive ls <source-folder> [--type file\|item\|attachment\|database\|records] [--grep <text>] [--json]` | Lists the index items of a source, with their metadata. |
| `memex-archive cat <source-folder> <id> [--run <run-id>] [--out <file>]` | Writes a file as it was at its latest revision, or at a given run, joining its appends. |
| `memex-archive index <source-folder> [--rebuild]` | Prints the index, or makes it again from the packs and snapshots. |
| `memex-archive import <folder> --name <name> [--date <yyyy-mm-dd>] [--root <dir>] [--json]` | Stores every file of a folder whole in `imports/<date>-<name>/` (see Layout), and prints the files, bytes, packs, skipped links and failures, and the outcome and error of a failed run. Exits 1 when the import is a failed run. |

The reference implementation is `@tjalve/memex-archive` in `packages/archive`.

## Library API for collectors

`startRun()` returns a run that stages everything locally and publishes it on `finish()` or `fail()`:

| Call | Does |
|---|---|
| `writeChunk(records, { stream })` | Adds the run's records for a stream (`records/<stream>.jsonl`). |
| `putAttachment(input, { ext })` | Adds an attachment by hash, unless the index already lists it. Returns `{ sha256, size, ext, stored }`. |
| `captureFile(sourcePath, path, { meta, expectedSha256 })` | Adds a whole file as `files/<path>`. |
| `appendFile(sourcePath, path, { offset, base, meta })` | Adds the bytes of the file from `offset` as `appends/<path>`. |
| `putDatabase(sourcePath, name, { keep })` | Compresses a database copy to `databases/<name>/<run-id>.<ext>.gz` and keeps the latest `keep` (default 3). |
| `note(id, meta)` | Sets an index item that is not a file. |
| `previousIndex` | The index before this run, for the collector's comparisons. |
| `finish(...)`, `fail(...)` | Publish the pack parts, the index and the status, and release the lock. |

Readers use `readIndex(sourceFolder)`, `listPacks(sourceFolder)`, `openPack(file)` (manifest and entry streams) and `readFileVersion(sourceFolder, id, { run })`.
