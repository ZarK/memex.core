# @tjalve/memex-licenses

The license check that every Memex app passes in CI, the third-party notices that go into each app, and the credit lines for packs. It works offline and has no runtime dependencies. It runs from a local checkout of memex.core until the package is on npm.

## CLI

```bash
node packages/licenses/dist/bin.js check   [--repo <dir>] [--config <file>] [--json] [inputs]
node packages/licenses/dist/bin.js notices --out <empty folder> [--repo <dir>] [--config <file>] [--json] [inputs]
node packages/licenses/dist/bin.js packs   <manifest or folder>... [--format md|text|json] [--out <file>]
node packages/licenses/dist/bin.js third-party --from-review <license-review.json> [--match <repo>] [--out <file>]
node packages/licenses/dist/bin.js own     --expect <MIT|AGPL-3.0-or-later|GPL-3.0-or-later> [--repo <dir>] [--pending <step and reason>] [--json]
```

`own` checks the repository's own license against its group: MIT for libraries, contracts and clients, AGPL-3.0-or-later for apps, services and headless tools, GPL-3.0-or-later for Studio's ComfyUI nodes. The `LICENSE` file (or `LICENSE.md`, `LICENSE.txt`, `COPYING`) must hold that license's text, and the license of `package.json`, `pyproject.toml` and `Directory.Build.props` must be that id. A GNU text does not say "or later", so the text is compared by its family. `--pending` says why the license is still open and what settles it: a mismatch is then printed as pending and the exit code is 0.

Inputs replace what the config or the repository walk gives: `--importer <path>`, `--vite <dist>`, `--dotnet <project.assets.json or project folder>`, `--electron-dist <dir>`, `--electron-zip <file>`, `--third-party <file>`, `--packs <file or folder>` (each repeatable where it makes sense), and `--product <name>`.

`check` exits 0 when it finds no error, 1 on errors, and 2 on a usage error. `notices` exits 0 when it wrote the files, and 2 on a usage error; it refuses an output folder that is not empty, so old license files never stay behind.

## What it reads

