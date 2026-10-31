# @tjalve/memex-packs

The packs of Memex.Node for apps (MIT): a typed client for the pack routes of Memex.Node, read-only resolution of the pack store without Node, and a layout writer under the store lock for an app that downloads packs itself. See [contracts/packs.md](../../contracts/packs.md) and [contracts/node-api.md](../../contracts/node-api.md#packs).

Dependencies: `@tjalve/memex-node-client`, `@tjalve/memex-storage`.

## The client

```ts
import { connectPacks } from "@tjalve/memex-packs";

const packs = await connectPacks();                    // ensureNode: starts Memex.Node when it does not run
const all = await packs.catalog();                     // GET /v1/packs
const pack = await packs.status("yunet-2023mar");      // state, active version, license, acceptance, path

if (pack.acceptance?.needed) {
  const { text } = await packs.license(pack.id);       // show this text to the user
  await packs.accept(pack.id, { app: "photos", version: "2023mar", text }); // sends its SHA-256
}
await packs.install(pack.id, { onProgress: (p, install) => console.log(install?.bytesDone, install?.bytesTotal) });
const folder = await packs.activePath(pack.id);        // Node's path; the store itself when Node cannot be reached
```

A refusal of Node throws a `SurfaceError` with Node's error body (`acceptance_required`, `license_unknown`, `store_busy`, ...). A failed install throws a `PackError` with Node's reason.

## Read the store without Node

```ts
import { packStoreFolder, resolvePack } from "@tjalve/memex-packs";

packStoreFolder();                                   // { path, source: "variable" | "locations" | "default" }
const e5 = await resolvePack("multilingual-e5-small");                   // the active version, or null
const pinned = await resolvePack("siglip2-base-patch16-224", { version: "2025-02-21" });
```

The store is `MEMEX_PACKS_DIR`, else the folder the user moved it to (the top-level `packs` of `locations.json`, which Memex.Node writes; storage contract 1.1), else the OS default. `resolvePack` reads `packs.json` and the version folder's `memex.pack.json`, checks that the folder and the digest match, and needs no lock: an installed version folder never changes.

## The layout writer

For an app that downloads packs with its own downloader (Study in v1). It writes the layout of Memex.Node under the same locks, so Node lists, serves, moves, and removes those packs.

```ts
import { installPack } from "@tjalve/memex-packs";

const installed = await installPack(manifest, {
  onProgress: (p) => console.log(p.phase, p.bytesDone, p.bytesTotal),
  // download: your own Downloader; the default uses fetch with range requests
});
```

`installPack` checks the manifest with Memex.Node's rules (`checkPackManifest`), refuses an unknown license, stops with `acceptance_required` for a license the user has not accepted (`isAccepted`, `recordAcceptance` in Node's `acceptances.json`) before anything is staged or downloaded, only activates a version that is installed already, downloads each file into `.staging/<id>/<version>-<sha8>/<path>.part` (continuing a part that an earlier run left), checks its size and SHA-256 (one retry), and activates under `.lock`: the staging folder becomes `<id>/<version>-<sha8>/` and `packs.json` is replaced whole. `stagePack`, `checkStaged`, and `activatePack` are the same steps one by one, for a downloader that writes the files itself.

`acquireStoreLock` and `withStoreLock` take `.lock` with the layout of Memex.Node (`pid`, `startedAt`, `hostname`, `program`). This library cannot read the start time of another process, so it treats a lock as held while its process id runs. The host name in a lock has the form of .NET `Environment.MachineName` (`lockHostname()`), and `sameComputer()` matches it against the other forms of the same computer's name (the name with the mDNS suffix on macOS, the DNS name on Windows).

A staging folder's `.download.lock` is made with an exclusive create and holds the same JSON as `.lock`: a second download of the same version, in this process or another one, gets `install_busy`, and a lock whose process is gone is taken over.

Limits: on macOS and Linux, Memex.Node's download lock in a staging folder is advisory and Node.js cannot take it, so do not install the same pack version with Node and with this writer at the same time there. On Windows, the writer's open download lock keeps Node out of that staging folder.

## Manifests

`checkPackManifest(value)` applies the rules of Memex.Node: no unknown properties, the required fields, pinned Hugging Face URLs (a commit, not a branch), and the file path rules (`isPackFilePath`; `PACK_FILE_PATH_PATTERN` is the same rule as one regular expression, the `path` pattern of `schemas/packs/pack.json`). `packDigest` and `packFolder` give the digest and `<id>/<version>-<sha8>`.
