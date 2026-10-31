# Storage contract

**Version:** 1.2 (31 October 2026). The fixtures freeze on 30 October 2026; 1.2 only adds cases. 1.2 adds `MEMEX_LOCAL_ROOT` ([Precedence](#precedence)); the results of 1.1 do not change. 1.1 adds the moved pack store: the top-level `packs` key of `locations.json`, which Memex.Node writes when the user moves the store ([Chosen locations](#chosen-locations)); the results of 1.0 do not change. 1.0 (24 October 2026) adds chosen locations, location kinds, size estimates, the missing-folder rule, the app lock, cache markers, Electron folders, and `README.txt` to 0.1 (23 October 2026); the results of 0.1 do not change.

Where every Memex app keeps its files. User data lives in one well-known folder that the user can see and back up with their own tool. Caches and logs live in the folders that the operating system provides for them. The Memex.Node pack store lives outside the user data folder. Memex apps have no backup, restore, or snapshot features.

The reference implementation is `@tjalve/memex-storage` (`packages/storage`). The fixtures in [fixtures/storage/](fixtures/storage/) are part of this contract: an implementation in any language must return the same results.

## Folders

`<App>` is the folder name of the app (see [App ids](#app-ids)). `<app>` is the app id.

| Folder | Windows | macOS | Linux |
|---|---|---|---|
| `data` (user data) | `~\Memex\<App>` | `~/Memex/<App>` | `~/Memex/<App>` |
| `cache` | `%LOCALAPPDATA%\Memex\<App>\Cache` | `~/Library/Caches/Memex/<App>` | `$XDG_CACHE_HOME/memex/<app>` |
| `logs` | `%LOCALAPPDATA%\Memex\<App>\Logs` | `~/Library/Logs/Memex/<App>` | `$XDG_STATE_HOME/memex/<app>/logs` |
| `state` (machine-local app state) | `%LOCALAPPDATA%\Memex\<App>\State` | `~/Library/Application Support/Memex/<App>` | `$XDG_STATE_HOME/memex/<app>/state` |
| `packs` (Memex.Node pack store) | `%LOCALAPPDATA%\Memex\Packs` | `~/Library/Application Support/Memex/Packs` | `$XDG_DATA_HOME/memex/packs` |
| `apps` (installed app descriptors) | `%LOCALAPPDATA%\Memex\Apps` | `~/Library/Application Support/Memex/Apps` | `$XDG_DATA_HOME/memex/apps` |
| `archive` | `~\Memex\Archive` | `~/Memex/Archive` | `~/Memex/Archive` |

- `~` is the user's home folder.
- When `MEMEX_LOCAL_ROOT` is set (since 1.2), `cache`, `logs` and `state` are `MEMEX_LOCAL_ROOT/<App>/Cache`, `/Logs` and `/State` on every OS ([Precedence](#precedence)).
- On Windows, when `LOCALAPPDATA` is unset or not absolute, it is `~\AppData\Local`.
- On Linux, `XDG_CACHE_HOME`, `XDG_STATE_HOME`, and `XDG_DATA_HOME` default to `~/.cache`, `~/.local/state`, and `~/.local/share`. A value that is not absolute is ignored, as the XDG specification says. Every platform other than Windows and macOS uses the Linux column.
- `data` holds everything the user would lose: databases, settings, corrections, and files the user made. It is the same on every OS, so that the user finds it.
- `cache` holds files that the app can make again. `logs` holds logs. `state` holds machine-local state that is not user data, for example window positions and run locks. Deleting these three folders loses nothing the user made.
- `packs` holds large, read-only downloads (models, map data) that Memex.Node serves to all apps. It is outside `~/Memex`, so that the user's backup and sync do not carry tens of gigabytes that can be downloaded again.
- `apps` is where installed apps and services register themselves, so that services find them.
- `archive` is the archive root ([archive.md](archive.md)). It can be anywhere; the owner points it at a synchronized drive.

## App ids

| App id | Folder name | Variable |
|---|---|---|
| `photos` | `Photos` | `MEMEX_PHOTOS_HOME` |
| `study` | `Study` | `MEMEX_STUDY_HOME` |
| `finance` | `Finance` | `MEMEX_FINANCE_HOME` |
| `health` | `Health` | `MEMEX_HEALTH_HOME` |
| `workspace` | `Workspace` | `MEMEX_WORKSPACE_HOME` |
| `studio` | `Studio` | `MEMEX_STUDIO_HOME` |
| `contacts` | `Contacts` | `MEMEX_CONTACTS_HOME` |
| `conversations` | `Conversations` | `MEMEX_CONVERSATIONS_HOME` |
| `calendar` | `Calendar` | `MEMEX_CALENDAR_HOME` |
| `node` | `Node` | `MEMEX_NODE_HOME` |
| `user` | `User` | `MEMEX_USER_HOME` |
| `archive` | `Archive` | `MEMEX_ARCHIVE_HOME` |
| `capture` | `Capture` | `MEMEX_CAPTURE_HOME` |
| `codesessions` | `CodeSessions` | `MEMEX_CODESESSIONS_HOME` |

An unknown app id is an error. Adding an app id is a minor version of this contract.

## Precedence

For the `data` folder of an app, the first one that is set wins:

1. A flag that the app accepts, for example `--data <dir>`.
2. `MEMEX_<APP>_HOME`.
3. `MEMEX_HOME`, joined with `<App>`.
4. The folder the user chose: `apps.<app>.data` in `locations.json` ([Chosen locations](#chosen-locations)).
5. The OS default, `~/Memex/<App>`.

The other folders:

- `archive`: the flag when the app is `archive`, then `MEMEX_ARCHIVE_HOME`, then `MEMEX_HOME/Archive`, then `apps.archive.data` in `locations.json`, then `~/Memex/Archive`.
- `packs`: `MEMEX_PACKS_DIR`, then the folder the user moved the store to (`packs` in `locations.json`, since 1.1), then the OS default.
- `apps`: `MEMEX_APPS_DIR`, then the OS default.
- `cache`: `apps.<app>.cache` in `locations.json`, then `MEMEX_LOCAL_ROOT/<App>/Cache`, then the OS default.
- `logs` and `state`: `MEMEX_LOCAL_ROOT/<App>/Logs` and `MEMEX_LOCAL_ROOT/<App>/State`, then the OS default.

`dataSource(input)` in the reference implementation says which step gave the `data` folder: `flag`, `variable`, `memex-home`, `locations`, or `default`.

An empty variable counts as unset. A flag or a `MEMEX_*` variable that is not an absolute path is an error; the app stops and says which value is wrong. Paths are returned normalized, with the platform's separator and no trailing separator.

`MEMEX_HOME` is for development and test runs (for example, an agent run points it at a scratch folder). Do not set it as a permanent user variable.

`MEMEX_LOCAL_ROOT` (since 1.2) is a folder for the machine-local files: `cache`, `logs` and `state`. `MEMEX_HOME` does not move them, on purpose: a user can point `MEMEX_HOME` at a network or synced folder, and caches, tokens and locks must not follow it there. A test or sandbox run sets `MEMEX_LOCAL_ROOT` as well as `MEMEX_HOME`, so that it writes nothing to the real profile. It has the same rules as the other `MEMEX_*` folder variables: an empty value counts as unset, and a value that is not an absolute path is an error (`relative-path`). It does not move `packs`, `apps` or `locations.json`. Users do not normally set it. Keep it apart from the data folders: if it is the same folder as `MEMEX_HOME`, the machine-local folders of an app end up inside its data folder (`<root>/<App>/State` beside `<root>/<App>`'s data), where a scan, backup or sync sees them. A sandbox uses two folders, for example `<scratch>/home` and `<scratch>/local`.

## Retired variables

Nothing has shipped, so these names are removed, not deprecated. An app never reads them. When one is set, the app prints one warning that names the replacement and goes on with the new rules.

| Retired variable | Replacement |
|---|---|
| `FINANCE_DB` | `MEMEX_FINANCE_HOME` |
| `HEALTH_HOME` | `MEMEX_HEALTH_HOME` |
| `HEALTH_DATA` | `MEMEX_HEALTH_HOME` |
| `HEALTH_PREFERENCES` | `MEMEX_HEALTH_HOME` |
| `AIW_DB` | `MEMEX_WORKSPACE_HOME` |
| `AIW_PROVIDERS` | `MEMEX_WORKSPACE_HOME` |
| `AIW_TOOLS` | `MEMEX_WORKSPACE_HOME` |
| `AIW_ARTIFACT_ROOT` | `MEMEX_WORKSPACE_HOME` |
| `AIW_HIMALAYA_CONFIG` | `MEMEX_WORKSPACE_HOME` |
| `DASHBOARD_DB_PATH` | `MEMEX_STUDIO_HOME` |
| `DASHBOARD_WORKFLOW_DIR` | `MEMEX_STUDIO_HOME` |
| `MEMEX_PHOTOS_LIBRARY` | `MEMEX_PHOTOS_HOME` |
| `MEMEX_MODELS_ROOT` | `MEMEX_PACKS_DIR` |
| `MEMEX_GEODATA_ROOT` | `MEMEX_PACKS_DIR` |
| `MEMEX_THUMBNAIL_CACHE_ROOT` | none: thumbnails go to the `cache` folder of `photos` |
| `MEMEX_STUDY_LIBRARY` | `MEMEX_STUDY_HOME` |
| `MEMEX_INSTANCE_DIR` | `MEMEX_HOME` |

`retiredVariables(env)` in the reference implementation returns the retired variables that are set, with their replacements.

## Folders that a sync client covers

A sync client (OneDrive, Dropbox, iCloud Drive, Google Drive, Proton Drive, Nextcloud, pCloud) copies every change to every device. It can copy a live SQLite database in the middle of a write, and it uploads caches and packs that can be downloaded again. The rule:

- When `data`, `cache`, `logs`, `state`, `packs`, or `apps` is inside a folder that a sync client covers, the app shows a warning that names the folder and the client. It does not refuse to start; the user decides.
- `archive` is exempt. The archive is made to be synchronized, because every write is closed ([archive.md](archive.md)).
- A folder is covered when one of its path segments (compared without case) is a known sync root: `OneDrive`, a segment that starts with `OneDrive - `, `Dropbox`, a segment that starts with `Dropbox (`, `iCloudDrive`, `iCloud Drive`, `Mobile Documents`, `Google Drive`, `My Drive`, `Proton Drive`, `Nextcloud`, or `pCloud Drive`. On macOS, a folder under `~/Library/CloudStorage/<name>` is covered, and the client is `<name>` up to its first `-`. On Windows, a folder under the value of `OneDrive`, `OneDriveConsumer`, or `OneDriveCommercial` is covered by OneDrive.
- The order of the checks: the Windows `OneDrive*` variables (prefix compared without case), then the macOS `CloudStorage` rule, then the path segments from left to right. The first match names the client: `OneDrive`, `Dropbox`, `iCloud Drive` (for `iCloudDrive`, `iCloud Drive`, and `Mobile Documents`), `Google Drive` (for `Google Drive` and `My Drive`), `Proton Drive`, `Nextcloud`, or `pCloud`.
- The check reads only the path. It does not touch the disk.

`syncWarnings(paths, { platform, env, home })` in the reference implementation returns one warning per covered folder: `{ key, path, client }`. It is the 0.1 check and does not change. Apps use `locationWarnings()` ([Location warnings](#location-warnings)): it also finds Syncthing, network shares, removable drives, and MSIX folders, and gives the size.

## Chosen locations

The user can choose another folder for the data and the cache of an app. The choice is kept in `locations.json`, one file per user and computer. The file is outside `~/Memex`, because it says where the parts of `~/Memex` are:

| Windows | macOS | Linux |
|---|---|---|
| `%LOCALAPPDATA%\Memex\locations.json` | `~/Library/Application Support/Memex/locations.json` | `$XDG_CONFIG_HOME/memex/locations.json` (default `~/.config`) |

```json
{
  "format": "memex.locations/1",
  "apps": {
    "photos": { "data": "/mnt/disk/Memex/Photos", "cache": "/mnt/fast/cache/photos" },
    "archive": { "data": "/srv/sync/Memex Archive" }
  },
  "packs": "/mnt/disk/Memex Packs"
}
```

- `apps.<app>.data` and `apps.<app>.cache` are absolute paths. A relative one is an error (`relative-path`), like a relative variable. A file that is not JSON, has another `format`, or has a value that is not a string is an error (`invalid-locations`). A missing file is an empty one.
- `apps.archive.data` is the archive root for every app.
- `packs` (since 1.1) is the folder that the user moved the Memex.Node pack store to. Memex.Node writes it when it moves the store (`memex-node packs move`, `PUT /v1/packs/location`; [packs.md](packs.md#move-the-store)), so that every app and every reader of the store finds it. It is an absolute path, with the same errors as the folders of `apps` (`relative-path`, `invalid-locations`). `MEMEX_PACKS_DIR` comes before it.
- An app keeps the entries and keys that it does not know when it writes the file, so that an older app does not remove what a newer app wrote. It writes the whole file to a temporary file and renames it.
- When `MEMEX_HOME` is set, `locations.json` is not read: a development or test run never uses the user's folders. This includes `packs`; Memex.Node does not move the store in such a run.
- `memexPaths()` stays pure: the caller reads the file (`readLocations`) and passes it as `locations`. `currentMemexPaths()` reads it.

`locationsFilePath()`, `readLocations()`, `writeLocations()`, and `setAppLocations()` implement this section. `packsSource(input)` says which step gave the `packs` folder: `variable`, `locations`, or `default`, the same values as the `source` that Memex.Node reports for the store. Fixtures: `paths.json` (precedence; the cases with `packsSource` cover the moved store) and `locations-file.json`.

## Location kinds

`describeLocation(path, { platform, env, home })` says what kind of place a folder is in: `{ path, kind, provider, root, evidence }`. The folder does not need to exist. It uses the path, the environment, and cheap checks only: marker files in the folder and its parents, the real path, and `/proc/self/mounts` on Linux. It runs no other program and needs no native code.

| `kind` | Meaning | `provider` |
|---|---|---|
| `local` | A folder on this computer that nothing copies. | `null` |
| `sync` | A folder that a sync client copies to other devices. | `OneDrive`, `Dropbox`, `iCloud Drive`, `Google Drive`, `Proton Drive`, `Nextcloud`, `pCloud`, `Box`, `Syncthing`, or the `CloudStorage` name |
| `network` | A network share. | `null` |
| `removable` | A removable or external drive. | `null` |
| `virtualized` | A folder that Windows redirects into an MSIX package. | `MSIX` |

`root` is the folder that the provider, share, drive, or package covers (`null` for `local`). The checks, in order (the first match wins):

1. MSIX (Windows). A folder in `%LOCALAPPDATA%\Packages\<package family>` is `msix-package`, and `root` is the package folder. When the app runs as an MSIX package (the caller passes `msixPackageFamily`), a folder in `%LOCALAPPDATA%` or `%APPDATA%` is redirected (`msix-redirect`), and `root` is `%LOCALAPPDATA%\Packages\<family>\LocalCache\Local` or `...\LocalCache\Roaming`. `~/Memex` is not redirected.
2. The `OneDrive`, `OneDriveConsumer`, and `OneDriveCommercial` variables (Windows, `variable`).
3. `~/Library/CloudStorage/<name>` (macOS, `cloud-storage`), on the path or its real path. The provider is the part of `<name>` before the first `-`, with friendly names for `OneDrive`, `GoogleDrive` (Google Drive), `ProtonDrive` (Proton Drive), `Dropbox`, `Box`, `Nextcloud`, and `pCloudDrive` (pCloud).
4. The known sync segments of [Folders that a sync client covers](#folders-that-a-sync-client-covers) (`segment`), on the path, then on its real path. For `Mobile Documents/com~apple~CloudDocs`, `root` includes `com~apple~CloudDocs`.
5. Marker files (`marker`) in the folder or a parent: `.stfolder` (Syncthing, a file or a folder) and `.dropbox` (Dropbox in a folder with another name, a regular file only). `root` is the folder that holds the marker. A `.dropbox` folder is not a marker: Dropbox keeps its settings in the folder `~/.dropbox` on macOS and Linux.
6. Network shares. Windows: a UNC path, also `//server/share` and `\\?\UNC\server\share` (`unc`, `root` is `\\server\share`); a drive letter whose real path is a UNC path, which is a mapped network drive (`realpath`, `root` is the drive). Linux: a mount of type `nfs`, `nfs4`, `cifs`, `smb3`, `smbfs`, `afs`, `ceph`, `glusterfs`, `9p`, `davfs`, `fuse.sshfs`, `fuse.rclone`, `fuse.davfs2`, or `fuse.glusterfs` in `/proc/self/mounts` (`mount-table`, `root` is the mount point; of two mounts on the same point the later one counts, such as an NFS mount on an autofs trigger). macOS: `/Network/...` and `/net/...` (`mount-path`).
7. Removable drives (`mount-path`): `/Volumes/<name>` on macOS (the start-up disk resolves to `/` and is local); `/media/<user>/<name>` and `/run/media/<user>/<name>` on Linux.
8. Otherwise `local` (`none`).

Limits: on Windows, a removable drive needs `GetDriveType`, which Node does not expose, so it is reported as `local`. On macOS, a share mounted under `/Volumes` is reported as `removable`. The real path of a folder that does not exist yet is the real path of its nearest existing parent, joined with the rest. Fixture: `location.json`, with Windows path forms (`path.win32`) and POSIX path forms (`path.posix`).

## Location warnings

When `data`, `cache`, `logs`, `state`, `packs`, or `apps` is not a `local` folder, the app shows a warning and keeps working: the user decides. `archive` is exempt. For a `sync` folder, the warning says how much the client will upload now.

- `folderSize(dir, { limitBytes, timeBudgetMs })` counts the bytes and files of a folder. It stops at `limitBytes` (default 100 GB) or after `timeBudgetMs` (default 2000 ms), and says why: `stoppedBy` is `limit`, `time`, or `null`. When `dir` itself is a link or junction, it counts the folder the link points to; it does not follow links inside the folder. It reads only metadata, so it never downloads an online-only file. A missing folder has size 0.
- The size in the text uses units of 1000 (`3.2 GB`, `38 GB`): `about <size>` for a complete count, `more than <size>` when the limit stopped it, `at least <size>` when the time stopped it.
- `locationWarningText({ key, path, location, size })` gives the text; `locationWarnings(paths, options)` gives `{ key, path, location, size, text }` per folder. The texts are part of this contract. Fixture: `warning-text.json`.

## Missing data folder

A missing data folder stops the app with a clear error. The app does not make an empty folder in its place: the drive may be disconnected or the folder moved, and an empty folder would split the user's data.

- The app makes the data folder only when its source is `default` or `memex-home` and this computer has not used that folder before.
- The app records the data folders it has used in `<state>/data-folders.json` (`{ "format": "memex.data-folders/1", "folders": [...] }`). `state` is machine-local, so the record stays when the data folder is missing.
- A file in place of the folder is an error too.

`openDataFolder({ app, data, source, state })` implements this. It throws `DataFolderError` with `code` `missing` or `not-a-folder`. The message names the folder, says where the choice came from (a flag, the variable, `MEMEX_HOME`, `locations.json`, or an earlier run), and says what to do.

## One instance per app and data folder

One instance of an app runs per data folder. `acquireAppLock({ app, data, state })` takes the file `<state>/locks/<first 16 hex of sha256(app + "\n" + data folder)>.lock`; on Windows the data folder is compared without case. The lock file holds `{ app, data, pid, hostname, startedAt }`. It lives in `state`, never in the data folder, so a sync client does not copy it. A lock on this computer whose process is gone, or that was taken before the last boot, is taken over. Otherwise the app stops with `AppLockedError`, which names the process that holds the lock. Another instance for another data folder, or another app with the same folder, can run.

## Cache folders

`markCacheFolder(dir)` makes the folder and marks it as a cache, so that backup tools and indexers leave it out:

- `CACHEDIR.TAG`, which starts with `Signature: 8a477f597d28d172789f06886806bc55` ([Cache Directory Tagging Specification](https://bford.info/cachedir/)). restic, Borg, tar, and other tools honor it.
- On macOS, also `.metadata_never_index`, so that Spotlight does not index the folder. Time Machine already leaves out `~/Library/Caches`, the default cache root on macOS. A cache folder in another place needs `tmutil addexclusion`, which the library does not run.

Apps mark their `cache` folder at start-up.

## Electron apps

`electronPaths(paths)` gives the folders that an Electron app sets before the app is ready, so that Chromium writes nothing in `%APPDATA%`, `~/Library/Application Support/<name>`, or `~/.config`, and nothing in the user's data folder:

| Electron | Folder |
|---|---|
| `app.setPath("userData")` and `app.setPath("sessionData")` | `<state>/Electron` |
| `app.setPath("logs")` | `<logs>` |
| `app.setPath("crashDumps")` | `<logs>/Crashes` |
| the `--disk-cache-dir` switch | `<cache>/Chromium` |

Chromium's profile (local storage, IndexedDB, cookies) is machine-local state. Anything the user would lose, for example settings and UI preferences, belongs in `data`, not in Chromium's local storage. Fixture: `electron.json`.

## README.txt

The Memex root (`MEMEX_HOME`, else `~/Memex`; `memexRoot()`) has a `README.txt`. It tells the user what the folder is and to back it up with their own tool, because Memex makes no backups. `writeMemexReadme(root)` writes it when it is missing or has an older `memex-readme <n>` line. A `README.txt` without that line is the user's own file, and stays as it is, with CRLF line ends on Windows. Apps call it at start-up.
