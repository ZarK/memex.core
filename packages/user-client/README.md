# @tjalve/memex-user-client

The client of the two facts hubs for TypeScript (MIT): Memex.User, for facts about the owner, and the facts API of Memex.Contacts, for facts about other people. It carries the sync that keeps every edit, so apps do not each build it: what a person enters is saved in the app's own database at once and reaches the hub in the background.

- `UserClient` and `ContactsClient`: every operation of [openapi/user.v1.yaml](../../openapi/user.v1.yaml) and [openapi/contacts.v1.yaml](../../openapi/contacts.v1.yaml) as a method, over the loopback URL and token of the app record. The types (`UserRecord`, `UserTripFields`, `ContactsCorrection`, and the rest) and the operations in `src/generated/` are generated from the contracts.
- `ensureUser()` (and `ensureContacts()`): reads the app record, checks the process and `GET /health`, and starts the newest installed copy detached when none runs, waiting at most 10 s ([surfaces.md](../../contracts/surfaces.md#service-launcher)). The client finds the hub again when it stopped (idle exit), moved to a new port, or answers 503 `draining`. When a newer copy of Memex.User is installed than the one that runs, `ensureUser()` sends the running copy `POST /v1/drain` and starts the newer copy at once.
- `FactsSync`: the outbox, the background sync, and the local copy ([facts.md](../../contracts/facts.md#the-outbox), [user-records.md](../../contracts/user-records.md#edits-are-saved-locally-and-sync-in-the-background)).

Dependencies: `@tjalve/memex-node-client` (the service launcher and the transport), `@tjalve/memex-sqlite`, `@tjalve/memex-storage`, `@tjalve/memex-surfaces`.

## Edits that are always accepted

```ts
import { openDatabase } from "@tjalve/memex-sqlite";
import { nodeSqlite } from "@tjalve/memex-sqlite/node-sqlite";
import { FactsSync } from "@tjalve/memex-user-client";

const db = openDatabase(file, { driver: nodeSqlite });          // the app's own database
const sync = new FactsSync({ db, app: "photos", appVersion: "1.4.0", hubs: ["user", "contacts"] });
sync.start();                                                      // the background sync

// The person renames a trip: the app's own row and the correction commit together.
db.transaction(() => {
  db.run("UPDATE photo_trips SET title = ? WHERE id = ?", title, localTripId);
  sync.save("user", { op: "set", record: tripId, fields: { title } });
});

sync.store.record("user", tripId);   // the local copy: the person's value now, the hub's values for the rest
sync.status("user");                 // { waiting, held, refused, failures, lastError, retryAt } for a "waiting to sync" sign
```

- `save(hub, correction)` writes the correction to the outbox and the edit to the local copy, in the caller's transaction when there is one. It makes `id` (`cor_` and a UUID v7) and `createdAt` (the time the person acted) when they are left out. It never fails because a hub is stopped, starting, or failing.
- A `create` gets a local id (`local_…`). A later correction may name that local id as its record; it waits until the hub returns the record id of the create, and the local copy then keeps the record under the hub's id.
- The sync sends each hub's outbox in `createdAt` order, at most 500 corrections in one call, and starts the hub on demand (`launcher: { start: false }` never starts it). After a failure it waits 1 s, doubling up to 5 minutes. The outbox is in the app's database, so it goes on after a restart.
- A correction leaves the outbox only when the hub returns a result with its `id`. A lost answer leaves it, and the next send is a repeat that the hub stores once.
- When the hub refuses a whole call (400), the sync sends its corrections one at a time. A correction that is still refused stays with its error as a mark, with the corrections that need its local id, and is tried again when `appVersion` changes. A held correction (stored, not applied) keeps a mark until a later correction of the same field or record.
- The feed reader applies `<hub>.changes.list` to the local copy when the change's version is equal to or higher than the local one, to every field that has no correction in the outbox and no mark. A correction that comes back `superseded`, with `overridden`, `repeatOf`, or another record, makes the sync read that record once.

`syncOnce()`, `send(hub)`, and `pull(hub)` run one round now; they report what was delivered, repeated, held, refused, read back, and applied, and never throw because a hub cannot be reached.

The client's tables live beside the app's tables: `memex_facts_outbox`, `memex_facts_held`, `memex_facts_local_id`, `memex_facts_cursor`, `memex_facts_copy`, and `memex_facts_read_back` (the records to read back once after a write, kept until the read is applied, so a read that fails is done in a later round), with the migration scope `memex-user-client` in `schema_migrations`. The C# client (`Memex.User.Client` in memex.node) uses the same tables and records its migrations in its own `memex_facts_migrations` table.

## The API

```ts
import { ensureUser } from "@tjalve/memex-user-client";

const user = await ensureUser();                              // starts Memex.User when it does not run
const page = await user.tripsList({ from: "2025-01-01" });   // POST /api/v1/user.trips.list
console.log(user.launch?.action);                             // found or started
```

A failed call throws a `SurfaceError` (from `@tjalve/memex-surfaces`) with the hub's error body. Memex.Contacts has no drain in version 1: a copy of it that runs is used until it stops when it is idle, and a newer installed copy starts at the next start.

## Generate

```sh
node scripts/generate.mjs                     # src/generated/user-api.ts and contacts-api.ts
node scripts/generate.mjs --csharp <folder>   # also UserApi.g.cs and ContactsApi.g.cs of Memex.User.Client (memex.node)
node scripts/generate.mjs --check             # fails when a generated file is not current (pnpm test runs it)
```

The tests check every fixture of `contracts/fixtures/user/` and `contracts/fixtures/contacts/` against its schema and write it back byte for byte, and run the outbox, the sync, and the local copy against the real facts engine of `@tjalve/memex-facts`, with the User hub and with the Contacts hub (merge, pin, a create with `person`, unmerge, and a held unmerge). The Contacts target is not yet proven against the running Memex.Contacts service, until that service serves the facts API of [contacts-records.md](../../contracts/contacts-records.md).

## Proof run

`bash proof/proof.sh <empty folder> <memex.user folder> <user-outbox-proof program>` puts the real Memex.User in a scratch services folder (its own Node.js runtime and service.json, running the built memex.user folder) and runs a small TypeScript app (`proof/proof-app.mjs`) and the C# app of memex.node (`tools/UserOutboxProof`) against it: edits saved while User is stopped, restarts of the apps and of User, a lost answer, the feed with edits that wait, a check that each field has the value of the edit made last, creates and edits of their local ids, a correction that User refuses (400) in a call with good ones, a held correction, a merge that comes back through the feed, and a check that every correction arrived once. Each step checks its sync report (`--expect`), and the script ends with exit code 1 when a step did not have its result. It ends with the C# round trip of every user and contacts fixture.
