# Folder scan contract

**Version:** 0.1 (25 October 2026).

How a Memex app finds the files in a folder that the user chose (a watched folder, a source folder, a one-time import), and what changed since the last time. The app lists the folder without reading or downloading any file, compares the listing with a journal of what it saw before, and asks the user before an import reads files that are online only.

The reference implementation is `@tjalve/memex-folders` (`packages/folders`). The fixtures in [fixtures/folder-scan/](fixtures/folder-scan/) are part of this contract: an implementation in any language (for example the C# scanner of Memex.Photos) must return the same results. The matching rules come from Memex.Photos `LibraryScan.cs`; the online-only detection comes from Photos `FileSystemListing.cs` and the workspace `folder-listing.ts`.

## Listing

A listing reads names, sizes, times, attributes, and file ids only. It never opens a file, so it never makes a sync client download one.

- **Walk.** Breadth first from the root: the root, then every folder one level down, and so on. In each folder, entries are sorted by name in ordinal (UTF-16 code unit) order. File paths are relative to the root, with `/` separators.
- **Links are never followed.** A symbolic link, a junction, or another reparse point whose tag has the name-surrogate bit (`0x20000000`) is reported in `links` and not entered or read, whether it points to a file or a folder. A cloud placeholder is a reparse point too, but its tag has no name-surrogate bit, so it is an ordinary file or folder. The root itself is opened as the user gave it.
- **Hidden names.** A name that starts with `.`, or has the Windows hidden (`0x2`) or system (`0x4`) attribute, is left out unless the app asks for hidden names. Left-out files are in `skippedFiles`, left-out folders in `skippedFolders`.
- **System folders** are never entered: `.Spotlight-V100`, `.Trashes`, `.DocumentRevisions-V100`, `.fseventsd`, `System Volume Information`, `$RECYCLE.BIN`, `lost+found`, and `.Trash-*` (compared without case).
- **Name keys.** A name's key is its Unicode NFC form, in upper case when the file system ignores case. Two files of one folder with one key: the first in ordinal order is listed, the other is left out with the warning `names-collide-by-case` or `names-collide-after-normalization`. The same rule applies to two folders of one folder, so that two folders never merge into one in the journal.
- **Names that are not valid Unicode** (a byte name on Linux, a lone surrogate on Windows) are left out with the warning `name-not-unicode`. On Windows the listing helper finds a lone surrogate before it writes the name as UTF-8, because UTF-8 cannot hold one.
- **A folder that cannot be listed** is in `unlistedFolders` with the warning `folder-not-listed` (or `folder-gone` when it went away during the listing). Nothing below it is checked, and the listing is not `complete`. A root that is missing or cannot be listed is an error (`missing`, `not-a-folder`): a disconnected drive is never an empty folder.
- **Loops.** A folder whose volume and file id the listing has seen is skipped with the warning `folder-loop` (a bind mount, for example). It is in `skippedFolders`, not in `listedFolders`, and nothing below it is checked. Of two views of one folder, the first in walk order (breadth first, then name order) is listed, so the same view is listed on every scan.
- **File system.** The listing names the root's file system (`ntfs`, `refs`, `apfs`, `hfsplus`, `ext4`, `xfs`, `btrfs`, `zfs`, `fat32`, `exfat`, `smb`, or `unknown`) and whether it ignores case, tested by looking the root (or one of its entries) up with its case changed.

Fixture: `listing.json`.

### Online-only files

A file is **online-only** when its bytes are not on this device, so that reading it makes the sync client download it:

| Platform | Online-only when |
|---|---|
| Windows | The attributes have `FILE_ATTRIBUTE_OFFLINE` (`0x1000`), `FILE_ATTRIBUTE_RECALL_ON_OPEN` (`0x40000`), or `FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS` (`0x400000`). |
| macOS | The BSD flags have `SF_DATALESS` (`0x40000000`). A file named `.<name>.icloud` (iCloud Drive before macOS 14) is the online-only file `<name>`, with an unknown size. |
| Linux | Never: no common sync client marks files there. |

- A cloud reparse tag alone does **not** make a file online-only. A file that the sync client has downloaded keeps its tag (and the attribute `0x400`) but has none of the attributes above, and reading it downloads nothing. In a real Proton Drive folder on Windows, all 37,456 downloaded files of 417,034 listed files had the reparse attribute and none of the online-only attributes. (Memex.Photos `FileSystemEntry.IsCloudPlaceholder` counts a cloud tag as a placeholder; under this contract it must not.)
- A folder with `RECALL_ON_OPEN` (Windows) or a dataless folder (macOS) is a folder whose list of entries is not on the device yet. Listing it makes the sync client fetch the names (metadata only, never file contents). The listing does that, because a complete listing needs the names.
- **Windows.** Node.js does not give file attributes, so the reference implementation runs a small C# class through Windows PowerShell's `Add-Type`. It lists each folder through one handle with `GetFileInformationByHandleEx` (`FILE_ID_EXTD_DIR_INFO`, or `FILE_ID_BOTH_DIR_INFO` on file systems without 128-bit ids), which gives every entry's attributes, reparse tag, size, times, and file id, and `FILE_ID_INFO` for the volume serial number. These are the calls of Photos `FileSystemListing.cs`, so the ids are the same. Paths use the `\\?\` form and work at any length. (Windows PowerShell's `Get-ChildItem` and `DirectoryInfo` refuse paths of more than 260 characters; the workspace listing used `Get-ChildItem` with errors silenced, so it reported a listing as complete without those folders.) When the helper cannot start, the listing fails: it never guesses that a file is local.
- **macOS.** Node.js does not give `st_flags`. A file whose size is not 0 and whose block count is 0 may be dataless; its flags are read with `/usr/bin/stat -f %Xf`. When they cannot be read, the file counts as online-only, so that the app asks before reading it.

## File ids

A file id (with the volume id) can prove that a file moved. How much it proves depends on the file system:

| `idReliability` | File systems | A matching id |
|---|---|---|
| `strong` | `ntfs`, `refs`, `apfs` | proves a move. |
| `weak` | `ext4`, `xfs`, `btrfs`, `zfs`, `hfsplus`, `smb` | names a candidate; the content hash decides. |
| `unusable` | all others | is not used. |

On Windows the id is the 128-bit id as lowercase hex of its bytes in memory order (16 hex digits for a 64-bit id) and the volume id the serial number as 16 hex digits. On Linux and macOS the id is the inode and the volume id the device number, as 16 hex digits; a file on another device than its folder has no id.

## Journal

The journal is what the app saw of each file the last time: `{ id, path, size, modifiedMs, fileId, volumeId, availability, state, contentHash, firstSeenMs, changedMs, seenMs, stateChangedMs }`. `id` is the identity of the file in this folder for as long as it lives, through moves and renames. `state` is `present` or `missing`. `contentHash` is what the app recorded when it read the file (the scan records the hash that it computed for rules 4 and 6); a changed file loses it.

The reference implementation keeps the journal of one root in a JSON file (`{ "format": "memex.folder-journal/1", "root", "scannedMs", "entries" }`), written whole to a temporary file and renamed. An app can keep the same entries in its own database.

## Matching rules

The scan compares a complete listing with the journal. For each listed file, in walk order, `X` is the present entry at the file's path key that this scan has not decided yet, else the missing entry at that key that went missing last. The first rule that applies wins:

1. **Unchanged.** `X` has the file's size and modification time, and no other entry has the file's id (or the ids are not usable). A missing `X` is **found again**. An unchanged file whose id, case of name, or availability is new is reported with `updated`, so the journal records it.
2. **Moved.** Another entry has the file's id on the same volume, its own path no longer holds that id, and size and time are the same. A `strong` id proves it; a `weak` id needs the content hash to equal the entry's `contentHash`.
3. **Moved and changed.** As rule 2 with another size or time, on a file system with `strong` ids only.
4. **Moved onto a path.** `X` exists, and an entry that left its path (missing, displaced, or its path no longer holds its size and time) has the file's size and time. The content hash decides at the end of the scan.
5. **Changed in place.** `X` exists.
6. **Moved without file ids.** No `X`, and an entry that left its path has the file's size. The content hash decides at the end of the scan.
7. **New.**

- Rules 4 and 6 run only when the app gives a hash function, and never for an online-only file: hashing it would download it.
- At the end, the observations of rules 4 and 6 are hashed and paired with candidates whose `contentHash` is equal: pairs with the same name key first, then the rest in ordinal order of their paths. Each observation and each entry is used once. An observation without a pair is changed (with `X`) or new. A file that went away before its hash counts as `vanished`.
- A move onto a path whose entry was present **displaces** that entry: the decision names it in `displaced`, and the entry becomes missing.
- **Missing.** An entry that no file took in a folder that was listed completely becomes missing, and so does an entry whose folder is gone below a folder that was listed completely. Entries in folders that could not be listed, or that the listing left out (hidden, system, a name collision, a loop), are not checked; neither are entries whose names the listing left out.
- **Rename candidates (6b).** Each entry that went missing in the scan is the rename candidate of at most one new entry with the same name key, in ordinal order of their paths.
- Times are equal when they are the same millisecond; on `fat32` and `exfat` also when they differ by up to 2 seconds, or by one hour within 2 seconds (a daylight-saving shift).

What the reference implementation leaves out of `LibraryScan.cs`: the mixed folder order (an app may still emit in its own order), revisions, retries of unfinished imports, and the database. The rules decide the same outcomes.

Fixture: `scan.json`.

## Stable files

A file that is still being written must not be read yet. A file is **settling** when its modification time or its creation time is less than the quiet time (default 10 seconds) before the scan's clock. The creation time catches a copy in progress, because a copy keeps the source's modification time. A time after the scan's clock does not count, so that a file from a clock that runs ahead is not held back forever.

A settling new, changed, or moved-and-changed file is reported with `settling`, is not in the import plan, and the journal does not take it (it keeps the earlier entry, or none), so the next scan reports it again until it is stable. Online-only files are never settling. Fixture: `stable.json`.

## Import plan and the online-only confirmation

`plan(scan)` says what an import of the scan would read: new, changed, and moved-and-changed files that are not settling. It splits them into local files (nothing is downloaded) and online-only files by provider. The provider of a file is the sync client of its folder ([storage.md](storage.md), Location kinds); below a synchronized root, every file has the root's provider. Online-only files in a folder of no known sync client are counted under the scanned root.

When the import would read an online-only file, `needsConfirmation` is true and the app shows `text` before it reads anything; the user starts the import. The text names each provider, largest first, separated by `; `:

```
379,578 files, 2.5 TB, from Proton Drive
2 files, 3 GB, from OneDrive; 1 file, 40 MB, from Dropbox
2 files, at least 2 MB, from iCloud Drive
```

Counts use `,` to group thousands; sizes use units of 1000 as in [storage.md](storage.md). `at least` is used when an iCloud stub's size is unknown. Fixture: `plan.json`.

## Watching

`watchFolder(root)` asks the app to scan on start, after each burst of change events once the folder has been quiet (default 10 seconds), and periodically (default 30 minutes), because a sync client can change files without an event. When the folder cannot be watched (a network share, too many watches, a platform without recursive watching), or the watch fails later, it falls back to **scan-on-start**: the start scan and the periodic scans only.

## The CLI

`memex-folders scan <folder> --plan [--journal <file>] [--hash] [--json]` lists a folder, compares it with the journal, and prints counts, sizes, and the confirmation text. `memex-folders watch <folder>` scans on each watch event. The output never has file names.
