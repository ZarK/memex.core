# Packs contract

**Version:** 1.1 (26 October 2026). 1.1 states the file path rules that Memex.Node checks, the layout of `.lock`, and the moved store in `locations.json`; manifests and stores that Memex.Node accepted stay valid. 1 (25 October 2026).

A pack is a large, read-only download that apps use: a model, map data, a corpus, or a tool. Memex.Node keeps one pack store for each user on each machine. All apps use the same copy. The store is outside `~/Memex`, so that the user's backup and sync do not carry files that can be downloaded again ([storage.md](storage.md)).

This document defines the pack manifest, the store layout, license acceptance, and where packs come from. The Node endpoints for packs are in [node-api.md](node-api.md#packs).

## Manifest: memex.pack/1

Each pack has one manifest. The JSON Schema is [schemas/packs/pack.json](../schemas/packs/pack.json).

```json
{
  "format": "memex.pack/1",
  "id": "multilingual-e5-small",
  "version": "2024-02-08",
  "title": "Multilingual E5 small (text embeddings)",
  "kind": "model",
  "engine": "onnx",
  "capabilities": ["embed.text"],
  "origin": "upstream",
  "source": {
    "publisher": "intfloat",
    "homepage": "https://huggingface.co/intfloat/multilingual-e5-small",
    "revision": "0123456789abcdef0123456789abcdef01234567"
  },
  "license": {
    "spdx": "MIT",
    "url": "https://huggingface.co/intfloat/multilingual-e5-small/blob/main/README.md",
    "file": "LICENSE",
    "commercial": "allowed",
    "limits": [],
    "attribution": "Multilingual E5 small by intfloat, MIT License",
    "acceptance": "none"
  },
  "hardware": { "memoryBytes": 600000000, "gpuMemoryBytes": 0, "providers": ["webgpu", "coreml", "cpu"] },
  "files": [
    {
      "path": "onnx/model.onnx",
      "bytes": 470000000,
      "sha256": "…64 lowercase hex…",
      "url": "https://huggingface.co/intfloat/multilingual-e5-small/resolve/0123456789abcdef0123456789abcdef01234567/onnx/model.onnx"
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `format` | Always `memex.pack/1`. A reader refuses other values. |
| `id` | Stable. `[a-z0-9][a-z0-9._-]{0,63}`. Results record it, so other bytes never get the same id and version. The id `location` is reserved for the Node endpoint. |
| `version` | `[0-9A-Za-z][0-9A-Za-z._+-]{0,63}`. The upstream version or date, or a Memex version. |
| `title` | The name that settings show. |
| `kind` | `model`, `map`, `data`, `corpus`, or `tool`. |
| `engine` | What loads the pack: `onnx` (ONNX Runtime), `generative` (the Node generative runtime), or `files` (the app reads the files itself, for example maps and corpora). |
| `capabilities` | The Node capabilities that the pack serves, for example `embed.text`. Empty for `files`. |
| `origin` | `upstream`: the publisher's own files. `memex`: Memex made the files, for example a one-time ONNX export. |
| `derivedFrom` | Required when `origin` is `memex`: `url`, `revision`, `license` (SPDX) of the original, and `notice` (one sentence that says what Memex changed). For a model (`kind` `model`), also `trainingData`: each data set that the original was trained on, with `name` and, when known, `url` and `license` (SPDX, or `null` when the data has no stated license). See [Model conversions that Memex makes](#model-conversions-that-memex-makes). |
| `source` | `publisher`, `homepage`, and the pinned upstream `revision`. |
| `license` | See [Licenses](#licenses). |
| `hardware` | Optional. `memoryBytes`, `gpuMemoryBytes`, and the execution providers that work: `webgpu`, `coreml`, `cpu`. Node does not run a pack on a device with less memory. |
| `files` | Every file: `path` (relative, `/` separators; see [File paths](#file-paths)), `bytes`, `sha256` (lowercase hex), `url`, and optional `role` (for example `tokenizer`). A file that is larger than 2 GiB on a host with a size limit has `parts`: a list of `url`, `bytes`, and `sha256`. Node joins the parts in order and checks the `sha256` of the whole file. |

### File paths

A file path stays inside the version folder on every OS, so a manifest made on one OS installs on all of them. Memex.Node, `@tjalve/memex-packs`, and the `path` pattern of the schema check the same rules. A path:

- is relative: it does not start with `/`, and it has no drive letter;
- has segments separated by `/`, none of them empty, `.`, or `..`;
- has no `\`, `:`, `*`, `?`, `"`, `<`, `>`, `|`, or control character (U+0000 to U+001F, U+007F to U+009F) in a segment, so no drive letter and no alternate data stream;
- has no segment that ends with a dot or a space;
- has no segment that Windows reads as a device: `CON`, `PRN`, `AUX`, `NUL`, `COM0` to `COM9`, `LPT0` to `LPT9` (also `COM¹`, `COM²`, `COM³`, `LPT¹`, `LPT²`, `LPT³`), in any case, also with an extension (`con.txt`) or with spaces before the extension (`aux .txt`).

### Digest

The digest identifies the exact bytes of a pack version.

- Make one line for each file: `<sha256>  <path>` (two spaces), with a `\n` at the end.
- Sort the lines by `path`, by ordinal byte order.
- The digest is the SHA-256 of these lines as UTF-8, in lowercase hex.

`<sha8>` is the first 8 characters of the digest. A result record names a native model by its pack `id`, `version`, and digest ([node-api.md](node-api.md#result-record)).

## Licenses

| Field | Meaning |
|---|---|
| `spdx` | An SPDX license expression, or `LicenseRef-<name>` for a license without an SPDX id. |
| `url` | Where the publisher states the license. |
| `file` | The path of the license text in `files`. Required when `acceptance` is `required`. |
| `commercial` | `allowed`, `restricted`, or `unknown`. |
| `limits` | Short sentences for each limit, for example `Non-commercial use only.` Empty when there are none. |
| `attribution` | The credit line that About shows, and that an app shows where the data appears. `null` when no credit is necessary. |
| `acceptance` | `required`: the user accepts the license text before the install. `none`: no acceptance step. |

Rules:

- Node refuses to install a pack when `spdx` or `commercial` is `unknown` (error `license_unknown`).
- An installer never bundles a pack, and no repository carries model weights. Every pack downloads to the user's device.
- `@tjalve/memex-licenses` reads these fields. It reports unknown licenses, missing credit lines, and packs with limits that an app bundles or that Memex hosts. A pack with `origin: memex` counts as hosted.

### Acceptance

- When `acceptance` is `required`, an app shows the license text (`GET /v1/packs/{id}/license`). The user accepts it in the app.
- The app sends the SHA-256 of that text (`POST /v1/packs/{id}/accept`). Node checks that the hash is the `sha256` of the `file` in the manifest.
- Node keeps acceptances in `~/Memex/Node/acceptances.json`, in the user data folder of Node, because an acceptance is a decision of the user. The JSON Schema is [schemas/packs/acceptances.json](../schemas/packs/acceptances.json).
- An acceptance is for a text hash. A new version with the same license text needs no new acceptance. A changed text needs a new one.

## Store layout

`<packs>` is the `packs` folder of [storage.md](storage.md) (`MEMEX_PACKS_DIR`, else the OS default).

```
<packs>/
  packs.json                         the active version of each pack
  .lock                              held by the program that changes the store
  .staging/<id>/<version>-<sha8>/    downloads in progress; <file>.part while a file downloads
  <id>/<version>-<sha8>/             one installed version; it never changes
    memex.pack.json                  the manifest of this version
    <files>
```

`packs.json` (schema [schemas/packs/store.json](../schemas/packs/store.json)):

```json
{
  "format": "memex.packs/1",
  "packs": {
    "multilingual-e5-small": {
      "version": "2024-02-08",
      "digest": "9f2c4a1e…64 hex…",
      "folder": "multilingual-e5-small/2024-02-08-9f2c4a1e",
      "activatedAt": "2026-11-03T09:12:00Z"
    }
  }
}
```

Rules:

- An installed version folder never changes. A reader needs no lock.
- Several versions of a pack can be installed side by side. `packs.json` names the active version. An app that pins another version uses its folder when it exists.
- Node removes a version that is not active when no registered app pins it.
- Only one program changes the store at a time. It holds `.lock`: it makes the file with an exclusive create and writes its process id and start time in it. A lock whose process is gone, or that was made before the last boot, is stale. A stale lock is taken over by a rename to a unique name first (`.lock.stale-<32 hex>`), as for the archive run lock ([archive.md](archive.md)).
- The layout of `.lock` is one JSON object:

  ```json
  { "pid": 18244, "startedAt": "2026-10-26T09:12:00.1234567Z", "hostname": "DESKTOP-1", "program": "memex-node" }
  ```

  `pid` is the process id of the holder, `startedAt` the start time of that process (UTC, ISO 8601), `hostname` the computer name in the form of .NET `Environment.MachineName` (on Windows the NetBIOS name, `COMPUTERNAME`, at most 15 characters; on macOS and Linux the host name up to the first `.`), and `program` the name that another program shows in its `store_busy` error (`memex-node`, `memex-packs`, or the app). A reader also treats a lock as stale when its `pid` runs with another start time (more than 2 s apart), because the OS gave the process id again. Two host names name the same computer when they are equal without case after each is cut at its first `.`, or when one of them has 15 characters and the other starts with it (a NetBIOS name and a longer DNS name). So on a Mac, the .NET name and the Node.js `os.hostname()`, which adds the mDNS suffix, name one computer. A lock from another computer is never stale. A lock that is not valid JSON is stale when it is older than 5 s; a newer one may be being written.
- A download writes `.staging/<id>/<version>-<sha8>/` while it holds `.download.lock` in that folder; a program that cannot take it does not write that folder (`install_busy`). Memex.Node opens the file without sharing (on macOS and Linux, .NET makes that an advisory lock). The layout writer makes the file with an exclusive create, writes the holder JSON of `.lock` in it, keeps it open, and takes over a lock whose process is gone by the stale rules of `.lock`. On Windows, each program's open handle keeps the other out. On macOS and Linux, Node.js cannot take Node's advisory lock, so Memex.Node and the layout writer do not install the same version at the same time there. The file goes before the staging folder is renamed.
- In version 1, two programs write the store: Memex.Node and the downloader of Memex.Study, through the layout writer of `@tjalve/memex-packs`. Both follow these rules.

## Install

1. Read the manifest. Refuse it when a license field is `unknown`.
2. If `acceptance` is `required`, check `acceptances.json`. Without an acceptance of this text hash, stop with `acceptance_required`, before anything is staged or downloaded. If `<id>/<version>-<sha8>/memex.pack.json` exists, this version is installed already: take `.lock` and only write `packs.json` (step 7).
3. Download each file into `.staging/<id>/<version>-<sha8>/<path>.part`. Continue an interrupted download with an HTTP range request.
4. Check the `bytes` and the `sha256` of each file. A file that does not match is removed and downloaded again one time. A second mismatch stops the install.
5. Rename each `.part` file to its name. Write `memex.pack.json`.
6. Take `.lock`. Rename the staging folder to `<id>/<version>-<sha8>/`.
7. Write `packs.json` with a full replace (a temporary file, then a rename). Release `.lock`.

A staging folder older than 7 days is removed.

## Read the store without Node

An app can read the store directly, for example Photos for its in-process models and Study for its corpora.

1. Find `<packs>` with the storage library (`memexPaths().packs`), or with `packStoreFolder()` of `@tjalve/memex-packs`, which also reads the moved store.
2. Read `packs.json`. Ignore a pack that is not there.
3. Use the files in `<packs>/<folder>/`. Do not write in the store without `.lock`.

## Where packs come from

Memex bundles no models. It points to each model, and the person's device downloads it.

- Every URL is pinned. A Hugging Face URL names a commit: `https://huggingface.co/<owner>/<repo>/resolve/<40 hex commit>/<path>`. A GitHub release URL names a release tag. Node refuses a URL that names a branch.
- **Third-party packs** (`origin: upstream`) download from the publisher's own location: its Hugging Face repository, GitHub release, or ModelScope page. Each file is pinned by its `sha256`. When the license asks for it, the person accepts the publisher's license before the download ([Acceptance](#acceptance)). Memex does not copy these files to a host of its own.
- **Model conversions that Memex makes** (`origin: memex`, `kind` `model`) are on the owner's own Hugging Face account. The account name is set when the account is made. Each conversion has its own model repository with a model card. See the next section.
- **Other packs that Memex makes** (`origin: memex`, any other `kind`) are release assets in the repository ZarK/memex-packs, the planned home of Memex packs, with the upstream license, a notice, and the manifest. A file on GitHub releases is smaller than 2 GiB, so a larger file is split into `parts`.
- Nothing is converted on the user's device.
- Maps are made on the user's device from the publisher's build. A pack with a `recipe` says how: `from` is the url, where `{date}` stands for the newest dated build; `bbox` and `maxZoom` keep part of a PMTiles build; without them the file is taken whole. This also serves data that its publisher replaces, so that no fixed file can be pinned. A file of such a pack has no `sha256` in the catalog. The version is the date of the build, and the store records an ordinary manifest, with the hash and without the recipe.

### Model conversions that Memex makes

A conversion is a model file that Memex makes one time from a published model, for example an ONNX export of PyTorch weights or a half-precision copy. Files on the owner's Hugging Face account are distributed by the owner, whoever clicks download. So Memex publishes a conversion there only when all of these are true:

1. The license of the code and the license of the weights both allow changed copies **and** commercial use. A conversion with `commercial` other than `allowed` is never published.
2. The model card names the original model (with its URL and revision), its license, what Memex changed (format, precision), and each training data set with its license, or says that the data has no stated license.
3. The manifest names the same training data in `derivedFrom.trainingData`, and records it as a limit in `license.limits`, for example `Trained on FFHQ (CC BY-NC-SA 4.0). The training data is not licensed for commercial use.` A limit names no country or region, because the license check reads such a limit as a territory limit and refuses it.
4. The license check of the repository that publishes the pack has a written exception for it: an allow entry with the rule `limits`, the exact license of the pack, and a reason. The entry matches `pack:<id>@<version>`, so each new version needs a new entry. Example:

   ```json
   { "match": "pack:caloriek@1.0.0-memex.1", "license": "MIT", "rules": ["limits"], "reason": "ONNX export of CalorieK. Code and weights are MIT. The training data has no stated license and is recorded as a limit." }
   ```

A conversion keeps the license of the original model. The license review records, for every model that a core Photos feature needs, whether its license and its training data allow commercial use, and names a replacement where they do not.

## Move the store

- The user can move the store (`PUT /v1/packs/location`, or `memex-node packs move <folder>`).
- Node warns when a sync client covers the new folder ([storage.md](storage.md#folders-that-a-sync-client-covers)), and it states the size.
- Node takes `.lock`, copies the store, checks every file, and then removes the old copy.
- Node records the new folder as the top-level `packs` of `locations.json` ([storage.md](storage.md#chosen-locations) 1.1), so that every app finds it: `memexPaths().packs` and `packStoreFolder()` of `@tjalve/memex-packs` read it. `MEMEX_PACKS_DIR` still takes precedence. Node does not move the store when `MEMEX_PACKS_DIR` or `MEMEX_HOME` is set (`location_fixed`).

## The `memex-node packs` CLI

| Command | Does |
|---|---|
| `memex-node packs list [--json]` | Lists the packs, their versions, and their state. |
| `memex-node packs install <id> [--version <v>]` | Installs a pack and shows the progress. |
| `memex-node packs accept <id>` | Shows the license text and records the acceptance. |
| `memex-node packs remove <id>` | Removes every version that no registered app pins. |
| `memex-node packs move <folder>` | Moves the store. |
