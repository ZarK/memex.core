# Memex.Node API

**Version:** 1 (25 October 2026). The OpenAPI file is [openapi/node.v1.yaml](../openapi/node.v1.yaml).

Memex.Node is one service for each OS login account on each machine. It runs models, serves packs ([packs.md](packs.md)), and sends model calls to backends that the user adds. It keeps no user data. Its scheduler serves the requests of all apps in the way that is best for the user.

## Choices in this contract

- **Transport.** Node listens on a named pipe (Windows) or a Unix socket (macOS, Linux) for each OS login account. On Windows, the pipe has a new random name at each start, and it refuses network sign-ins. See [Transport](#transport). Memex.User and every app use loopback HTTP with a token ([surfaces.md](surfaces.md)).
- **Routes to another Node.** One Memex Node sending work to another Memex Node waits for pairing in v2. Node v1 has no network listener. The `node` route and the `node` backend type stay in the format for v2, and v1 refuses them with 409 `route_unavailable`. See [Route kinds](#route-kinds).
- **Library models in Photos.** Photos runs its library models in its own process in v1 and takes a GPU lease from Node ([Leases](#leases)).
- **Live voice.** Live voice has both paths: Node's own pipeline and a relay to a realtime backend ([Sessions and realtime](#sessions-and-realtime)).

## Transport

Node is one service for each OS login account: the account that a person signs in to Windows, macOS, or Linux with. The apps of one account cannot reach the Node of another account.

- **Windows:** a named pipe with the name `memex-node-<32 lowercase hex>`. The full path is `\\.\pipe\memex-node-<32 lowercase hex>`.
  - At each start, Node makes a new name from 128 random bits of the OS random number generator. It never uses a fixed or derived name, so another account cannot make the pipe first while Node is stopped.
  - Node creates the pipe as the first instance of that name. When the name exists, Node makes a new name and tries again, at most 3 times, and then stops with an error.
  - Node writes the name only to `running.socket` in its app record, which only the current account can read (see below).
  - The access list of the pipe lets only the current account open it. It also refuses network sign-ins: a deny entry for the Network group (SID `S-1-5-2`) comes before the allow entry. So a caller that reaches the pipe from another computer over file sharing (SMB) is refused, also when it signs in as the same account. Node also sets the flag that rejects remote clients (`PIPE_REJECT_REMOTE_CLIENTS`) where the server API lets it.
- **macOS and Linux:** the Unix socket `node-<pid>-<8 hex>.sock`, new at each start, in the `state` folder of Node ([storage.md](storage.md)), with mode `0600`. The folder is in the account's own home folder and has mode `0700`, so other accounts cannot take the name. Each start has its own socket, so a draining Node and the newer copy listen at the same time; Node removes only its own socket when it stops, and at start it removes the sockets of processes that are gone. When the path in the `state` folder is longer than the OS allows for a socket (103 bytes on macOS, 107 on Linux), the socket goes into `memex-node` (mode `0700`) in the short private folder of the OS instead: `$TMPDIR` on macOS, `$XDG_RUNTIME_DIR` on Linux. Node uses that folder only when it is an absolute folder, not a link, that no other account can open; otherwise Node stops with exit code 1 and says why. Clients read the path from the app record as always.
- HTTP/1.1 goes over the pipe or socket. The `Host` header is `localhost`. Server-sent events and WebSocket work over it.
- Node needs no token on the pipe or socket, because the OS lets only the current account open it.
- Node writes its app record `<apps>/node.json` with `running.socket` ([surfaces.md](surfaces.md#app-record)). On Windows, Node sets the access list of the record so that only the current account can read it. On macOS and Linux, the record has mode `0600`. When Node stops, it sets `running` to `null`. The next start uses a new pipe name.
- A client reads the pipe or socket from the app record before it connects, and again after a connection fails. It never builds the name itself.
- Browsers cannot reach Node. An app with a browser UI calls Node from its own server.
- Node v1 listens on nothing else: no network address and no loopback port. For development only, `--dev-loopback` makes Node listen on `127.0.0.1`, port 0, with the token and the request checks of [surfaces.md](surfaces.md).
- One Node runs for each account. It stops after 10 minutes without requests, jobs, leases, or sessions. The clients start it again (`ensureNode`; [Service launcher](surfaces.md#service-launcher)).
- In v1, Node trusts the `app` that a caller states. A check of the code signature of the caller comes in 1.1.

## Endpoints

| Method and path | Does |
|---|---|
| `GET /health` | `{ "status": "ok", "app": "node", "version": "1.0.0" }`; `status` is `draining` after a drain |
| `POST /v1/drain` | A newer copy takes over: Node stops taking new work and stops when its held work ends ([Drain](#drain)) |
| `GET /v1/status` | Version, devices (GPU name and memory), the work in each lane, and the counts of leases, sessions, and backends |
| `POST /v1/apps/register` | An app states its functions and packs at start ([Functions](#functions-and-routes)) |
| `GET /v1/capabilities` | What Node can do now, and why a capability is not ready |
| `GET /v1/functions` | Every registered function with its route and state |
| `GET`, `PUT /v1/routes` | The route of each function and the default route (settings) |
| `POST /v1/uploads` | Stores bytes for a later call ([Bytes](#bytes)) |
| `POST /v1/run` | A short call; the response has the result |
| `POST`, `GET /v1/jobs`; `GET`, `DELETE /v1/jobs/{id}`; `GET /v1/jobs/{id}/events`; `GET /v1/jobs/{id}/outputs/{name}` | Long calls with progress, outputs, and cancel |
| `POST /v1/leases`; `GET`, `DELETE /v1/leases/{id}`; `POST /v1/leases/{id}/renew`; `GET /v1/leases/{id}/events` | A device lease for model work that an app runs in its own process |
| `GET /v1/queue` | All waiting and running work, each with its wait reason |
| `POST /v1/sessions/prepare`; `GET /v1/realtime`; `DELETE /v1/sessions/{id}` | Live voice and vision sessions |
| `GET /v1/packs`; `GET`, `DELETE /v1/packs/{id}`; `POST /v1/packs/{id}/install`; `GET /v1/packs/{id}/events`; `GET /v1/packs/{id}/license`; `POST /v1/packs/{id}/accept`; `GET`, `PUT /v1/packs/location` | The pack store |
| `GET`, `POST /v1/backends`; `POST /v1/backends/discover`; `PATCH`, `DELETE /v1/backends/{id}` | Backends that the user adds |
| `GET /v1/models`; `POST /v1/chat/completions`; `POST /v1/embeddings`; `POST /v1/audio/transcriptions`; `POST /v1/audio/speech`; `GET /v1/audio/voices` | The OpenAI-compatible subset |

`PUT /v1/routes`, the writes to `/v1/backends`, and `PUT /v1/packs/location` change the settings of Node. They are for the Node settings UI (`@tjalve/memex-node-ui`) and the `memex-node` CLI. An app calls them only for an action of the user.

## Drain

The service launcher ([surfaces.md](surfaces.md#service-launcher)) sends `POST /v1/drain` when a newer copy of Node is installed than the one that runs. Node answers 202 with `{ "draining": true, "pid", "version", "held" }`, where `held` counts the requests, streams, and leases that it still serves. Then:

- Node gives up its single-instance lock, so the newer copy can start. It never writes its app record again: the record belongs to the newer copy.
- `GET /health` answers `"status": "draining"`. Clients read the app record again.
- Node serves `GET /health`, `GET /v1/status`, a repeated `POST /v1/drain`, and its leases (`GET` and `DELETE /v1/leases/{id}`, `POST /v1/leases/{id}/renew`, `GET /v1/leases/{id}/events`). It refuses every other request with 503 `draining`, before it starts any work.
- Node keeps listening on its own pipe or socket (and with `--dev-loopback`, its own port and token file `token-<pid>-<8 hex>`), and removes nothing that the newer copy uses. A client sends the calls on a lease to the Node that granted it, also after it follows the newer copy for its other calls.
- Node stops when nothing is held, or after the drain time (60 seconds; `--drain-timeout-seconds`).

## Scheduling fields

Every run, job, and lease carries the fields that the scheduler needs. A session carries `app` and `function`, and its lane is `live`.

| Field | Meaning |
|---|---|
| `app` | The app id of the caller. Background work is shared between apps. |
| `function` | The function id, for example `photos.food-reading`. It selects the route and the model. |
| `lane` | Optional. `live`, `interactive`, `background`, or `idle`. The default is the lane of the function. An app uses `interactive` only while the user waits for the result. |
| `model` | Optional. `{ "id", "sha256" }` pins a native model, and `{ "id", "fingerprint" }` a model on a backend ([Result record](#result-record)). Use it to keep results comparable, for example embeddings. Without it, Node uses the model of the route. When the route has another model, the call fails with 409 `model_mismatch`. |
| `batchKey` | Optional. A string that the app chooses for work that belongs together, for example one import. The scheduler uses it to group work so that a model loads one time for each batch, and to keep a small new import ahead of library-wide work. |

While work waits, Node gives the reason:

```json
{ "reason": "model-swap", "detail": "Waiting for 12 jobs on Gemma 4 31B to finish before the model changes.", "since": "2026-11-16T21:04:11Z", "ahead": 12 }
```

| `reason` | Meaning |
|---|---|
| `queued` | Other work of the same lane runs first. |
| `higher-lane` | Live or interactive work runs first. |
| `live-session` | An open live session holds the device or backend. |
| `batching` | Node collects work for one batch. |
| `model-loading` | Node loads the model. |
| `model-swap` | Node finishes the work on another model before it changes models. |
| `device-busy` | Another program uses the GPU memory. |
| `lease-held` | An app holds a lease on the device. |
| `backend-limit` | The backend has the maximum number of calls from Node. |
| `backend-down` | The backend does not respond. `retryAt` gives the next try. |
| `pack-missing` | A pack is not installed or not accepted. |
| `idle-only` | Idle work waits until the machine is idle. |

`detail` is a sentence that an app can show. A client shows `detail` for a reason that it does not know. Later versions of the scheduler can add reasons.

Lanes:

| Lane | Use | Rule |
|---|---|---|
| `live` | Open voice and vision sessions | While a session is open, Node starts no new background or idle work on the devices and backends of that session. |
| `interactive` | The user waits | Runs before background and idle work. |
| `background` | Bulk work, for example a library or years of transactions | Shared between apps. |
| `idle` | Work that can wait for hours, for example embedding again after a model change | Runs only when the machine is idle. |

Node cannot stop a call that a backend has started. Lanes control what Node starts next.

## Functions and routes

A function is the use of a capability by one app, for example Photos food reading. Its id is `<app>.<name>`, for example `photos.food-reading`. Each function has a default model, a way to run that model in Node, and a route that the user can change.

### Registration

An app registers when it starts. A new function needs a registration, not a change to this contract.

```json
{
  "app": "photos",
  "version": "1.0.0",
  "minNodeVersion": "1.0.0",
  "functions": [
    { "name": "food-reading", "capabilities": ["food.recognize"], "lane": "background", "runsIn": "node", "required": false, "packs": ["siglip2-base-patch16-224", "gemma-4-31b-it", "caloriek"] },
    { "name": "library-analysis", "capabilities": ["library.analyze"], "lane": "background", "runsIn": "app", "required": true, "packs": ["siglip2-base-patch16-224", "yunet-2023mar", "auraface-glintr100", "pp-ocrv6-small-det", "pp-ocrv6-medium-rec"] }
  ]
}
```

- `capabilities` lists the Node capabilities that the function uses.
- `runsIn` is `node` (Node runs the model) or `app` (the app runs it in its own process with packs from the store and a lease).
- `required`: `true` when the app does not work without the function; `false` when the feature waits until the function is ready.
- The response gives the state of each function: `ready`, `needs-pack`, `needs-acceptance`, `needs-backend`, or `unavailable`, with `reason`.
- Node keeps the last registration of each app in its `state` folder, so the settings show every function also when the app does not run.
- An app with `minNodeVersion` above the version of Node gets 409 `node_too_old`. The client then starts the newer Node copy.

### Functions in v1

| Function | Capabilities | Default model | How Node runs it (`auto`) | Lane | Other routes |
|---|---|---|---|---|---|
| `photos.food-reading` | `food.recognize` | SigLIP 2 base (food check), Gemma 4 31B (reading), CalorieK (second estimate) | ONNX for the food check and CalorieK, in Node. Reading needs a model server with Gemma 4 31B, which needs about 20 GB of GPU memory wherever it runs. Node v1 has no generative runtime: without a `url` route, food reading is off and the food check still runs. | background; new photos first, with their own batch key | `url`: the reading step goes to an OpenAI-compatible chat endpoint with image input. The food check and CalorieK stay in Node. |
| `photos.image-tools` | `image.upscale`, `image.denoise`, `image.colorize` | Real-ESRGAN x2 and x4, SCUNet, DDColor | ONNX, in tiles at the original resolution | interactive | none in v1 |
| `photos.library-analysis` | `library.analyze` | SigLIP 2, YuNet, AuraFace, PP-OCRv6, the sensitivity-check classifier | In the Photos process, with Memex.Node.Runtime and packs from the store. Photos takes a GPU lease. Execution moves into Node in 1.1. | background | none in v1 |
| `finance.merchant-embeddings` | `embed.text` | multilingual-e5-small | ONNX | background | `url` (`/v1/embeddings`) |
| `studio.sensitivity-check` | `sensitivity.check` | the classifier of the Photos sensitivity check | ONNX on the CPU | interactive | none |
| `workspace.chat` | `chat`, `vision` | none in Node v1 | A backend that the user added and that has the capability, chosen by availability and measured duration | interactive | `url` |
| `workspace.embeddings` | `embed.text` | multilingual-e5-small | ONNX | interactive | `url` (`/v1/embeddings`) |
| `workspace.speech-to-text` | `stt` | Whisper large-v3-turbo; whisper-small on small machines | ONNX (sherpa-onnx or ONNX Runtime) | interactive | `url` (`/v1/audio/transcriptions`) |
| `workspace.text-to-speech` | `tts` | Kokoro-82M | ONNX, streamed | interactive | `url` (`/v1/audio/speech`) |
| `workspace.live-voice` | `realtime` | Silero VAD, Whisper, the `workspace.chat` route, Kokoro | The streaming pipeline of Node | live | `url`: a relay to a realtime-capable backend |

### Route kinds

```json
{
  "default": { "kind": "auto" },
  "functions": {
    "photos.food-reading": { "kind": "url", "backend": "bk_3c9e", "model": "gemma-4-31b-it" }
  }
}
```

| Kind | Fields | Meaning |
|---|---|---|
| `auto` | none | The default. Node runs the function with its own engine. Only `chat`, `vision`, and the chat step of live voice, which have no engine in Node v1, go to a backend that the user added. |
| `url` | `backend`, `model`; optional `concurrency`, `also` | Calls go to one backend and one model at that backend. The backend holds the URL and its key. This is the compatible API URL that the user can give for a function. `concurrency` holds the function to at most that many calls at the backend. `also` lists more targets, each with `backend`, `model`, and optional `concurrency`: the function shares its calls between them. |
| `node` | `backend` (a backend of type `node`) | Calls go to another Memex Node. Reserved for v2, with pairing. As the `default` route, it will send every function without its own route to that Node. |

Rules:

- The user sets routes in the Node settings of any app, or with `memex-node routes`.
- In v1, `PUT /v1/routes` refuses a route of kind `node`, as the default or for a function, with 409 `route_unavailable`. Node keeps the routes that it had. Node v1 never sends work to another Memex Node, and it takes no work from one, because it has no network listener.
- Node never changes a route by itself. It never runs a function on another model as a fallback, because the results of another model are not comparable.
- While the backend of a `url` route is down, jobs wait with `backend-down` and `retryAt`. The wait between tries starts at 5 seconds and doubles up to 5 minutes. A run waits until its deadline and then fails with 503 `backend_unavailable`.
- Node makes no assumption about machines, GPUs, the server behind a URL, or a model id. A `url` route can name a model that the server does not list.
- Each backend has a limit of calls from Node at the same time. It is the limit that the user set, or else the number that the server reports (for example `total_slots` of llama.cpp), or else a number that Node learns: it starts at 1, adds 1 while calls succeed at the limit, and halves on a 429 or a 5xx. A 429 or a 5xx also lowers a limit that the user set or the server reported, until calls succeed again. Calls above the limit wait with `backend-limit`.
- With `also`, Node sends each call to the available target with the shortest expected wait. Waiting work moves to another target when its backend goes down. A pinned call stays on the targets that match its pin; it fails with 409 `model_mismatch` when none does.
- Background work leaves one call free on a backend with a limit of 2 or more for 10 minutes after a person last used that backend.

## Capabilities

`GET /v1/capabilities` lists each capability with `engine`, the installed models, `state` (`ready`, `needs-pack`, `needs-backend`, or `unavailable`), and `reason`. The inputs and outputs are in the OpenAPI file.

| Capability | Call | Input | Output |
|---|---|---|---|
| `embed.text` | run | `texts` (at most 256), `type`: `query` or `passage` | `vectors` (L2-normalized), `dims` |
| `embed.image` | run | `images` (at most 64) | `vectors`, `dims` |
| `image.tags` | run | `images`; optional `labels` | for each image: `tags` with `label` and `score` |
| `ocr` | run | `images` | for each image: `text` and `lines` with `text`, `box`, `score` |
| `faces` | run | `images` | for each image: `faces` with `box`, `score`, `landmarks`, `vector` |
| `sensitivity.check` | run | `images` | for each image: `sensitive` (boolean) and `score` |
| `food.recognize` | job | `images` (the photos of one meal, at most 8); optional `takenAt` | `food` (boolean), `foodScore`, `reading` (`done`, `off`, or `skipped`), `items` with `name` and `grams`, and `nutrients` (`kcal`, `protein`, `fat`, `carbs`, and optionally `sugar`, `fiber`, `alcohol`, each with `value`, `low`, `high`; grams except `kcal`). See [Food recognition](#food-recognition). |
| `image.upscale`, `image.denoise`, `image.colorize` | job | `image`; `scale` (2 or 4) for upscale | the output file `image` (16-bit PNG) and `recipe` |
| `chat`, `vision`, `stt`, `tts` | OpenAI-compatible endpoints | | |
| `realtime` | sessions | | |
| `library.analyze` | lease only | | |

A `box` is `[x, y, width, height]` in pixels of the input image.

### Food recognition

`food.recognize` is one job for one meal. The app sends only camera photos. It never sends screenshots, and Node does not check where a photo came from.

```json
{
  "app": "photos",
  "function": "photos.food-reading",
  "batchKey": "import-2026-11-16",
  "input": {
    "images": [{ "base64": "/9j/...", "mediaType": "image/jpeg" }],
    "takenAt": "2026-11-16T16:42:00Z"
  }
}
```

Node runs these steps:

1. **Food check.** SigLIP 2 base scores each photo. `foodScore` is the highest score, 0 to 1. `food` is `true` when `foodScore` is 0.5 or more.
2. **Food reading.** The route of the function selects the reader. Gemma 4 31B reads the photo with the highest `foodScore`, one photo per meal, as in the benchmark. The other photos count only for the food check.
3. **Second estimate.** CalorieK reads the same photo in Node.
4. **Blend.** Learned weights for each nutrient combine the two estimates and give `value`, `low`, and `high`.

| `food` | `reading` | `items` | `nutrients` | Meaning |
|---|---|---|---|---|
| `false` | `skipped` | `[]` | `null` | The photos do not show food. Node ran no reader. |
| `true` | `off` | `[]` | `null` | The photos show food, and no reader can run: the function has no `url` route. Node v1 has no generative runtime of its own. The reader needs about 20 GB of GPU memory wherever it runs, so a computer with less reads only through a `url` route to another computer. The meal still counts for the eating window. |
| `true` | `done` | zero or more | an object | The reading is complete. |

Rules:

- A result with `food: false` or `reading: "off"` is a succeeded job, not an error. It needs only the food-check pack, `siglip2-base-patch16-224`.
- `reading: "done"` needs the `caloriek` pack. Without it, the function state is `needs-pack` and a job fails with 409 `pack_missing`. Node does not read without its second estimate, because the blend weights need both.
- In `nutrients`, `kcal`, `protein`, `fat`, and `carbs` are always present. `sugar`, `fiber`, and `alcohol` are optional, and Node v1 does not send them. The food tables of the app fill them from `items`.
- `blend` names the blend weights that made the values. An app reads a meal again when `blend` changes. Weights that end in `-provisional` are not learned yet: `value` is the reading alone.
- `low` and `high` hold about 8 of 10 meals, from held-out error of the blend. `value` is not the sum of `items`: use `nutrients` for totals and `items` for names and portions.
- Each `grams` value is the reading of the model; its `low` and `high` have the same ratios to the value as the `kcal` range.
- `record.models` lists the models that ran, in step order: the food check, then the reader with its `fingerprint`, then CalorieK. With `food: false` or `reading: "off"`, it lists only the food check, and `record.route` is `auto`, unless a `url` route exists.
- While the backend of a `url` route is down, or answers 429 or a 5xx, for example when no GPU is free, the job waits with `backend-down`. The tries of a job count only broken calls.
- The reader may be any OpenAI-compatible server with image input. Node asks for JSON with a schema and with thinking off. A server that refuses a field gets the request without it.
- A reply that was cut off at the token limit is a failed read, never data. Node asks again with more tokens.
- A job fails after 3 answers that cannot be read, with 503 `backend_unavailable`.
- An inline image is at most 4 MiB. The app sends a JPEG of 1024 pixels or more on its long side; Node scales each image down for each model.

Fixtures: [job-food.request.json](fixtures/node/job-food.request.json), [job-food-succeeded.json](fixtures/node/job-food-succeeded.json), [job-food-off.json](fixtures/node/job-food-off.json), [job-food-not-food.json](fixtures/node/job-food-not-food.json).

## Run

`POST /v1/run` is for calls that end in seconds.

```json
{ "app": "finance", "function": "finance.merchant-embeddings", "input": { "texts": ["CORNER BAKERY OSLO"], "type": "passage" }, "deadlineMs": 30000 }
```

The response is `{ "result": { ... }, "record": ResultRecord }`. A run waits in the queue like other work. When Node cannot end the run before `deadlineMs` (default 60 000), it returns 503 `deadline_exceeded` with the wait reason in the message. A capability that needs a job returns 400 `use_jobs`.

## Jobs

`POST /v1/jobs` takes the same fields as a run, without `deadlineMs`. It returns 202 and `{ "job": Job }`.

```json
{
  "id": "jb_8f02c1",
  "app": "photos",
  "function": "photos.food-reading",
  "lane": "background",
  "model": { "id": "gemma-4-31b-it", "fingerprint": "…64 hex…" },
  "batchKey": "import-2026-11-16",
  "state": "waiting",
  "wait": { "reason": "batching", "detail": "Collecting meal photos for one batch.", "since": "2026-11-16T21:04:00Z", "ahead": 0 },
  "progress": null,
  "createdAt": "2026-11-16T21:04:00Z",
  "startedAt": null,
  "finishedAt": null,
  "result": null,
  "outputs": [],
  "record": null,
  "error": null
}
```

- `state` is `waiting`, `running`, `succeeded`, `failed`, or `cancelled`. `wait` is set only while the state is `waiting`.
- `progress` is `{ "done", "total", "unit" }` or `null`.
- `outputs` lists files: `name`, `mediaType`, `bytes`, `sha256`, and `preview` (true for a preview). Get a file with `GET /v1/jobs/{id}/outputs/{name}`.
- `GET /v1/jobs/{id}/events` sends server-sent events. Each event is `event: job` with the full job as data. Node sends one when the job changes, at most 4 each second.
- `DELETE /v1/jobs/{id}` cancels a job that has not ended, or removes a job that has ended.
- Node keeps a job and its outputs until the app removes it, or for one hour after it ends.
- `GET /v1/jobs?app=photos&state=waiting` lists jobs.

## Leases

A lease gives an app a device for model work in its own process. In v1, Photos runs its library analysis this way. The lease lets the scheduler put live and interactive work of other apps first.

`POST /v1/leases`:

```json
{ "app": "photos", "function": "photos.library-analysis", "lane": "background", "device": "gpu", "memoryBytes": 3000000000, "model": { "id": "siglip2-base-patch16-224", "sha256": "…64 hex…" }, "batchKey": "import-2026-11-16" }
```

The response is 201 and `{ "lease": Lease }`:

| Field | Meaning |
|---|---|
| `id` | The lease id. |
| `state` | `waiting`, `granted`, `yielding`, or `ended`. |
| `device` | The device that Node gave, for example `gpu:0`. `null` while waiting. |
| `wait` | The wait reason while `waiting`. |
| `yieldBy` | Set when the state is `yielding`: the time by which the app must release the lease. |
| `expiresAt` | The lease ends at this time without a renew. |

Rules:

- The app renews the lease every 10 seconds (`POST /v1/leases/{id}/renew`). A lease without a renew for 30 seconds ends, so a stopped app does not keep a device.
- When other work needs the device, Node sets `yielding` and `yieldBy`, 5 seconds later by default. The app stops at the end of its current step and releases the lease (`DELETE /v1/leases/{id}`). Then it asks for a new lease.
- When the app does not release the lease by `yieldBy`, Node ends the lease and starts the other work.
- `GET /v1/leases/{id}/events` sends `event: lease` with the full lease when it changes.
- In v1, the scheduler does not batch the work inside a lease. The app schedules its own pipeline.

## Queue

`GET /v1/queue` lists all waiting and running work: runs, jobs, leases, and sessions. Each item has `id`, `type`, `app`, `function`, `lane`, `model`, `batchKey`, `state`, `wait`, and `since`. `?app=photos` limits the list to one app. Apps use it to show why work waits.

## Sessions and realtime

1. The app prepares a session: `POST /v1/sessions/prepare` with `app`, `function` (for example `workspace.live-voice`), `modalities` (`audio`, and `image` for camera frames), and optional `instructions` and `voice`.
2. Node returns `{ "session": { "id", "function", "pipeline", "backend", "expiresAt", "url" } }`. `pipeline` is `node` (Node's own pipeline) or `relay` (a realtime-capable backend). `url` is `/v1/realtime?session=<id>`.
3. The app opens a WebSocket on `url` before `expiresAt` (60 seconds).
4. The session ends when the socket closes, or with `DELETE /v1/sessions/{id}`.

The events are the OpenAI Realtime API events. Node v1 supports this subset:

- From the app: `session.update`, `input_audio_buffer.append`, `input_audio_buffer.commit`, `input_audio_buffer.clear`, `conversation.item.create` (text, or an image for a camera frame), `response.create`, `response.cancel`.
- From Node: `session.created`, `session.updated`, `input_audio_buffer.speech_started`, `input_audio_buffer.speech_stopped`, `conversation.item.input_audio_transcription.completed`, `response.created`, `response.output_audio.delta`, `response.output_audio_transcript.delta`, `response.output_text.delta`, `response.done`, `error`.
- Audio is 16-bit PCM, 24 kHz, mono, in base64.

The relay passes events through to the backend. Node's own pipeline serves the same events with Silero VAD, streaming speech to text, the chat route, sentence text to speech, and barge-in. The Memex app relays the browser socket from its server.

## Packs

| Endpoint | Does |
|---|---|
| `GET /v1/packs` | Lists the packs in the Node catalog and in the store. For each pack: `id`, `title`, `kind`, `state` (`not-installed`, `installing`, `installed`, `needs-acceptance`, or `refused`), `active` (the version), `versions`, `license`, `install` (progress), `path` (the folder of the active version), and `usedBy` (apps). |
| `GET /v1/packs/{id}` | One pack, with its manifest. |
| `POST /v1/packs/{id}/install` | Starts an install, optionally of `version`. Returns 202 and the pack. Without an acceptance, it fails with 409 `acceptance_required`. |
| `GET /v1/packs/{id}/events` | `event: pack` with the full pack while it installs. |
| `GET /v1/packs/{id}/license` | The license text, as `text/plain`. |
| `POST /v1/packs/{id}/accept` | Body `{ "app", "version", "textSha256" }`: the app where the user accepted, the version they saw, and the hash of the text. Records the acceptance. |
| `DELETE /v1/packs/{id}` | Removes every version that no registered app pins. |
| `GET`, `PUT /v1/packs/location` | The store folder. `PUT` with `{ "path" }` starts a move and returns 202. `GET` shows the move progress and the sync warning. |

## Backends

A backend is a model server at a URL that the user adds, for example llama.cpp, Ollama, LM Studio, or vLLM.

| Field | Meaning |
|---|---|
| `id` | The backend id. Routes use it. |
| `type` | `openai` (an OpenAI-compatible API). `node` (another Memex Node) is reserved for v2. |
| `url` | The base URL, for example `http://192.0.2.20:8000/v1`. |
| `label` | A name that the user gives. |
| `local` | `true` for a loopback or private address. `false` for every other address: the settings show a warning when the user adds it, and a permanent mark. |
| `state` | `available` or `unavailable`, from the last probe. |
| `models` | Each model: `id` and `capabilities`. The probe sets the capabilities, and the user can change them. |
| `concurrency` | The limit of calls from Node at the same time now. On `POST` and `PATCH`, the user's limit; `null` removes it. |
| `concurrencyFrom` | Where the limit comes from: `set` by the user, `reported` by the server, or `learned` by Node. |
| `hasKey` | `true` when an API key is stored. Node keeps keys in the OS credential store and never returns them. |

- `POST /v1/backends` adds a backend with `url`, `type`, and optional `label`, `apiKey`, and `concurrency`. Node probes it (`GET /v1/models`). In v1, a backend of type `node` is refused with 409 `route_unavailable`.
- `POST /v1/backends/discover` looks on `127.0.0.1` at the ports 11434, 1234, 8080, and 8000 and returns what it finds. It adds nothing.
- Node probes each backend again at an interval and after a failed call.

## OpenAI-compatible endpoints

`GET /v1/models`, `POST /v1/chat/completions` (with streaming and image input), `POST /v1/embeddings`, `POST /v1/audio/transcriptions`, and `POST /v1/audio/speech` follow the OpenAI API. `GET /v1/audio/voices` is a Memex addition: `{ "voices": [{ "id", "name", "language" }] }`.

- The request carries the scheduling fields as headers: `Memex-App` (required), `Memex-Function` (required except for `/v1/models`), `Memex-Lane`, and `Memex-Batch-Key`.
- `model` is `default` for the model of the route, or a model id from `/v1/models` to pin it.
- A JSON response has an added `memex` field with the result record. A stream sends the record in the `memex` field of its last chunk. A binary response (speech) has the header `Memex-Result` with the record as base64url JSON.

## Bytes

- An input file is `{ "upload": "up_..." }` or `{ "base64": "...", "mediaType": "image/jpeg" }`. Inline base64 is at most 4 MiB after decoding.
- `POST /v1/uploads` takes the bytes as the body, with their media type as `Content-Type`, up to 1 GiB. It returns `{ "upload": { "id", "sha256", "bytes", "mediaType", "expiresAt" } }`. An upload is removed when the work that uses it ends, or one hour after the upload.
- Node v1 reads no files of apps. Inputs arrive as bytes.
- Node removes temporary files after each call. Caches use content hashes only.

## Result record

Every result carries a record of how Node made it:

```json
{
  "node": { "id": "nd_a41f09c2", "version": "1.0.0" },
  "app": "finance",
  "function": "finance.merchant-embeddings",
  "capability": "embed.text",
  "route": "auto",
  "engine": "onnx",
  "backend": null,
  "models": [{ "id": "multilingual-e5-small", "version": "2024-02-08", "sha256": "…digest…" }],
  "device": "gpu:0",
  "lane": "background",
  "batchKey": null,
  "queuedMs": 12,
  "runMs": 48,
  "finishedAt": "2026-11-03T09:20:00Z"
}
```

- `engine` is `onnx`, `generative`, or `backend`. `backend` is `{ "id", "type", "url" }` or `null`.
- A native model has `sha256`: the pack digest ([packs.md](packs.md#digest)). A model on a backend has `fingerprint`: the SHA-256 of the backend URL, the model id, and the model object from the backend's `GET /v1/models`, as Node read it.
- An app compares results, for example embeddings, only when `sha256` or `fingerprint` is the same. After a model change, the app makes them again in the background or idle lane.

## Errors

Node uses the error body of [surfaces.md](surfaces.md#errors). Codes of Node:

| Status | Code | When |
|---|---|---|
| 400 | `invalid_input`, `use_jobs` | The input is wrong, or the capability needs a job. |
| 404 | `not_found`, `unknown_function` | No such job, lease, pack, backend, or function. |
| 409 | `not_registered`, `node_too_old`, `model_mismatch`, `pack_missing`, `acceptance_required` | The app must register first, needs a newer Node, pinned a model that the route does not have, or a pack is not ready. |
| 409 | `route_unavailable` | A route or a backend of kind `node`. Sending work to another Memex Node comes with pairing in v2. |
| 410 | `lease_ended` | The lease ended. Ask for a new one. |
| 413 | `too_large` | The body or upload is too large. |
| 422 | `license_unknown` | A license field of the pack is `unknown`. |
| 503 | `function_unavailable`, `backend_unavailable`, `deadline_exceeded` | The function cannot run now. `hint` says what the user can do. |
| 503 | `draining` | This Node drains, because a newer copy takes over. Read the app record again and send the request to the Node that it names. |

## Fixtures

[fixtures/node/](fixtures/node/) holds requests and responses: a registration, a run with its record, a waiting job, a lease that yields, the routes, a backend, the queue, and a drain. The TypeScript client (`@tjalve/memex-node-client`) and the C# client (`Memex.Node.Client`) must read each fixture and write it back without loss.

## Versioning

`/v1` changes only by additions. Each app states `minNodeVersion` at registration. The newest installed Node copy runs.
