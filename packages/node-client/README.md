# @tjalve/memex-node-client

The Memex.Node client for TypeScript (MIT): the Node API of [contracts/node-api.md](../../contracts/node-api.md), the service launcher of [contracts/surfaces.md](../../contracts/surfaces.md#service-launcher), and `ensureApp` for headless Memex tools.

- `NodeClient`: every operation of [openapi/node.v1.yaml](../../openapi/node.v1.yaml) as a method, over the named pipe (Windows) or Unix socket that the app record `node.json` names. The types and operations in `src/generated/node-api.ts` are generated from the contract.
- `ensureNode()`: reads the app record, checks the process and `GET /health` over the pipe or socket, starts the newest installed copy when none runs (at most 10 s), and lets a newer copy take over while the older one drains. The client finds Node again when a connection fails or Node drains.
- `ensureApp(app)`: starts a headless tool (Contacts, Conversations, Calendar) on demand over its stdio MCP server, from the `mcp` command of its app record.

Dependencies: `@modelcontextprotocol/sdk` 1.32.1, `@tjalve/memex-storage`, `@tjalve/memex-surfaces`.

## Memex.Node

```ts
import { ensureNode } from "@tjalve/memex-node-client";

const node = await ensureNode();          // starts Memex.Node when it does not run
const status = await node.getStatus();    // GET /v1/status over the pipe or socket
console.log(node.launch?.action);         // found, started, or took-over

const lease = await node.createLease({ app: "photos", function: "photos.library-analysis", device: "gpu", memoryBytes: 3_000_000_000 });
for await (const event of await node.leaseEvents(lease.lease.id)) console.log(event.event, event.data);
```

A failed call throws a `SurfaceError` (from `@tjalve/memex-surfaces`) with Node's error body: `code`, `status`, `message`, `field`, and `hint`.

## The service launcher

`ensureService(app, options)` is the launcher for any shared service; `ensureNode` uses it for Memex.Node, and `ensureUser` will use it for Memex.User.

1. A copy that runs and is not older than the newest installed copy is used.
2. Otherwise, under the launch lock (`launch.lock` in the service's `state` folder), an older copy that runs gets `POST /v1/drain`: it gives up its single-instance lock and stops when its held work ends.
3. The newest copy is started detached, and the launcher waits until the app record names a process that answers `GET /health`, at most 10 s.

Installed copies are in `<services>/<app>/<version>/service.json` (`memex.service/1`); `servicesFolder()` gives the folder, and `MEMEX_SERVICES_DIR` overrides it. Options: `apps`, `state`, `services`, `copies` (for example a copy that an app carries), `env`, `timeoutMs`, `log`.

## Headless tools

```ts
import { ensureApp } from "@tjalve/memex-node-client";

const contacts = await ensureApp("contacts");
const tools = await contacts.listTools();                                 // contacts_people_list, ...
const page = await contacts.call("contacts.people.list", { q: "anna" });  // the capability's output
await contacts.close();
```

The command comes from `mcp` in the app record, or from `options.command`. The server gets the caller's environment, so it uses the same Memex folders.

## Generate

```sh
node scripts/generate.mjs                    # src/generated/node-api.ts
node scripts/generate.mjs --csharp <file>    # also the C# client of memex.node
node scripts/generate.mjs --check            # fails when the generated file is not current (pnpm test runs it)
```

The tests check every fixture of `contracts/fixtures/node/` against the OpenAPI file and write it back byte for byte, and they run the launcher against a stand-in service on a real pipe or socket.
