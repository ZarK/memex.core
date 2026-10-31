# @tjalve/memex-archive

The reference implementation of [contracts/archive.md](../../contracts/archive.md) (version 0.2): zip packs built in the local cache and copied into the archive with closed writes, the per-source `index.jsonl`, compressed database snapshots, status files, run locks, the archive `README.md`, and the `memex-archive` CLI. No runtime dependencies: the zip writer and reader use `node:zlib`.

Memex has no backup, restore, or snapshot features. The database snapshots are working copies of a source's own database, kept three deep.

## A collector run

```ts
import { resolveArchiveRoot, startRun } from "@tjalve/memex-archive";

const root = resolveArchiveRoot(); // --root flag, MEMEX_ARCHIVE_HOME, MEMEX_HOME/Archive, ~/Memex/Archive
const run = await startRun({ root, domain: "code-sessions", source: "editor", device: "main-pc" });
try {
  const known = new Map(run.previousIndex?.files.map((f) => [f.id, f]) ?? []);
  for (const { path: sourcePath, id, meta } of sessionFiles) {
    const before = known.get(id);
    const grew = before !== undefined && (await fileStartsWith(sourcePath, before)); // the collector's own check
    if (grew) await run.appendFile(sourcePath, id, { offset: before.size, base: before.sha256, meta }); // appends/<id>
    else await run.captureFile(sourcePath, id, { meta });                                             // files/<id>
  }
  await run.writeChunk(rows, { stream: "messages" });      // records/messages.jsonl
  await run.putAttachment({ path: imageFile });            // attachments/<aa>/<sha256>.<ext>, once per source
  await run.putDatabase(consistentDbCopy, "chat");         // databases/chat/<run-id>.db.gz, three kept
  run.note("chat/42", { kind: "chat", messages: 12 });     // an index item that is not a file
  await run.finish({ counts, filtered, highWater });
} catch (error) {
  await run.fail(error);                                   // still publishes what the run staged
  throw error;
}
```

Everything a run adds is written into a pack in `<cache>/staging/<domain>/<source>/<device>/<run-id>/` (the OS cache folder of the app id `archive`, or `cacheDir`). `finish()` and `fail()` copy the parts into `packs/<yyyy>/`, write `index.jsonl` and `status.json`, and release the lock. A run that adds nothing writes no pack. A run records a failure, and keeps the earlier `lastSuccess` and `highWater`, when its counts do not add up, a record failed, a permission is missing, or the pack could not be published.

Rules the library enforces:

- Paths (`id` of a file) use forward slashes, with no leading slash and no empty, `.` or `..` segments.
- `meta` is a JSON object of at most 4 KiB as UTF-8 JSON. A larger one is refused (`meta-too-large`); shorten its text fields.
- One entry per name per run: `writeChunk` once per stream, a file id once as `files/` and once as `appends/`.
- `appendFile` needs the latest revision's size and SHA-256 as `offset` and `base`. It hashes the whole file while copying the tail, and refuses the append (`append-base-mismatch`) when the first `offset` bytes changed; capture the file whole then.
- `captureFile` with `expectedSha256` throws `SourceChangedError` when the bytes differ, and keeps nothing.
- An entry of more than 64 GiB fails with the error `too large for a pack` (`MAX_ENTRY_BYTES`). Entries of 4 GiB or more are stored with ZIP64.
- `putAttachment` calls for the same bytes store them once. A call that finds a copy still in flight waits for it, and stores the bytes itself when that copy fails.
- When a pack part cannot be finished (its `manifest.json` or central directory fails to write, for example on a full cache disk), the call that hit it throws that error, every later entry fails with `pack-broken`, and `finish()` records a failed run. The parts that closed are published; the unfinished part is not, and its number is not reused.
- `putDatabase` stores a snapshot only when it differs from the newest one and, unless `oncePerDay: false`, when the newest one is from an earlier UTC day.

## A one-time import

