# memex.core

Shared contracts and the entity spine for the Memex apps by [ZarK](https://github.com/ZarK).

This repository holds the things every module agrees on, and nothing else. Domain logic lives in the module repositories. Code enters this repository only when a second consumer needs it.

## Contracts (`contracts/`)

Language-neutral specifications:

- [entity-schema.sql](contracts/entity-schema.sql) — the SQLite entity spine: `entity`, `relationship`, `provenance`.
- [entity.schema.json](contracts/entity.schema.json), [relationship.schema.json](contracts/relationship.schema.json), [provenance.schema.json](contracts/provenance.schema.json) — JSON Schemas for the row shapes.
- [derived-facts.md](contracts/derived-facts.md) — provenance v2, derived facts with stable ids, corrections that survive re-inference, and the corrections JSON Lines export ([correction.schema.json](contracts/correction.schema.json)), with fixtures for TypeScript and C# in `contracts/fixtures/schema/`.
- [connector.md](contracts/connector.md) — how data enters the spine: ingest → normalize → write with provenance → expose tools.
- [surfaces.md](contracts/surfaces.md) — the HTTP API, MCP server, and CLI of every app: names, the token, the request checks, the app record, the service launcher, and the error body.
- [packs.md](contracts/packs.md) — the pack manifest `memex.pack/1`, the pack store, license acceptance, and where packs come from.
- [node-api.md](contracts/node-api.md) — the Memex.Node API: functions and routes, run, jobs, leases, sessions, packs, backends, and the result record.
- [facts.md](contracts/facts.md) — the shared rules of the facts engine `@tjalve/memex-facts` that Memex.User and Memex.Contacts run: claims, joins, combining, provenance, corrections, the outbox, and the change feed, with shared JSON Schemas in `schemas/facts/`.
- [user-records.md](contracts/user-records.md) — the Memex.User records about the owner: kinds, scopes, and operations (version 2).
- [contacts-records.md](contracts/contacts-records.md) — the Memex.Contacts records about other people: persons with merges and pins, subjects, homes, workplaces, circles, relations, dates, and identities, with JSON Schemas in `schemas/contacts/` and fixtures in `contracts/fixtures/contacts/`.
- [studio-photos.md](contracts/studio-photos.md) — the Studio photo tools that Memex Photos uses (`studio.photos.*`).
- [archive.md](contracts/archive.md) — the archive folder: layout, closed writes, run chunks, attachments, and `status.json`.
- [storage.md](contracts/storage.md) — where each app keeps user data, caches, logs, state, and packs, with fixtures in `contracts/fixtures/storage/`.
- [message.md](contracts/message.md) — the `memex.message/1` and `memex.call/1` records and handles, with JSON Schemas in `schemas/message/` and fixtures in `contracts/fixtures/message/` and `contracts/fixtures/handles/`.
- [folder-scan.md](contracts/folder-scan.md) — listing a chosen folder without downloads, online-only files, the journal and the matching rules, stable files, the import plan with the online-only confirmation, and watching, with fixtures in `contracts/fixtures/folder-scan/`.

The JSON Schemas are in [schemas/](schemas/) and the OpenAPI files in [openapi/](openapi/). [contracts/fixtures/](contracts/fixtures/) has fixtures that every implementation must accept. In a folder with an `index.json`, that file names the schema of each fixture.

## Packages (`packages/`)

- **`@tjalve/memex-schema`** — the core migrations (entity spine, provenance v2, derived facts, corrections) and helpers over them: `migrateCore`, entity/relationship/provenance helpers, the import dedupe primitive, `writeFacts`, `resolveFact`, and the corrections export and import. Built on `@tjalve/memex-sqlite`.
- **`@tjalve/memex-facts`** — the facts engine of Memex.User and Memex.Contacts: claims per producer scope with generations, joins by kind, combining with provenance per field, review reasons, corrections with repeats, anchors and held results, and the change feed, on `@tjalve/memex-sqlite`. The `memex-facts` CLI replays claims into a database file.
- **`@tjalve/memex-sqlite`** — `openDatabase` (WAL, busy timeout, foreign keys), migrations per scope with `SCHEMA_DRIFT` and `NEWER_DATABASE` refusals, the change journal with undo, and WAL checkpoints when idle and on exit. Runs on node:sqlite or better-sqlite3 (optional peer).
- **`@tjalve/memex-storage`** — `memexPaths()`: the folders of each app on each OS, the folders the user chose, location kinds and sync warnings with a size, the missing-folder rule, the app lock, cache markers, Electron folders, and `~/Memex/README.txt`. No runtime dependencies.
- **`@tjalve/memex-folders`** — `listFolder`, `scanFolder`, `plan`, `watchFolder`: a folder the user chose, listed without downloading online-only files, compared with a journal, and the online-only confirmation before an import reads. The `memex-folders` CLI. Depends on `@tjalve/memex-storage` only.
- **`@tjalve/memex-import`** — the shared import pipeline: walk folders and their zip and gzip files, detect the reader, normalize, hash, dedupe on provenance, preview as a rolled-back transaction, commit per file, and undo a batch; every file and record accounted for. Readers stay in the apps. The `memex-import` CLI. Built on memex-sqlite, memex-schema, memex-folders, and the archive zip reader.
- **`@tjalve/memex-archive`** — the archive library for collectors and the `memex-archive` CLI. No runtime dependencies.
- **`@tjalve/memex-surfaces`** — the capability registry (`<app>.<noun>.<verb>`), the stdio MCP server, the `/api/v1` router with OpenAPI 3.1 from zod, the request checks and per-launch token, the `memex-<app>` CLI verbs, the app record with `discover()` and `connect(app).call()`, and the `memex-surfaces check` CLI.
- **`@tjalve/memex-node-client`** — the Memex.Node client generated from `openapi/node.v1.yaml` over the pipe or socket of the app record, `ensureNode` (the service launcher: newest installed copy, drain of an older copy, start within 10 s), and `ensureApp` for headless tools over stdio MCP. Its generator also writes the C# client `Memex.Node.Client` in memex.node.
- **`@tjalve/memex-packs`** — the packs of Memex.Node for apps: `PacksClient` over `node.packs.*` (catalog, status, install with progress, accept by text hash, `activePath`), read-only resolution of the pack store from `packs.json` without Node (it finds a store that Node moved), and a layout writer under the store lock for an app's own downloader (Study in v1). Depends on `@tjalve/memex-node-client` and `@tjalve/memex-storage`.
- **`@tjalve/memex-user-client`** — the clients of the two facts hubs, Memex.User and Memex.Contacts, generated from `openapi/user.v1.yaml` and `openapi/contacts.v1.yaml`; `ensureUser`; and the sync that keeps every edit: the durable outbox of corrections in the app's own SQLite database (in the same transaction as the app's edit), delivery with retries across restarts, each correction once by its id in `createdAt` order, and the change feed applied to a local copy without overwriting edits that wait. The outbox and the feed reader take a target hub. Its generator also writes the C# client `Memex.User.Client` in memex.node.
- **`@tjalve/memex-handles`** — `normalizeHandle()`: phone numbers to E.164, lowercase email addresses, platform handles as written. Depends on libphonenumber-js.
- **`@tjalve/memex-licenses`** — the license check (unknown licenses, copyleft, missing credit, restricted content), third-party notices from pnpm, Vite, .NET, Electron, fonts and `third-party.json`, pack credit lines, and the `memex-licenses` CLI. Offline, no runtime dependencies.
- **`@tjalve/memex-desktop`** — the desktop shell of every Memex app: the Electron main process with its local server (a utility process or a program), the ready line, the token cookie, the sandbox, single instance, the crash screen, About from `notices.json`, the `memex-<app>` CLI shim, the electron-builder base config (`to.memex.<app>`, NSIS per user, dmg arm64, AppImage, deb) and the release scripts, with the example app `examples/hello`. Depends on `@tjalve/memex-storage`; Electron is a peer dependency.

Consume from a module repository as a git dependency, or as a `file:` dependency during local development:

```bash
pnpm add "@tjalve/memex-storage@file:../memex.core/packages/storage"
```

`@tjalve/memex-schema` is different: it depends on `@tjalve/memex-sqlite` as `workspace:*`, so it installs only inside this workspace. A `file:` or git dependency from another repository fails with `ERR_PNPM_WORKSPACE_PKG_NOT_FOUND`. Use a released version instead: `pnpm pack` writes exact versions in place of `workspace:*`. Releases go through npm staged publishing; see [docs/releasing.md](docs/releasing.md).

## Development

```bash
pnpm install
pnpm test
```

Releases use npm staged publishing only, with no direct publish. See [docs/releasing.md](docs/releasing.md).

## License

MIT. See [LICENSE](LICENSE). Contributions take a [DCO](https://developercertificate.org/) sign-off (`git commit -s`); see [CONTRIBUTING.md](CONTRIBUTING.md). Report vulnerabilities privately; see [SECURITY.md](SECURITY.md).
