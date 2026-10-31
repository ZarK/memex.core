# @tjalve/memex-surfaces

The reference implementation of [contracts/surfaces.md](../../contracts/surfaces.md) (version 1, draft for 27 October 2026): every Memex app defines each operation once as a capability, and gets its HTTP API, its stdio MCP server, and its `memex-<app>` CLI from that definition. It also has the request checks, the app record `memex.app/1` with `discover()` and `connect(app).call()`, and the `memex-surfaces check` command that checks an app against the contract.

It is extracted from Memex Finance (the capability registry, the MCP server, `/api/v1`, the CLI, the API guard) and Memex Study (the request boundary), with an app prefix in every id.

Dependencies: `@modelcontextprotocol/sdk` 1.32.1, `zod` 4.6.6, and `@tjalve/memex-storage`.

## Define capabilities

```ts
import { z } from "zod";
import { SurfaceError, createRegistry, defineRead, defineWrite, listInput, listOutput, writeResult } from "@tjalve/memex-surfaces";

const person = z.object({ id: z.string(), name: z.string() });

export const registry = createRegistry({
  app: "contacts",            // the app id from contracts/storage.md
  name: "Memex Contacts",
  version: "1.0.0",
  capabilities: [
    defineRead({
      id: "contacts.persons.list", // <app>.<noun>.<verb>; MCP tool contacts_persons_list
      title: "List persons",
      description: "Lists persons by name. Then call contacts.persons.get for one.", // for agents, at most 600 characters
      input: z.object({ ...listInput(), q: z.string().optional() }),               // limit and cursor
      output: listOutput(person),                                                  // { items, next }
      handler: async (input, ctx) => db.listPersons(input),
    }),
    defineWrite({
      id: "contacts.persons.merge",
      title: "Merge persons",
      description: "Merges the person from into the person into.",
      input: z.object({ from: z.string(), into: z.string() }), // dryRun and idempotencyKey are added
      output: writeResult({ into: z.string() }),             // changeId, summary, ...
      annotations: { destructive: true },
      handler: async (input) => {
        if (!db.has(input.from)) throw new SurfaceError("not_found", `There is no person ${input.from}.`, { field: "from" });
        return db.merge(input); // the app does what dryRun and idempotencyKey say
      },
    }),
  ],
});
```

The registry refuses an id that is not `<app>.<noun>.<verb>`, a second definition, a description longer than 600 characters, and an input that is not a `z.object`. It parses every input strictly: an unknown field is `invalid_input` and names the fields there are. A handler throws `SurfaceError(code, message, { field, hint })`; every surface renders it as the one error body `{ "error": { "code", "message", "field"?, "hint"? } }` with the status of the code. Only the caller's own input gives 400: input JSON that does not parse is `invalid_json` (`parseInputJson()`), and an input that fails the schema is `invalid_input` with the field. Any other error, also a `ZodError` or a `SyntaxError` from inside a handler, is 500 `internal`.

A handler gets `ctx`: `ctx.origin` (`user`, `agent`, `api`, or `cli`; a call that `memex-<app> mcp` or `memex-<app> call` sends on to the running app keeps `agent` or `cli`), `ctx.call(id, input)` for another capability, `ctx.upload(uploadId)` for an uploaded file (removed when the call ends), and `ctx.file(bytes, mediaType)` for a file it makes (`{ url, mediaType, bytes, sha256 }`).

## Serve the app

```ts
import { currentMemexPaths } from "@tjalve/memex-storage";
import { serveApp } from "@tjalve/memex-surfaces";

const paths = currentMemexPaths("contacts");
const running = await serveApp({ registry, kind: "tool", data: paths.data, state: paths.state, ui: optionalUiHandler });
// The app lock is held; running.server.url is http://127.0.0.1:<port from the OS>; <state>/token holds the token
// of this launch; <apps>/contacts.json is the app record. On exit:
await running.stop(); // running: null in the record, the server closes, then the lock is released
```

`serveApp()` takes the app lock of `@tjalve/memex-storage` for the data folder first (it throws `AppLockedError` when another process holds it), so that `memex-<app> call` in another process never writes the database while the app runs. An app that takes the lock itself at its start passes it as `lock`, and then releases it itself. Then `serveApp()` writes the token file (mode `0600` on macOS and Linux; on Windows an access list with only this account), and the record when the listener is ready. `startServer()` is the server alone. The server answers:

| Route | Needs |
|---|---|
| `GET /health` | nothing: `{ status: "ok", app, version }` |
| `GET /api/v1`, `GET /api/v1/openapi.json` (OpenAPI 3.1 from the zod schemas) | Bearer token |
| `GET /api/v1/<id>` (reads; `?input=<json>` or a parameter per field), `POST /api/v1/<id>` (JSON body, at most 25 MB) | Bearer token |
| `POST /api/v1/uploads`, `GET /api/v1/files/<id>` | Bearer token |
| `POST /api/v1/auth/code`, then `GET /auth?code=<code>` (one use, 60 seconds; sets `memex_<app>_token` and redirects to `/`) | Bearer token, then the code |
| every other path: the `ui` handler, or 404 for a headless tool | the app's cookie |