```ts
import { importFolder, resolveArchiveRoot } from "@tjalve/memex-archive";

const result = await importFolder({ root: resolveArchiveRoot(), folder: "/path/to/old-maildir", name: "workspace-mail", date: "2026-10-25" });
// result.dir: <root>/imports/2026-10-25-workspace-mail; result.ok, result.files, result.bytes, result.packs, result.skipped, result.failed
```

`importFolder` stores every file of the folder whole as `files/<path>`, with the path relative to the folder as its id, in the packs of one run (parts at 1 GiB), then writes `index.jsonl` and `status.json`. It uses the same staging and closed writes as `startRun`; the manifests and status name domain `imports`, source `<date>-<name>`, device `import`. It walks the folder in name order without following links: a link, or anything that is not a file or folder, is listed in `skipped` and in the status `filtered` list. Files are streamed one at a time, so a folder of tens of GB never sits in memory. The folder is only read. A file that cannot be stored, or a folder that cannot be read, is listed in `failed` and makes the import a failed run; the walk goes on with the next entry. `ok` is false for a failed run, and `status.lastRun.error` says why. `files` and `bytes` count only the files in the published packs, so a run whose packs could not be published stores 0 files. An import whose folder exists already is refused (`import-exists`), and so is an import folder inside the source folder (`import-inside-folder`).

## Reading

```ts
import { listPacks, openFileVersion, openPack, readFileVersion, readIndex } from "@tjalve/memex-archive";

const index = await readIndex(sourceFolder);                 // null when there is none
const packs = await listPacks(sourceFolder);                 // sorted by run id and part
const pack = await openPack(packs[0].path);                  // manifest, entries, open(name), read(name)
const bytes = await readFileVersion(sourceFolder, id, { run }); // full revision + later appends, checked
for await (const chunk of await openFileVersion(sourceFolder, id)) process.stdout.write(chunk); // streamed
```

In the index, `totals.files` is the number of file items, `totals.bytes` the size of the packs and snapshots on disk, and `totals.sourceBytes` the size of the latest version of every file, every attachment and every snapshot before compression. `runs` counts the runs that published a pack.

## CLI

```
memex-archive init   [--root <dir>]
memex-archive status [--root <dir>] [--json] [--stale-days N]
memex-archive check  [--root <dir>] [--json] [--stale-days N]
memex-archive ls     <source-folder> [--type file|item|attachment|database|records] [--grep <text>] [--json]
memex-archive cat    <source-folder> <id> [--run <run-id>] [--out <file>]
memex-archive index  <source-folder> [--rebuild]
memex-archive import <folder> --name <name> [--date <yyyy-mm-dd>] [--root <dir>] [--json]
```

A source folder is a path, or a path under the root such as `code-sessions/editor/main-pc`. `check` exits 1 when it finds a failing or stale source, a missing or invalid `status.json`, a leftover `*.partial` file, a pack that cannot be read or whose manifest does not match its zip entries, or a pack that `index.jsonl` does not list or describe. It reads central directories and manifests, not every entry. `import` prints the totals, every skipped link and every failed file, and the outcome and error of a failed run, and exits 1 when the import is a failed run (also when no file failed but the packs could not be published); an import folder is `imports/<date>-<name>` for `ls`, `cat` and `index`.

## Caveats

- `readFileVersion` holds the whole file in memory. `openFileVersion` and `cat` stream it, so they work on a file of any size; the SHA-256 of each revision is checked at its end, so a mismatch fails the stream after its bytes went out (`cat --out` then leaves no file).
- A run that stops without `finish()` or `fail()` (a crash, a killed process), or whose pack part could not be finished, leaves its staging folder in the cache; nothing reuses it, and it can be deleted. The next run rebuilds the index when it finds packs that the index does not list.
- `putAttachment` deduplicates by hash only: the first extension stored for a hash is the one kept.
- One pack part holds at most 65,000 entries and about 1 GiB of compressed data. An entry larger than 1 GiB gets a part of its own. ZIP64 is used only for an entry and a part that need it (an entry or an offset of 4 GiB or more), so a part of small entries is a plain zip, byte for byte as before.
