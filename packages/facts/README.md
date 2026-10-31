# @tjalve/memex-facts

The facts engine that Memex.User and Memex.Contacts both run. It implements [contracts/facts.md](../../contracts/facts.md): claims per producer scope, joins by kind, combining with provenance per field and per list element, review reasons, corrections that survive re-inference, and the change feed. The kinds come from [user-records.md](../../contracts/user-records.md) v2 and [contacts-records.md](../../contracts/contacts-records.md), as data that each hub registers.

It runs on [`@tjalve/memex-sqlite`](../sqlite/README.md) in the hub's own database file. Its tables start with `facts_` and its migrations have the scope `memex-facts`, so a hub keeps its other tables in the same file.

```ts
import { openDatabase } from "@tjalve/memex-sqlite";
import { nodeSqlite } from "@tjalve/memex-sqlite/node-sqlite";
import { openFacts, userHub } from "@tjalve/memex-facts";

const db = openDatabase(join(paths.data, "user.db"), { driver: nodeSqlite });
const facts = openFacts(db, { hub: userHub }); // contactsHub for Memex.Contacts

facts.writeClaims({ scope: "photos.trips", claims });          // user.claims.write
facts.writeCorrections({ corrections });                       // user.corrections.write
facts.listChanges({ since: cursor });                          // user.changes.list
facts.listRecords("trip", { from: "2025-01-01" });             // user.trips.list
facts.getRecord(id);                                           // user.trips.get
```

## What it does

| Part | Rule |
|---|---|
| Claims | A write replaces the claims of its scope or partition; claims not in it are withdrawn. A lower `generation` than the stored one is refused (`FactsError`, code `stale-generation`, status 409); an equal one is a repeat. An empty claims list carries the top-level `generation` when the scope has one, so a late retry of an empty run is refused too. Field values are checked against the kind's JSON Schema from `schemas/user/` or `schemas/contacts/` (400, code `invalid`). A scope uses partitions always or never. `dryRun` reports and stores nothing; `idempotencyKey` returns the first result. |
| Joins | A claim joins a record of the same subject by its kind's join rule, else starts a record with the id of its claim (`factId` of memex-schema). It joins the record it was in before when the rule still allows it, and a key that comes back gets its earlier id; when it comes back into another record, its earlier record leads there with `mergedInto`. A record whose claims all went to another record is removed with `mergedInto`. The claims of a rejected record stay in it, and no other claim joins it. |
| Combining | Spans: the union of the claims at confidence 0.5 or higher at the record's precision; coarser bounds go to `alternatives` (`coarser`); a gap over 90 days goes to review. Lists: the union, with provenance per element, and `{ add, remove }` edits. Single values: the correction, else the strongest claim (confidence, then the address book, then the newer `seen.last`); losers stay as `weaker`. Partial dates refine; dates that do not refine are a `conflict`. |
| Subjects | `userHub`: every claim is about the owner. `contactsHub`: a claim's `subject` resolves to a person: `{ person }` through merges, `{ card }` to the person of that card, `{ handle, at }` only when exactly one person holds the identity at that time and it is not shared. A claim that does not resolve is stored, counted as `unresolved`, and joins when it resolves. |
| Review | `low-confidence`, `conflict`, `suggested-end` (an open-ended home and a later home in another town), `gap`, `possible-duplicate` (a pin without a street and a text address of one subject). |
| Corrections | Stored once by `id`; a repeat returns the stored correction with its result now. A `create` with the same kind, sources, and fields as an earlier one is stored as an alias (`repeatOf`). Applied in `createdAt` order, then arrival; `overridden` and `superseded` say when a later one wins. `anchors` (the record's claim keys) find the record after a rebuild. `reject` and `restore` apply only to the record that they name, never through a merge. A `create` whose `record` id is in use gets a new id, which its result gives. Held results: `required-field`, `record-rejected`, `record-removed` (applies when the record comes back), `unknown-record`, `not-merged`. Memex.Contacts adds `unmerge`, `pin`, and `unpin`; a merged person stays as a redirect. |
| Change feed | One change per new record version, written in the same transaction: `upsert` with the record, `remove` with `mergedInto` when it was merged. A write that changes nothing writes no change and returns `changeId: null`. |

Every write makes the records of the kinds it touched again from all their claims and corrections and compares them with the stored ones, so a repeated write changes nothing. In Memex.Contacts a change to persons or identities makes every kind again, because subjects resolve through them.

What a hub does itself: the HTTP, MCP, and CLI surfaces and their JSON Schema checks; reading the owner's own Contacts reference as the owner's id and following Contacts redirects when Memex.User serves a record; and starting and stopping.

## Kinds as data

A hub passes a `HubDefinition`: its name, how subjects resolve, and a `KindRule` for each kind with its fields, required fields, lists, spans, partial dates that refine, place precision, and join rule (`never`, `same`, `home`, `workplace`, `near`, `trip`, or a function). `userHub` and `contactsHub` hold the kinds of the two contracts.

## The memex-facts CLI

```
memex-facts replay <file.jsonl> --db <file> [--hub user|contacts]
memex-facts records --db <file> [--kind <kind>] [--json]
memex-facts changes --db <file> [--since <cursor>]
memex-facts corrections --db <file>
```

Each line of a replay file is a claims write (`{ scope, partition?, claims }`) or a corrections write (`{ corrections }`). `replay` prints the counts of each line, the change-feed cursor before and after, and the records per kind; it exits with 2 when a line was refused. `records` prints each field with the claims or the correction that gave it, and its alternatives.

## Tests

`pnpm test` builds the package and runs every fixture of `contracts/fixtures/user/` and `contracts/fixtures/contacts/` through the engine, checks every output against the JSON Schemas and OpenAPI components, and runs the CLI as a program. After a change to the kind schemas, run `node packages/facts/scripts/kind-schemas.mjs` to write `src/kind-schemas.ts` again; a test fails while it is out of date.

MIT. It depends on `@tjalve/memex-sqlite` and `@tjalve/memex-schema` as `workspace:*`, so it installs only inside this workspace until those are published.