| Source | What it gives |
| --- | --- |
| `pnpm-lock.yaml` (lockfile 9) and `node_modules` | The run-time closure of the chosen importers: `dependencies` and `optionalDependencies`, not `devDependencies`. Each package's license comes from `package.json` (`license`, old `licenses`, `SEE LICENSE IN <file>`), else from its license file. Git and tarball dependencies take their version from the lockfile's `packages` entry or their `package.json`. An optional package that is not installed (another platform's binary) is left out with a note. |
| Vite builds | The packages in the build, from `.vite/memex-licenses.json` (written by the `memexLicensesVite()` plugin) or from source maps. This adds dev dependencies that Vite bundles, and Vite's own preload helper. A build with neither gives a note. |
| `obj/project.assets.json` | The NuGet packages that put runtime, native or resource files in the build. Packages with only compile, build or analyzer files are not shipped and are left out. The license comes from the `.nuspec` (expression, license file, or a `licenses.nuget.org` URL). Test projects (a test SDK reference, or a name that ends in `.Tests`, `.TestHost`, `.Specs` or `.Benchmarks`) are skipped unless named. The .NET runtime and ASP.NET Core get the license and third-party notices of the installed .NET. |
| Electron | Found in the lockfile (also as a dev dependency, because it ships). Its `LICENSE` and `LICENSES.chromium.html` come from `--electron-dist`, `--electron-zip`, the package's `dist` folder, or a release zip in `.cache/electron` or Electron's download cache. Without the Chromium credits the check fails. |
| Fonts | `.ttf`, `.otf`, `.woff` and `.woff2` files in the repository, the Vite builds and the `fonts` folders. The family, version, copyright and license come from the font's name table (WOFF2 is read with the built-in Brotli). A license file next to the font that names the family, or a plain `LICENSE` or `OFL.txt`, gives the license text. A font that a bundled npm package ships (for example `@fontsource`) counts as that package. |
| Vendored code | Each subfolder of a `vendor`, `third_party` or `third-party` folder, named `<name>-<version>`, with its license file. |
| `third-party.json` | Data, models, icons, corpora, tools and services: see below. |
| `memex.pack/1` manifests | The license fields of each pack ([packs.md](../../contracts/packs.md)). A pack with `origin: memex` is hosted; any other pack downloads from its publisher. |

The repository walk skips `node_modules`, `.git`, `bin`, `obj`, `.cache`, `release`, `out`, test and fixture folders, `docs`, `design` and `scripts`. Add more with `ignore` in the config.

A package that names an SPDX license but ships no license file gets the standard text of that license with its copyright holder (from the `.nuspec` copyright, or the package author). The check reports this as a note. Without a copyright holder, an MIT, BSD or ISC text cannot be complete, and the check reports missing attribution. A platform package of a native module (`<name>-<os>-<cpu>[-<abi>]` such as `@napi-rs/canvas-linux-x64-gnu`, or `@<name>/[<part>-]<os>-<cpu>[-<abi>]` such as `@esbuild/linux-x64`) that ships no license file first takes the license file of its main package (`@napi-rs/canvas`, `esbuild`), when the main package is in the inventory with the same license; the check reports this as a note.

## Rules

| Rule | Severity | Finds |
| --- | --- | --- |
| `unknown-license` | error | No license, an id that is not in the tool's SPDX list (and not a `LicenseRef-`), a `LicenseRef-` in code without a license text, a package in the lockfile or assets file that is not installed, or content that Memex ships or hosts (and every pack) whose commercial use is unknown |
| `copyleft` | error | GPL, AGPL and other strong copyleft licenses, when no allow entry names the package and the exact license |
| `custom-license` | error | A license file that holds a known license plus terms of its own (see below), when no allow entry names the package and its `LicenseRef-Custom-*` id |
| `missing-attribution` | error | Code without a license text to ship, Electron without `LICENSES.chromium.html`, and content or packs whose license asks for credit and that have no credit line |
| `restricted-content` | error | Non-commercial content, content with restricted commercial use, or content with territory limits, when it is bundled or hosted |
| `limits` | error | Any other `limits` on content or a pack that is bundled or hosted, when no allow entry names it and its exact license |
| `review-blocker` | error for bundled or hosted, note otherwise | An open blocker from the license review |
| `weak-copyleft` | note | LGPL, MPL, EPL and similar: keep the library separate and replaceable, and offer its source |
| `generated-text` | note | The notices hold a standard license text because the package ships none |
| `not-installed` | note | An optional package for another platform |
| `unused-allow` | note | An allow entry that matched nothing |
| `inventory` | note | Something the inventory could not read |

An expression with `OR` is judged by its least restrictive choice. A GPL with a linking exception (for example `Classpath-exception-2.0` or `Font-exception-2.0`) counts as weak copyleft. `LicenseRef-Memex-*` is Memex's own content.

A license file counts as a known license only when it has no words of restricting terms (Commons Clause, competing use, non-commercial, "right to sell", Business or Functional Source License and similar). A file that `SEE LICENSE IN <file>` or a nuspec `<license type="file">` names must also be the standard text, with no text of its own before the license starts. Otherwise the package gets `LicenseRef-Custom-<first 12 hex digits of the file's SHA-256>`, so a changed text needs a new decision.

Territory limits are the `territories` of an item, or for a pack the `limits` that name a place: a country, a region such as the EEA or Europe, or territories as such.

## Config: memex-licenses.json

The config is optional. Paths are relative to the repository root.

```json
{
  "format": "memex.licenses/1",
  "product": "Memex.Study",
  "pnpm": { "importers": [".", "desktop"], "dev": false },
  "vite": ["dist"],
  "dotnet": ["sidecar/App"],
  "electron": { "dist": "desktop/release/win-unpacked" },
  "fonts": ["apps/web/src/ui/fonts"],
  "vendor": ["apps/web/src/vendor"],
  "thirdParty": ["third-party.json"],
  "packs": ["packs"],
  "ignore": ["website"],
  "allow": [
    { "match": "some-gpl-tool", "license": "GPL-3.0-only", "rules": ["copyleft"], "reason": "A separate program, started as a process and never linked." }
  ]
}
```

Each list replaces the walk for that source. `false` for `pnpm`, `dotnet` or `electron` turns that source off. An allow entry needs a reason, and it matches only the license it names, so a license change brings the finding back. An allow entry takes only the rules `copyleft` (the default), `custom-license` and `limits` (`weak-copyleft` is a note). The config refuses any other rule: unknown licenses, restricted content, missing credit and review blockers always stay errors, because Memex never ships or hosts such content.

## third-party.json

```json
{
  "format": "memex.third-party/1",
  "items": [
    {
      "id": "wikidata-realms",
      "name": "Wikidata realms snapshot",
      "kind": "data",
      "version": "2026-10-19",
      "source": "https://www.wikidata.org",
      "delivery": "bundled",
      "license": {
        "spdx": "CC0-1.0",
        "url": "https://creativecommons.org/publicdomain/zero/1.0/",
        "commercial": "allowed",
        "limits": [],
        "territories": [],
        "attribution": "Wikidata contributors (CC0)."
      },
      "blocker": null,
      "paths": ["server/data/realms.json"]
    }
  ]
}
```

`delivery` is `bundled` (in the installer or the build), `hosted` (on a Memex host), `download` (from the publisher, on the user's device), or `service` (the app calls it and keeps no copy). The license fields match the pack manifest. `attribution` is the credit line, or `null` when the license asks for none. `commercial` defaults to what the SPDX id says; `territories` is required when a limit names a place (a country, a region such as the EEA or Europe, or territories as such): list the places, or `[]` when the limit is not about places. Every non-empty `limits` list on bundled or hosted content still needs a decision: an allow entry with the `limits` rule, or a territory limit, which no allow entry passes. `license.file` can name a license text in the repository.

`third-party --from-review` turns the items of one repository in a license review (`memex.license-review/0-draft`) into this file: `ship` becomes `bundled`, `host` becomes `hosted`, `download` stays `download`, services become `service`, and `remove` items are left out. Items that the scanners find themselves (npm and NuGet packages, vendored code, fonts, Electron and the .NET runtime) are left out too.

## Output

`notices` writes three things into the output folder:

- `THIRD-PARTY-NOTICES.md`: a table per kind of software, the content grouped by delivery with its credit lines, and every license text once, with the packages that use it. Texts over 256 KB and HTML files are linked, not copied in.
- `notices.json` (`memex.notices/1`): every component with its license, delivery, copyright lines, credit line, limits, license files and where the inventory found it.
- `licenses/<ecosystem>/<name>@<version>/`: each license and notice file.

The output does not depend on the time it is made, so the same inputs give the same bytes.

`packs` writes the credit line of each pack: its `attribution`, or `<title> by <publisher>, <license>`, plus the change notice of a Memex-made pack. Markdown output splits lines that a license asks for from courtesy credits.

## Library

```ts
import { buildInventory, checkInventory, writeNotices, loadConfig, memexLicensesVite } from "@tjalve/memex-licenses";

const root = process.cwd();
const { config } = loadConfig(root);
const inventory = buildInventory({ root, config });
const result = checkInventory(inventory, config.allow);
writeNotices(inventory, "build/notices");
```

In `vite.config.ts`, `plugins: [memexLicensesVite()]` writes `.vite/memex-licenses.json` into the build, so `notices` lists exactly the packages in the build without source maps.
