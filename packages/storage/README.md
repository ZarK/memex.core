# @tjalve/memex-storage

The folders of each Memex app, as defined in [contracts/storage.md](../../contracts/storage.md): where the user data, caches, logs, state, packs, and the archive live, the folders the user chose, what kind of place each folder is in, and what an app does at start-up. No runtime dependencies and no native code.

## Start-up

```ts
import os from "node:os";
import {
  acquireAppLock, currentDataSource, currentMemexPaths, locationWarnings, markCacheFolder,
  memexRoot, openDataFolder, retiredVariables, writeMemexReadme,
} from "@tjalve/memex-storage";

const context = { platform: process.platform, env: process.env, home: os.homedir() };
const flag = undefined; // the app's --data value, if any
const paths = currentMemexPaths("photos", { flag }); // reads locations.json unless MEMEX_HOME is set

for (const v of retiredVariables(process.env)) console.warn(`${v.name} is retired; use ${v.replacement ?? "the default folders"}`);

// A missing chosen folder (an unplugged drive) throws DataFolderError "missing"; it is never made empty.
await openDataFolder({ app: "photos", data: paths.data, source: currentDataSource("photos", { flag }), state: paths.state });
const lock = await acquireAppLock({ app: "photos", data: paths.data, state: paths.state }); // AppLockedError when one runs
await markCacheFolder(paths.cache);
await writeMemexReadme(memexRoot(context));

for (const w of await locationWarnings(paths, context)) console.warn(w.text);
// "The data folder C:\Users\ada\OneDrive\Memex\Photos is in C:\Users\ada\OneDrive, which OneDrive synchronizes.
//  OneDrive will upload about 3.2 GB now, and every change after that. ..."

// ... on exit:
await lock.release();
```

## Functions

| Function | What it does |
|---|---|
| `memexPaths(input)` | The folders of one app: `{ data, cache, logs, state, packs, apps, archive }`. Pure. |
| `dataSource(input)` | Where `data` came from: `flag`, `variable`, `memex-home`, `locations`, or `default`. |
| `currentMemexPaths(app, { flag })`, `currentDataSource(app, { flag })` | `memexPaths()` and `dataSource()` for the running process, with `locations.json`. |
| `locationsFilePath()`, `readLocations()`, `readLocationsSync()`, `writeLocations()`, `setAppLocations()` | `locations.json`: the data and cache folders the user chose, per app. |
| `describeLocation(path, options)` | `{ kind, provider, root, evidence }`: `local`, `sync` (OneDrive, Dropbox, iCloud Drive, Google Drive, Proton Drive, Nextcloud, pCloud, Box, Syncthing), `network`, `removable`, or `virtualized` (MSIX). Cheap checks only. |
| `folderSize(dir, { limitBytes, timeBudgetMs })` | Bytes and files, stopped by a byte limit or a time budget. Never downloads online-only files. |
| `locationWarnings(paths, options)`, `locationWarningText(warning)` | The warning for each folder that is not local, with a size estimate for synchronized folders. The archive is exempt. |
| `openDataFolder({ app, data, source, state })` | Opens the data folder; makes it only on the first run with the default folder. |
| `acquireAppLock({ app, data, state })` | One running instance per app and data folder. |
| `markCacheFolder(dir)` | `CACHEDIR.TAG`, and `.metadata_never_index` on macOS. |
| `electronPaths(paths)` | The `userData`, `sessionData`, `logs`, `crashDumps`, and disk cache folders for an Electron app. |
| `writeMemexReadme(root)` | `~/Memex/README.txt`: back up this folder with your own tool. |
| `retiredVariables(env)`, `syncWarnings(paths, options)` | The 0.1 checks: retired variables, and sync clients by path only. |

Errors: `MemexPathsError` (`unknown-app`, `relative-path`, `invalid-locations`), `DataFolderError` (`missing`, `not-a-folder`), and `AppLockedError` (`locked`, with the holder).

`describeLocation()` takes `exists`, `isFile`, `realpath`, and `mounts` options, so that tests and other platforms can describe a folder without the disk. Windows paths use `path.win32` and other platforms `path.posix`, whatever the OS that runs the code.

## Electron

```ts
const e = electronPaths(currentMemexPaths("study"));
app.setPath("userData", e.userData);
app.setPath("sessionData", e.sessionData);
app.setPath("logs", e.logs);
app.setPath("crashDumps", e.crashDumps);
app.commandLine.appendSwitch("disk-cache-dir", e.diskCache);
```

Call it before `app.whenReady()`. Keep settings and UI preferences in `e.data`, not in Chromium's local storage.

Tests run the contract fixtures in `contracts/fixtures/storage/`.
