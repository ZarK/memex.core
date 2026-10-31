# Surfaces contract

**Version:** 1 (25 October 2026). It replaces version 0.

Every Memex app and headless tool has three surfaces: an HTTP API, an MCP server, and a CLI. Other apps, agents, and scripts use these surfaces. They never read the database or the files of another app.

The reference implementation is `@tjalve/memex-surfaces`. Its command `memex-surfaces check` checks an app against this contract.

Memex.Node is a service with its own API ([node-api.md](node-api.md)). It uses the error body, `/health`, and the app record of this contract.

## Capabilities

A capability is one operation. An app defines it one time. The HTTP API, the MCP server, and the CLI are made from that definition.

| Field | Rule |
|---|---|
| `id` | `<app>.<noun>.<verb>`. `<app>` is the app id from [storage.md](storage.md). `<noun>` is plural. Each segment is `[a-z][a-z0-9]*`. Examples: `user.trips.list`, `photos.meals.list`, `finance.transactions.update`. |
| `title` | A short name for people. |
| `kind` | `read` (changes nothing) or `write`. |
| `description` | Written for agents: what it does, units, limits, and which capability to call next. At most 600 characters. |
| `input` | A JSON Schema of an object. |
| `output` | A JSON Schema. |

One id has three forms:

| Surface | Form | Example |
|---|---|---|
| HTTP | the id | `POST /api/v1/user.trips.list` |
| CLI | the id | `memex-user call user.trips.list '{"from":"2024-01-01"}'` |
| MCP | the id with `.` changed to `_` | `user_trips_list` |

## Data rules

- Field names are camelCase. The OpenAI-compatible endpoints of Memex.Node keep the snake_case names of that API.
- Times are ISO 8601 in UTC with `Z`: `2026-10-27T08:30:00Z`. Local dates are `YYYY-MM-DD`.
- Money is an integer in minor units with an ISO 4217 code: `amountMinor`, `currency`.
- Ids are strings.
- A list output is `{ "items": [...], "next": "<cursor>" }`. `next` is `null` on the last page. A list input takes `limit` and `cursor`.
- A write input takes `dryRun` (check and report, change nothing) and `idempotencyKey` (a repeat with the same key returns the first result and changes nothing). A write output has `changeId` and `summary` (one sentence for people).
- A reference to a record in another app is `{ "app": "contacts", "kind": "person", "id": "..." }`.

## HTTP API

### Listener

- The app listens on `127.0.0.1` on port 0, so the OS gives it a free port. It never listens on `0.0.0.0`, on `::`, or on a fixed port.
- The app writes the port to its app record (see below). Other programs find it there.
- Access from other machines is not part of version 1.

### Routes

