# @tjalve/memex-folders

Folders that the user chose, as defined in [contracts/folder-scan.md](../../contracts/folder-scan.md): list a folder without downloading online-only files, compare the listing with a journal of what was seen, find files that are still being written, plan an import with the online-only confirmation, and watch for changes. No native code; one workspace dependency, `@tjalve/memex-storage`, for location kinds.

## Use

```ts
import { listFolder, plan, readJournal, scanFolder, watchFolder, writeJournal } from "@tjalve/memex-folders";

const root = "/Users/ada/Library/CloudStorage/ProtonDrive-ada@example.com/Photos";
const journalFile = "/Users/ada/Memex/Photos/folders/photos.json";

const listing = await listFolder(root); // never opens a file; links are never followed
const scan = await scanFolder(listing, await readJournal(journalFile, listing.root), {
  hash: async (file) => myHash(file), // optional: proves moves by content; never called for online-only files
});
const p = plan(scan);
if (p.needsConfirmation && !(await askUser(p.text))) return; // "1,240 files, 38 GB, from Proton Drive"
for (const d of scan.decisions) {
  if (d.settling) continue; // still being written: a later scan reports it again
  // new, changed, moved, moved-changed, missing, found-again: the app imports or updates
}
await writeJournal(journalFile, scan.journal);

const w = watchFolder(root, { onScan: (reason) => rescan(reason) }); // "start", "change", "periodic", "watch-failed"
// w.mode is "live" or "scan-on-start"
```

## Functions

| Function | What it does |
|---|---|
| `listFolder(root, options)` | Files with size, times, file id, and `onlineOnly`; listed, unlisted, and skipped folders; links not followed; warnings. |
| `scanFolder(listing, journal, options)` | The matching rules of Photos `LibraryScan.cs`: unchanged, new, changed, moved, moved-changed, missing, found-again; rename candidates; the next journal. |
| `plan(scan)` | What an import would read, local and online-only by provider, and the confirmation text. |
| `isSettling(file, nowMs, quietMs)` | A file written or copied less than `quietMs` ago. |
| `watchFolder(root, options)` | Scans on start, after changes, and periodically; falls back to scan-on-start. |
| `readJournal()`, `writeJournal()`, `emptyJournal()` | The JSON journal of one root. |
| `windowsBackend()`, `posixBackend()`, `fixtureBackend(tree)` | Listing backends. The fixture backend runs the contract fixtures without a disk. |

Errors: `FolderListingError` with `code` `relative-path`, `missing`, `not-a-folder`, `helper-failed`, or `invalid-journal`.

## CLI

```text
memex-folders scan  <folder> [--plan] [--journal <file>] [--hash] [--include-hidden] [--settle-ms <ms>] [--json]
memex-folders watch <folder> [--journal <file>] [--settle-ms <ms>] [--quiet-ms <ms>] [--periodic-ms <ms>] [--max-scans <n>]
```

The output has counts and sizes only, never file names.

## Platforms

- **Windows:** a C# helper compiled by Windows PowerShell's `Add-Type` (built into Windows) lists each folder with `GetFileInformationByHandleEx`, for attributes, reparse tags, and file ids at any path length. It needs `powershell.exe` and the .NET Framework compiler that comes with Windows; when either is blocked, the listing fails with `helper-failed`.
- **macOS:** `readdir` and `lstat`; dataless candidates are confirmed with `/usr/bin/stat -f %Xf`, and count as online-only when that fails. The file system comes from `/sbin/mount`.
- **Linux:** `readdir` and `lstat`; the file system comes from `/proc/self/mounts`. No online-only detection.
