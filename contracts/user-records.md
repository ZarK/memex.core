# Memex.User records

**Version:** 2 (25 October 2026). The JSON Schemas are in [schemas/user/](../schemas/user/) and [schemas/facts/](../schemas/facts/facts.json). The OpenAPI file is [openapi/user.v1.yaml](../openapi/user.v1.yaml).

Memex.User keeps facts about the owner: one person record (the owner), homes, workplaces, places, stays, trips, chapters, and milestones. Every app that holds evidence about the owner writes it as claims. User joins the claims of all apps into one record per fact, and every app can read the records. The owner corrects them, and a correction stays when an app infers again.

User keeps facts, not raw data. Raw transactions stay in Finance. Photos, positions, and workouts stay in Photos and Health. Facts about a single photo stay in Photos. Facts about other people are in Memex.Contacts ([contacts-records.md](contacts-records.md)); other people appear on User records only as Contacts references.

User runs the shared facts engine `@tjalve/memex-facts`. The rules that User shares with Memex.Contacts are in [facts.md](facts.md): claims and their fields, joins, combining, provenance, review, corrections and their results, the outbox, and the change feed. This contract gives what is particular to User.

## Changes in version 2

- User is about the owner only; version 1 spoke of a wider group that it did not define. `person.role` is only `owner`, and User keeps one person record. Workplace `stints` are the owner's, without a `person`.
- `members`, `participants`, `persons`, and the list input `person` take the owner's id or a Contacts reference. User follows Contacts redirects when it reads a reference.
- Records have `provenance`, `alternatives`, and `reviewReasons`. Claims have `method`, `generation`, and `seen`. Corrections can edit a list with `{ add, remove }` and get `anchors`.
- Finance and Health send claims in v1. Contacts sends the owner's own card as claims in the scopes `contacts.persons`, `contacts.homes`, and `contacts.workplaces`.
- The shared rules moved to [facts.md](facts.md).

## Choices in this contract