Every request passes `checkRequest()` first, in the order of the contract: Host is `127.0.0.1:<port>` or `localhost:<port>` (421 `invalid_host`, also on `/health`), the token (401 `unauthorized`; `/api/v1` never takes the cookie), Origin (403 `invalid_origin`: any Origin must be the app's own, and a UI mutation must have one), and the content type (415 `unsupported_media_type`: a body is `application/json`, except an upload). The server sends no CORS headers. A call to `/api/v1` has the origin `api`, unless the `x-memex-origin` header says `agent` or `cli` (`memex-<app> mcp` and `memex-<app> call` send it on with the token; other values are ignored). An app with its own server uses `checkRequest()`, `routeKind()`, `forwardedOrigin()`, and `handleApiV1()` directly.

## The CLI

```ts
#!/usr/bin/env node
import { runCli } from "@tjalve/memex-surfaces";
process.exitCode = await runCli(process.argv.slice(2), { registry, license: "MIT", notices, open, doctor });
```

| Command | Does |
|---|---|
| `memex-<app> mcp` | Starts the stdio MCP server. |
| `memex-<app> call <id> [<json> \| -]` | Runs a capability and prints JSON. When the record says the app runs, the call goes to it; otherwise it runs in this process under the app lock of `@tjalve/memex-storage`. |
| `memex-<app> capabilities [--json]` | Lists the capabilities; `--json` includes the schemas. |
| `memex-<app> about [--json]` | Name, version, app id, license, notices, data folder. |
| `memex-<app> open` | Calls `open`; without one (a headless tool) it exits 2. |
| `memex-<app> doctor [--json]` | Folders, sync warnings, the app record, the token file, and the app's own `doctor` checks. |

Exit codes: 0 success, 1 failure (the message on standard error, or the error body on standard output with `--json`), 2 usage error.

The calls of one process share one app lock, so parallel MCP tool calls do not lock each other out; another process that holds the lock (the running app) makes the call fail with `unavailable`. When the app's process runs and accepts the connection but `GET /health` does not answer in 2 seconds, the call waits up to 15 seconds more; if the app still does not answer, the call fails with `unavailable` and never runs beside the busy app.

## MCP

`createMcpServer(registry)` has one tool per capability: the id with underscores, the title, the description, the strict input schema, and `readOnlyHint`, `destructiveHint` (writes), `idempotentHint`, and `openWorldHint: false`. A capability with `mcp: false` is left out, and the server description names it. Calls go to the registry, so a bad input is a tool result with `isError: true` and the error body. `serveMcp()` serves it over standard input and output; stdio is the only MCP transport in version 1.

## Find and call another app

```ts
import { connect, discover, discoverAll } from "@tjalve/memex-surfaces";

const found = await discover("photos"); // { state: "not-installed" | "stopped" | "running", record, stale? }
const photos = await connect("photos"); // throws SurfaceError unavailable when it does not run
const meals = await photos.call("photos.meals.list", { from: "2026-01-01" });
// photos.call(id, input, { origin: "agent" }) sends on the origin of a caller this process serves (agent or cli).
```

`discover()` follows the reader rules: no record is not installed; `running: null`, a gone process, or a `/health` that fails or names another app is stopped. When the process accepted the connection but `/health` did not answer in time, the result also has `unresponsive: true`: the app may be busy, not gone. A record with a `socket` (Memex.Node) is checked by its process only, and `connect()` leaves it to Node's own client. The `socket` is a local Windows named pipe (`\\.\pipe\<name>`; Node picks a new random name at each start) or an absolute Unix socket path; a pipe on another computer is refused. `writeAppRecord()`, `readAppRecord()`, and `markStopped()` write and read `<apps>/<app>.json` (a full replace each time). Only this OS account can read the record: on macOS and Linux the file has mode `0600` and a new apps folder `0700`. On Windows the writer gives the temporary file an access list with one entry, full control for this account, while it is still empty (before any byte of the record is written and before the rename over the record); the record does not take the entries of the apps folder (for example Administrators, or a folder that `MEMEX_APPS_DIR` names), also not the copies that a folder with an older access list (such as a user profile Temp folder) gives a new file without marking them as inherited. The writer reads the list back and writes nothing when it names another account, the system account included. When the access list cannot be set (`icacls` fails), nothing is written. An app that writes its record without this library, such as Memex.Node, must do the same. `memex-surfaces check` fails a record (and a token file) that other accounts can read: `record.mode` and `token.mode` on macOS and Linux, `record.acl` and `token.acl` on Windows (the access list may name only this account and the system account, and must not take entries from the folder). The apps folder comes from `@tjalve/memex-storage` (`MEMEX_APPS_DIR` overrides it).

## memex-surfaces check

```bash
memex-surfaces check <app> [--apps <dir>] [--json] [--skip-commands] [--timeout <seconds>]
```

Checks an installed app against the contract: the app record; when the app runs, `/health`, the four request checks, `/api/v1` (ids, kinds, descriptions), OpenAPI 3.1, unknown ids, and no CORS headers; and, through the record's `mcp` command, the MCP tools (names, annotations, that each is a capability, the error body) and the `memex-<app>` CLI (`capabilities --json`, `about --json`, the error body, exit code 2). Start the app first to check its HTTP API. It exits 1 when a check fails.