| Method and path | Needs | Does |
|---|---|---|
| `GET /health` | nothing | Returns `{ "status": "ok", "app": "photos", "version": "1.0.0" }`. It never contains paths, user names, or counts of user data. |
| `GET /api/v1` | Bearer token | Lists the capabilities: `{ "app", "version", "capabilities": [{ "id", "title", "kind", "description" }], "openapi": "/api/v1/openapi.json" }`. |
| `GET /api/v1/openapi.json` | Bearer token | OpenAPI 3.1 for every capability. |
| `GET /api/v1/<id>` | Bearer token | Runs a `read` capability. The input is in `?input=<json>`, or one query parameter for each field. |
| `POST /api/v1/<id>` | Bearer token | Runs any capability. The input is the JSON body. |
| `POST /api/v1/uploads` | Bearer token | Stores a file for a later call (see [Files](#files)). |
| `GET /api/v1/files/<id>` | Bearer token | Returns a file that a capability made. |
| `POST /api/v1/auth/code` | Bearer token | Returns a code for one use of `/auth` (see [Token](#token)). |
| `GET /auth?code=<code>` | the code | Sets the cookie and redirects to `/`. |
| The UI routes of the app | cookie | The pages of the app and the routes that only its own pages use. |

A JSON body is at most 25 MB. Larger content goes through uploads.

### Checks

The server checks every request in this order. The first check that fails gives the response.

1. **Host.** The `Host` header must be `127.0.0.1:<port>` or `localhost:<port>`. Otherwise: 421 `invalid_host`. This check also applies to `/health`. It stops DNS rebinding.
2. **Token.** `/api/v1` needs the token of this launch as `Authorization: Bearer <token>`. The UI routes need the cookie of the app (see below). Otherwise: 401 `unauthorized`.
3. **Origin.** A request with an `Origin` header must come from `http://<Host>`. A `POST`, `PUT`, `PATCH`, or `DELETE` on a UI route must have this `Origin` header. Otherwise: 403 `invalid_origin`.
4. **Content type.** A request body must be `application/json`. Only `POST /api/v1/uploads` takes other types. Otherwise: 415 `unsupported_media_type`.

The server sends no CORS headers. A page from another origin cannot read a response.

### Token

- The app makes a new token at each launch: 32 random bytes, base64url without padding.
- The app writes the token to the file `token` in its `state` folder ([storage.md](storage.md)). On macOS and Linux, the file mode is `0600`. The app record names the file.
- Calls from other apps, agents, and scripts use `Authorization: Bearer <token>`. They read the token from the file that the app record names.
- The UI of the app uses a cookie. Cookies are not isolated by port, so each app has its own cookie name: `memex_<app>_token`, for example `memex_photos_token`. The cookie is `HttpOnly`, `SameSite=Strict`, and `Path=/`. An app accepts only its own cookie, and only on its own UI routes. `/api/v1` never accepts a cookie, so a page of another app on `127.0.0.1` cannot use it.
- The desktop shell sets the cookie before it loads the UI. An app that shows its UI in the user's browser opens `/auth?code=<code>`. `memex-<app> open` gets the code from `POST /api/v1/auth/code`. The code is for one use and is valid for 60 seconds. The token itself is never in a URL.

## Files

A capability that takes a file gets it through an upload:

1. The client sends `POST /api/v1/uploads` with the file bytes as the body and the media type of the file as `Content-Type`.
2. The server returns `{ "upload": { "id": "up_...", "sha256": "...", "bytes": 123, "mediaType": "image/jpeg", "expiresAt": "..." } }`.
3. The capability input refers to the file by `uploadId`.

An upload is removed when the capability that used it ends, or one hour after the upload.

A capability that makes a file returns `{ "url": "/api/v1/files/<id>", "mediaType", "bytes", "sha256" }`. The client gets the file with its token. A file stays available for at least one hour.

Files go by bytes, never by path. An app never gives another app a path to read.

## App record

Each app and service writes one app record: `<apps>/<app>.json`. `<apps>` is the `apps` folder of [storage.md](storage.md). One folder lists every installed app, so that services, the service launcher, and the Memex app find them. The JSON Schema is [schemas/surfaces/app.json](../schemas/surfaces/app.json).

```json
{
  "format": "memex.app/1",
  "app": "photos",
  "name": "Memex Photos",
  "kind": "app",
  "version": "1.0.0",
  "executable": "C:\\Users\\alex\\AppData\\Local\\Programs\\Memex Photos\\Memex Photos.exe",
  "mcp": { "command": "memex-photos", "args": ["mcp"] },
  "running": {
    "pid": 4242,
    "startedAt": "2026-11-10T08:00:00Z",
    "url": "http://127.0.0.1:53124",
    "tokenFile": "C:\\Users\\alex\\AppData\\Local\\Memex\\Photos\\State\\token"
  }
}
```

| Field | Meaning |
|---|---|
| `format` | Always `memex.app/1`. A reader refuses other values. |
| `app` | The app id. It is the same as the file name. |
| `name` | The display name. |
| `kind` | `app` (a desktop app), `service` (Memex.Node, Memex.User), or `tool` (a headless product, for example Contacts). |
| `version` | The version of the copy that wrote the record. |
| `executable` | The program that starts this app. The [service launcher](#service-launcher) uses it. |
| `mcp` | The command that starts the stdio MCP server. |
| `running` | `null` when the app is stopped. Otherwise `pid`, `startedAt`, and one endpoint: `url` and `tokenFile` for HTTP, or `socket` for Memex.Node: the named pipe (Windows, a new random name at each start) or the Unix socket ([node-api.md](node-api.md#transport)). |

Writer rules:

- The app writes the token file first. It writes the record when its listener is ready.
- Every write is a full replace: write a temporary file in the same folder, then rename it over the record.
- When the app stops, it sets `running` to `null`.

Reader rules:

1. Read `<apps>/<app>.json`. If the file is missing, the app is not installed.
2. If `running` is `null`, the app is stopped.
3. If the process `running.pid` does not exist, or `GET /health` fails or names another app, the app is stopped. The record is stale.
4. Read the token from `running.tokenFile`. Send it as `Authorization: Bearer <token>`.

## Service launcher

Memex.Node and Memex.User run one copy for each OS login account, and apps start them on demand. Headless tools (Contacts, Conversations, Calendar) are started on demand over their stdio MCP server. The reference implementation is `ensureNode`, `ensureService`, and `ensureApp` of `@tjalve/memex-node-client` (TypeScript) and `NodeApi.EnsureNodeAsync`, `ServiceLauncher`, and `AppLauncher` of `Memex.Node.Client` (C#). `ensureUser` (`@tjalve/memex-user-client`) starts Memex.User the same way, with `POST /v1/drain`. A limit of version 1: `UserApi.EnsureUserAsync` (`Memex.User.Client`, C#) does not drain yet and does not send a request again after 503 `draining`; it uses a copy that runs as it is, and while that copy drains its calls get 503 `draining`. A limit of version 1: Memex.Contacts has no `POST /v1/drain` yet, so after an update a copy of it that runs is used until it stops when it is idle, and the newest copy starts at the next call.

### Installed copies

Each installed copy of a service has its own folder in the `services` folder:

| Windows | macOS | Linux |
|---|---|---|
| `%LOCALAPPDATA%\Programs\Memex\Services` | `~/Library/Application Support/Memex/Services` | `$XDG_DATA_HOME/memex/services` |

`MEMEX_SERVICES_DIR` overrides it, and must be absolute. The layout is `<services>/<app>/<version>/`, for example `<services>/node/1.0.0/`. The installers put the copies there. Each version folder holds `service.json`:

```json
{ "format": "memex.service/1", "app": "node", "version": "1.0.0", "command": "memex-node.exe", "args": [] }
```

- `version` is a semantic version and is the same as the folder name. `app` is the same as the parent folder name.
- `command` is a path inside the version folder. `args` is optional.
- A folder that breaks one of these rules, a link (for the folder or the command), or a missing command is left out. The launcher does not follow links.
- The program that wrote the app record (`executable` with `version`) is a copy too, and so is a copy that an app passes to the launcher. When a `service.json` is beside that program, it must name the same app, the same version, and that program as `command`, and its `args` are used; otherwise the record's copy is left out. Without a `service.json` the program starts without arguments.

### Installers

Every Memex app installer carries Memex.Node and Memex.User (`@tjalve/memex-desktop` packs them; see its README, "Shared services"):

- The app pins each service in `services.json` (`memex.services/1`): its version and, for each target (`win-x64`, `osx-arm64`, `linux-x64`), the archive and its SHA-256. The pack checks each archive and puts the unpacked copy in `<resources>/services/<app>/<version>/`.
- The installer (on Windows) and every start of the app copy the carried versions into the `services` folder under the lock `services.lock` in that folder. A version folder is copied beside its place as `.partial-<version>-<random>`, checked file by file, and renamed into place, so a launcher sees a whole copy or none. A version is not copied when two newer versions are installed.
- Each app that carries the services has `<services>/clients/<app>.json` (`memex.services-client/1`) with its program. An entry whose program is gone is removed (an app removed without an uninstaller, such as a macOS app moved to the Trash).
- The two newest versions of each service stay; older versions are removed, unless their program runs.
- The uninstaller removes the app's entry. When no app is left, each service that runs from the folder gets `POST /v1/drain` and is waited for, and the service folders and the `services` folder are removed. An update keeps them.
- The `services` folder must be outside the Memex folder (`~/Memex` or `MEMEX_HOME`) and the pack store. Installers and uninstallers never touch either.
- The `services` folder has the marker `memex-services.json` (`{ "format": "memex.services-folder/1" }`), written when the folder is new or empty. An installer refuses a folder that holds other files and has no marker, and an uninstaller changes nothing in it. A folder in it is a service only when it holds nothing but `<version>/` folders whose `service.json` names that service and version (and `.partial-*` or `.removing-*` leftovers). Installers and uninstallers never change or remove anything else, and the `services` folder is removed only when nothing else is in it.

### Starting a service

`ensureNode` and `ensureUser` do this:

1. Read the app record by the reader rules above. For a pipe or socket, `GET /health` goes over the pipe or socket. The copy runs when its process lives and `/health` answers `"status": "ok"`.
2. When it runs and no installed copy is newer, use it. This needs no lock.
3. Otherwise take the launch lock: the file `launch.lock` in the `state` folder of the service, created exclusively, with `{ "pid", "hostname", "startedAt" }`. A lock whose process is gone on this computer, or that is older than one minute, is taken over. Then decide again, because another launcher may have started it.
4. When an older copy runs, send it `POST /v1/drain`. It answers 202, gives up its single-instance lock, and never writes the app record again. It refuses new work with 503 `draining`, serves what it holds, and exits when nothing is held, or after its drain time. Its `/health` answers `"status": "draining"`.
5. Start the newest copy detached: no window, no handles of the caller, the caller's environment, and the folder of `command` as its working folder, so that relative `args` resolve against the version folder. The newest copy is the highest version; of equal versions, the copy in the services folder comes first.
6. Wait until the app record names a process that answers `/health` with that version or a newer one, at most 10 seconds. When the copy exits with an error first, report it.
7. Release the lock.

A client reads the app record again and sends the request once more only when the request certainly did not reach the service: the pipe, socket, or port is gone or refuses the connection (on a reused keep-alive connection a reset counts too, for `GET`, `HEAD`, `PUT`, and `DELETE`), or the service answers 503 `draining`. A draining service refuses the work before it starts it. A connection that breaks after the request was sent is reported, not retried, so a request never runs twice. The calls on a lease stay at the Node that granted it ([node-api.md](node-api.md#drain)).

### Headless tools over MCP

`ensureApp(app)` starts `mcp.command` with `mcp.args` from the app record (or a command that the caller passes) as a stdio MCP server, with the caller's environment, and waits at most 10 seconds for its answer to `initialize`. A command without a folder is looked up on `PATH`; on Windows a command script (`.cmd`, as npm writes) runs through `cmd.exe`. In one process, a second call for the same app returns the same connection while it is open. The server takes the app lock, or sends the calls to the running app (see [CLI](#cli)). A record of kind `service` is refused: a service has its own client.

## MCP

- In version 1, each app has a stdio MCP server only: `memex-<app> mcp`.
- Each capability is a tool. The tool name is the id with `_` (see above). The tool has the title, the description, and the input schema of the capability.
- Annotations: `readOnlyHint` is true for `read` capabilities. A write that deletes or merges records sets `destructiveHint`. A write that a repeat does not change sets `idempotentHint`.
- An app may leave a capability out of MCP. The description of the server says which.
- An error is a tool result with `isError: true` and the error body as text.

## CLI

The command is `memex-<app>`, for example `memex-photos`.

| Command | Does |
|---|---|
| `memex-<app> mcp` | Starts the stdio MCP server. |
| `memex-<app> call <id> [<json> \| -]` | Runs a capability. The input is the JSON argument, or standard input with `-`. It prints the output as JSON. |
| `memex-<app> capabilities [--json]` | Lists the capabilities. With `--json`, it includes the schemas. |
| `memex-<app> about [--json]` | Shows the name, version, app id, license, the third-party notices, and the data folder. |
| `memex-<app> open` | Starts the app, or shows its window. A headless tool has no UI: the command fails with exit code 2. |
| `memex-<app> doctor [--json]` | Checks the folders, the sync warnings ([storage.md](storage.md)), the app record, the token file, and the services that the app uses. |

- When the app runs, `call` sends the call to it through the app record.
- When the app does not run, `call` runs the capability in its own process. It first takes the app lock of the storage library, so that two processes never write one database.
- Output is for people by default. `--json` gives JSON on standard output.
- Exit codes: 0 for success, 1 for a failure, 2 for a usage error. On a failure, the CLI prints the error message on standard error, or the error body on standard output with `--json`.

## Errors

All three surfaces use one error body:

```json
{ "error": { "code": "invalid_input", "message": "from: Invalid date.", "field": "from", "hint": "Use YYYY-MM-DD." } }
```

`code` and `message` are always present. `field` names the input field when one is wrong. `hint` tells how to fix the call. Codes are snake_case.

| Status | Codes |
|---|---|
| 400 | `invalid_input`, `invalid_json` |
| 401 | `unauthorized` |
| 403 | `invalid_origin`, `forbidden` |
| 404 | `not_found`, `unknown_capability` |
| 405 | `method_not_allowed` |
| 409 | `conflict` |
| 413 | `too_large` |
| 415 | `unsupported_media_type` |
| 421 | `invalid_host` |
| 422 | `rejected` |
| 500 | `internal` |
| 503 | `unavailable` |

An app can add codes for its own domain. A client handles an unknown code by its status.

## Versioning

- `/api/v1` changes only by additions: new capabilities, new optional input fields, new output fields. A client ignores output fields that it does not know.
- A change that breaks a client needs `/api/v2`. The app then serves both for one minor version.
- A capability id does not change within `/api/v1`.

## Changes from version 0

- Names are `<app>.<noun>.<verb>`; MCP tools are `<app>_<noun>_<verb>`; the CLI is `memex-<app>`.
- Port 0, the token, the cookie names, the request checks, the app record, and uploads are new.
- Remote access through a private network is removed from version 1.
- `GET /health` adds `app` and `version`.