- **Service.** User follows [surfaces.md](surfaces.md) like every app: loopback HTTP on `127.0.0.1`, port 0, a new token at each launch, and the app record `<apps>/user.json`. User runs on its own pinned Node.js runtime. See [Service](#service).
- **What User keeps.** Homes, workplaces, named places, stays, and trips are in User in v1. Workplaces are a kind of their own. What the person enters (homes, workplaces, and named places) becomes the person's own record in User, never a Photos claim, so a new Photos library cannot remove it. See [Records that the person enters](#records-that-the-person-enters). An edit that the person makes is always accepted: the app saves it in its own database at once and sends it to User in the background. See [facts.md](facts.md#the-outbox).
- **One picture of the owner.** User fuses what every app knows about the owner: a trip that Photos sees from GPS, Finance from card payments abroad, and Health from a run in another city becomes one trip.
- **One person record.** User keeps one person record, the owner. Facts about other people go to Memex.Contacts, with the same engine.

## Service

- User runs only on the owner's machine. Its database is `~/Memex/User/user.db`, in the `data` folder of [storage.md](storage.md).
- User runs on its own pinned Node.js runtime, which every app installer carries. Memex picks the version and checks its hash. User does not run in the Electron of an app, does not install Node.js for the whole computer, does not change `PATH`, and does not use a Node.js that the person installed. So an app update or an uninstall never breaks User.
- Apps start it with `ensureUser`. It stops when it is idle.
- An installed copy is the folder `<services>/user/<version>/` of [surfaces.md](surfaces.md#installed-copies): the pinned runtime under the name `memex-user` (`memex-user.exe` on Windows), the built User in `app/`, and `service.json` with `"command": "memex-user.exe"` (or `memex-user`) and `"args": ["app/dist/bin.js", "serve"]`. The launcher starts it with the version folder as its working folder.
- When a newer copy is installed, `ensureUser` sends `POST /v1/drain` to the copy that runs. That copy answers 202 with `{ "draining": true, "pid", "version", "held" }`, gives up its single-instance lock, and never writes the app record again. `GET /health` answers `"status": "draining"`; every other request gets 503 `draining` before any work starts, and the client sends it again to the newer copy. The draining copy finishes the calls that it holds and stops when it holds none, or after its drain time (60 seconds).
- It has the three surfaces of [surfaces.md](surfaces.md). The HTTP API listens on `127.0.0.1`, port 0, with a new token at each launch. The app record `<apps>/user.json` gives `running.url` and `running.tokenFile`. User has no pipe or socket.
- Its MCP server has every read capability and `user.corrections.write`. Claims come only from apps, over HTTP.

## Records

A record is one fact, with the fields of [facts.md](facts.md#records).

```json
{
  "id": "trip_be3b7aabcbc567ddfdcace1a9d735bf4",
  "kind": "trip",
  "version": 4,
  "state": "active",
  "origin": "inferred",
  "confidence": 0.92,
  "review": false,
  "fields": {
    "title": "Lisbon with Sam",
    "firstDay": "2025-05-02",
    "lastDay": "2025-05-08",
    "countries": ["PT"],
    "participants": [
      "person_4c1029697ee358715d3a14a2add817c4",
      { "app": "contacts", "kind": "person", "id": "ct_sam" }
    ]
  },
  "provenance": {
    "title": [{ "correction": "cor_d0f631ca1ddba8db3bcfcb9e057cdc98" }],
    "firstDay": [{ "scope": "photos.trips", "key": "trip-1842" }],
    "participants/1": [{ "scope": "photos.trips", "key": "trip-1842" }]
  },
  "alternatives": {
    "title": [{ "value": "Lisbon", "from": [{ "scope": "photos.trips", "key": "trip-1842" }], "reason": "weaker" }]
  },
  "corrected": ["title"],
  "claims": [{ "scope": "photos.trips", "key": "trip-1842", "confidence": 0.92 }],
  "sources": [{ "app": "photos", "kind": "trip", "id": "trip-1842" }],
  "createdAt": "2026-11-18T09:00:00Z",
  "updatedAt": "2026-11-20T17:42:10Z"
}
```

The full record is in [fixtures/user/trip.record.json](fixtures/user/trip.record.json). `kind` is `person`, `home`, `workplace`, `place`, `stay`, `trip`, `chapter`, or `milestone`.

## Kinds

| Kind | Fields (required in bold) | Producers in v1 |
|---|---|---|
| `person` | **`name`**, **`role`** (only `owner`), `contact` (a reference to the owner's Contacts person) | Contacts (`contacts.persons`). User keeps one person record, the owner. |
| `home` | **`type`** (`home` or `cabin`), `label`, `location`, `address`, `town`, `country`, `from`, `to`, `members` (each: `person`, `from`, `to`, `child`: the people who lived there with the owner) | The person, in Photos (`create`). Finance claims town-level homes (`finance.homes`). Contacts claims the addresses of the owner's own card (`contacts.homes`, `seen` only). |
| `workplace` | **`name`**, **`type`** (`employer`, `client`, `own`, or `school`), `sites` (each: **`location`**, `label`, `type` `office`, `cabin`, or `other`), `stints` (each: `from`, `to`: the owner's periods there) | The person, in Photos (`create`). Contacts claims the organizations of the owner's own card (`contacts.workplaces`, `seen` only). |
| `place` | **`name`**, **`type`** (`bar`, `restaurant`, `cafe`, `shop`, `sport`, `culture`, `hotel`, `area`, `spot`, or `other`), **`location`**, `address`, `town`, `country` | The person, in Photos: named places (`create`). Health claims places from workouts. |
| `stay` | **`arrival`**, **`departure`**, **`location`**, `name`, `place` (the id of a home, workplace, or place), `timeZone` | Photos claims, from location history (`photos.stays`). Health claims, from workouts (`health.stays`). |
| `trip` | **`title`**, **`firstDay`**, **`lastDay`**, `destinations` (each: **`name`**, `town`, `country`, `location`), `countries`, `participants`, `home` | Photos claims, from photo positions (`photos.trips`). Finance claims, from payments abroad (`finance.trips`). Health claims trip evidence (`health.trips`). |
| `chapter` | **`title`**, **`type`** (`trip`, `move`, `project`, `payoff`, `period`, or `other`), **`from`**, `to`, `trip` | any app; Finance in v1 |
| `milestone` | **`title`**, **`date`**, `persons` | Finance, Health |

Value rules:

- `location` is `{ "lat", "lon", "radiusM" }`. `radiusM` is optional.
- `country` and `countries` use ISO 3166-1 alpha-2 codes, for example `NO`.
- `from`, `to`, and `date` are partial dates: `YYYY`, `YYYY-MM`, or `YYYY-MM-DD`. A missing `to` means "still true" only when the record has a `from` ([facts.md](facts.md#claims)).
- `firstDay` and `lastDay` are local dates. `arrival` and `departure` are UTC times. `timeZone` is an IANA name.
- A person in `members`, `participants`, or `persons` is the owner's person id, or a Contacts reference `{ "app": "contacts", "kind": "person", "id" }`. User stores the reference as given. When User reads it, it follows the Contacts redirect of a merged person (`mergedInto`), and a reference to the owner's own Contacts person (the `contact` of the owner) reads as the owner's id. User never rewrites a stored reference, so a Contacts unmerge works.
- A later version can add fields, for example a cost summary for trips from Finance in 1.1. Clients ignore fields that they do not know; the schemas of this version forbid them.
- Workplaces are a kind of their own. The Photos home types `work` and `school` become workplaces.

## Claims

Claims follow [facts.md](facts.md#claims): `key`, `kind`, `confidence`, `method`, `generation`, `seen`, `fields`, and `sources`. In User, the subject of every claim is the owner, so a claim has no `subject`.

```json
{
  "scope": "finance.homes",
  "claims": [
    {
      "key": "town:bergen:2019-07",
      "kind": "home",
      "confidence": 0.7,
      "method": "rule:home-town-from-payments/1",
      "generation": 3,
      "seen": { "first": "2019-07-02T00:00:00Z", "last": "2023-06-28T00:00:00Z" },
      "fields": { "type": "home", "town": "Bergen", "country": "NO", "from": "2019-07", "to": "2023-06" },
      "sources": [{ "app": "finance", "kind": "town-period", "id": "bergen-2019-07" }]
    }
  ]
}
```

Scopes in v1:

| Scope | Producer |
|---|---|
| `photos.trips`, `photos.stays` | Photos |
| `finance.homes`, `finance.trips`, `finance.chapters`, `finance.milestones` | Finance |
| `health.stays`, `health.places`, `health.trips`, `health.milestones` | Health |
| `contacts.persons`, `contacts.homes`, `contacts.workplaces` | Contacts: the owner's own card, with `seen` and no `from` or `to` |

- `user.claims.write` replaces the claims of the scope or partition ([facts.md](facts.md#claims)). It refuses a lower `generation` with 409 (`stale-generation`).
- The claim fields must have the required fields of the kind.
- The response gives `changeId`, `summary`, the counts (`created`, `updated`, `unchanged`, `withdrawn`, `removed`), and the record id of each key.
- Joins and combining follow [facts.md](facts.md#joins). Photos never sends homes, workplaces, or named places as claims; they are records that the person made (see below). A Finance home in Bergen to 2019-06 confirms the home "Eksempelveien 4, Bergen, from 2015-08" that the person entered in Photos, adds its source, and puts "may end 2019-06" on the review list as an alternative of `to`.

## Corrections

Corrections follow [facts.md](facts.md#corrections): the six operations, `id` and `createdAt` from the app, repeats by `id`, the order by `createdAt`, list edits, anchors, results, and held reasons. In User:

- `user.corrections.write` stores at most 500 corrections in one call.
- A repeated `create` makes no new record. A `create` is a repeat when it has `sources`, and an earlier `create` has the same `kind`, the same `sources`, and the same `fields`. So an app can send its entries again, for example from a new library, without making duplicates. A `create` without `sources` is a repeat only by its `id`.
- The fields are part of the match because the ids in `sources` are local to the app's data. A new Photos library can give a new workplace the id that a workplace of an earlier library had, for example `workplace_31`. With other fields, that `create` makes a new record.
- For a repeated `create` with a new `id`, User stores no new correction and makes no new record. It stores the new `id` as an alias of the earlier correction, so a later send of that `id` is a repeat by `id` and gets the same result. `corrections[i]` is the earlier correction, with its own `id`. `results[i]` has the new `id`, `repeat: true`, `repeatOf`, and `record` set to the record that holds the fact now. When that record is rejected, the result is `held` with the reason `record-rejected` and still has `record`. The app can then offer `restore`.
- A `clear` must not leave a required field of the kind without a value, because no claim of the record gives one. A record that the person made has no claims of its own, so its required fields cannot be cleared: the `type` of a home, the `name` and `type` of a workplace, and the `name`, `type`, and `location` of a place. Apps do not let the person empty these fields. When such a `clear` arrives all the same, User stores it and does not apply it (`held`, `required-field`).
- Example: Photos links "me" with `set` on the owner person: `{ "op": "set", "record": "person_…", "fields": { "contact": { "app": "contacts", "kind": "person", "id": "…" } } }`.
- Example of a list edit: `{ "op": "set", "record": "trip_…", "fields": { "participants": { "add": [{ "app": "contacts", "kind": "person", "id": "ct_kim" }], "remove": [{ "app": "contacts", "kind": "person", "id": "ct_sam" }] } } }`.
- Corrections are the only data in User that the person made. They are in `user.db`, in `~/Memex`. `user.corrections.list` returns all of them, and `memex-user corrections export` writes them as JSON Lines. Apps can write their claims again at any time.

### Results

`user.corrections.write` returns the corrections as stored, and `results`: one result for each correction of the request, in the same order ([facts.md](facts.md#results)). A result tells the app how to update its local copy.

| Field | Meaning |
|---|---|
| `id` | The `id` of the i-th correction of the request, also for a repeat. |
| `status` | `applied`, `superseded`, or `held` (see below). |
| `repeat` | `true` when User had stored this `id`, or this `create`, before. User returns the earlier correction and stores nothing new, except the new `id` of a repeated `create` as an alias. |
| `repeatOf` | Only for a `create` that repeats an earlier `create` with another `id`: the `id` of the earlier correction. |
| `record` | The record that holds the fact now: the new record of a `create`, the record that a merged record went into, or the first id of a `merge`. A `held` result has it whenever User knows the record. |
| `version` | The `version` of that record after the write. |
| `state` | The `state` of that record after the write. |
| `overridden` | The fields of a `set` or `clear` for which a correction with a later `createdAt` wins. |
| `reason` | Only for `held`: `required-field`, `record-rejected`, `record-removed`, or `unknown-record`. `message` gives a sentence for the app. |

What User returns in each case:

| Case | `status` | What the app does |
|---|---|---|
| A new correction that applies | `applied` | Takes `record` (for a `create`, the new id), `version`, and `state` into its local copy. |
| The same `id` again | the result now, with `repeat: true` | The same as for the first send. |
| A `create` that repeats an earlier one with another `id` | `applied`, `repeat: true`, `repeatOf`, `record` the earlier record | Links its local entry to `record`, and reads that record once (see [Reading back](#reading-back)). |
| A `set` or `clear` with some fields that a later correction wins | `applied`, with `overridden` | Takes the other fields, `version`, and `state`, and reads the record once for the winning values (see [Reading back](#reading-back)). |
| A `set`, `clear`, `reject`, or `restore` that a later correction wins completely | `superseded` | Reads the record once (see [Reading back](#reading-back)). The correction stays in the history. |
| A correction for a merged record | `applied`, `record` the merge target | Moves its local entry to `record`, and reads that record once (see [Reading back](#reading-back)). |
| A correction for a rejected record | `applied`, `state: rejected` | Keeps the record hidden until a `restore`. |
| A `create` that repeats a `create` whose record is rejected | `held`, reason `record-rejected`, `repeat: true`, `repeatOf`, `record` the rejected record | Links its local entry to `record`, keeps it, and marks it, so the person can restore the record or keep it removed. |
| A `clear` that would leave a required field empty | `held`, reason `required-field` | Keeps the local value and marks the field. |
| A correction for a record that lost all its claims | `held`, reason `record-removed` | Keeps its local value and marks the entry. User applies the correction again when the record comes back with the same id. |
| A correction for a record id that User does not know | `held`, reason `unknown-record` | Keeps its local value and marks the entry. |

Every correction that has a result is stored in User: as a correction of its own, or, for a repeated `create` with a new `id`, as an alias of the earlier correction. So a held correction leaves the outbox, and the app does not send it again. What clears its mark is in [Held corrections](#held-corrections). User refuses a whole call only when the request itself is wrong, for example a correction that does not match its schema (400), and then stores nothing. `user.corrections.write` has no 404, 409, or 422.

## Records that the person enters

Homes, workplaces, and named places are facts that only the person can give. Photos cannot find them again from files. So they are records that the person made, not claims.

- When the person adds a home, a workplace, or a named place, the app sends a `create` correction with `sources` that name its own record, for example `{ "app": "photos", "kind": "home", "id": "…" }`. User makes a record with `origin: user`.
- An edit is a `set` correction. A field that the person empties is a `clear` of that field. Apps do not let the person empty a required field (see [Corrections](#corrections)).
- The app saves each of these corrections in its own database first, and sends it to User in the background ([facts.md](facts.md#the-outbox)).
- A removal is a `reject` correction. The record gets `state: rejected` and stays hidden. `restore` brings it back.
- Photos never sends homes, workplaces, or named places as claims. A record that the person made stays when no app claims it, so a new or rebuilt Photos library cannot remove it. A new library reads these records from `user.changes.list`.
- On its first run against User, Photos sends the homes, workplaces, and named places that are already in its library, as `create` corrections with their Photos ids in `sources`. A repeat makes no duplicates, and a home of another library with the same Photos id but other fields is a new record (see [Corrections](#corrections)).
- Undo in an app makes the reverse correction: `reject` for a `create`, a `set` with the earlier values for a `set` (or a `clear` for a field that had no value), and `restore` for a `reject`. It goes through the outbox like any other edit.
- A home member or a trip participant is the owner or a Contacts person. A stint is the owner's. What the person enters about another person, for example a friend's home, goes to Memex.Contacts through the outbox; Photos keeps its local copy for its screens.
- Photos keeps a local copy of these records, so that its screens stay fast and work while User is stopped. An edit of the person lands in the local copy first, and the app sends it to User from there. User is the shared source for all apps: the app updates its local copy from `user.changes.list`, but never over an edit that User has not stored yet.
## Edits are saved locally and sync in the background

An edit that the person makes is always accepted. The app saves it with the correction in a durable outbox, with the target hub `user`, and a background sync sends the outbox to User. [facts.md](facts.md#the-outbox) gives the rules for saving and sending. Reading back and held marks follow here; Memex.Contacts uses them the same way.

### Reading back

- A background reader applies `user.changes.list` to the local copy, from the cursor that the app stored (see [Changes](#changes)).
- A field is protected when it has a correction in the outbox, or a correction with a mark (see [Held corrections](#held-corrections)). A protected field keeps its local value. So the screen never jumps back to an older value.
- The reader applies a change when its `version` is equal to or higher than the `version` in the local copy, to every field that is not protected. Equal counts, because a write result can give the local copy the `version` of a change before the reader gets to it.
- When a correction leaves the outbox with `overridden`, `superseded`, `repeatOf`, or a `record` other than the one in the correction, the app reads that record once with `user.<kinds>.get` and applies it by the same rule. So the winning values arrive also when the reader went past that change while the field was still protected.
- Reads do not wait for User. An app shows its local copy while User is stopped.

### Held corrections

A correction with a mark is stored in User (`held`), or refused and still in the outbox (400). The field or the entry keeps the local value, and the app may show it as needing attention. Never as not saved.

- A later correction from the person for the same field, or for the same record, clears the mark when User stores that correction: a `set` or `clear` of the field, or a `reject`, `restore`, or `merge` of the record. From then on, the field follows the later correction.
- `record-rejected`: a `restore` or a `reject` of that record clears the mark.
- `record-removed`: the mark clears when User applies the correction, that is when the change feed gives the record again with the same id.
- `unknown-record`, and a refused correction: a later correction for the same field or record clears the mark, as above, or the person removes the local entry, which sends nothing for a record that User does not know.
- A refused correction stays in the outbox also after its mark is cleared, and the sync tries it again after an app update.

## Changes

`user.changes.list` is the feed that apps use to keep a mirror, for example the Photos tables. It follows [facts.md](facts.md#the-change-feed): input `since`, `kinds`, and `limit`; changes with `cursor`, `op`, `id`, `kind`, `version`, `at`, `record`, and `mergedInto` for a removed record that was merged; rejected records as an `upsert` with `state: rejected`; output `{ "items", "next" }`.

## Capabilities

| Id | Kind | Does |
|---|---|---|
| `user.claims.write` | write | Replaces the claims of a scope or partition. HTTP only. |
| `user.claims.list` | read | Lists the claims of a scope, with the record of each. |
| `user.corrections.write` | write | Stores corrections (at most 500 in one call). |
| `user.corrections.list` | read | Lists corrections, for one record or all. |
| `user.changes.list` | read | The change feed. |
| `user.<kinds>.list` | read | For each kind: `user.persons.list`, `user.homes.list`, `user.workplaces.list`, `user.places.list`, `user.stays.list`, `user.trips.list`, `user.chapters.list`, `user.milestones.list`. |
| `user.<kinds>.get` | read | For each kind: one record by `id`, for example `user.trips.get`. |

List inputs: `from` and `to` (dates; a record matches when its dates overlap), `person` (the owner's id or a Contacts reference; User follows Contacts redirects), `review`, `includeRejected` (default `false`), `limit` (default 100, at most 1 000), and `cursor`. Lists are sorted by their start date, newest first. Kinds without a date are sorted by name.

Writes take `dryRun` and `idempotencyKey` ([surfaces.md](surfaces.md#data-rules)).

## Fixtures

[fixtures/user/](fixtures/user/) holds claims writes for `photos.trips`, `photos.stays`, `finance.homes`, `health.stays`, and `contacts.homes` (the owner's own card) and a result, trip records, a page of `user.trips.list`, corrections (with a home that the person entered in Photos), a correction sent again with the same `id`, a `create` sent again with a new `id`, two edits of one field that arrive in the reverse order, a list edit of trip participants, a home that the person made and that Finance and Contacts claims confirm (with provenance, alternatives, and a suggested end), a workplace that the person made, the owner's person record, and a page of changes. `index.json` names the schema of each file. Journey and Photos build against them before User ships. `packages/schema/test/contracts.test.ts` checks each fixture against its schema and writes it back byte for byte; the TypeScript client (`@tjalve/memex-user-client`) and the C# client (`Memex.User.Client` in memex.node) do the same.
