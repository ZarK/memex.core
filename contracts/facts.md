# Facts: claims, records, and corrections

**Version:** 1 (25 October 2026). The shared JSON Schemas are in [schemas/facts/](../schemas/facts/facts.json).

This contract holds the rules of `@tjalve/memex-facts`, the one fusion engine in memex.core. Two hubs run it:

- **Memex.User** for facts about the owner: [user-records.md](user-records.md).
- **Memex.Contacts** for facts about other people: [contacts-records.md](contacts-records.md).

Each hub contract gives its kinds, its scopes, its operations, and its own additions. Everything that both hubs do is here, once. The engine builds on `@tjalve/memex-schema` ([derived-facts.md](derived-facts.md)): fact ids, corrections, and the JSON Lines export.

## One fact, one hub

- A fact about the owner goes to Memex.User. A fact about another person, or about the edge between two persons, goes to Memex.Contacts.
- Events stay in the app that recorded them: messages and calls in Conversations, photos and faces in Photos, transactions in Finance, workouts in Health. That app answers questions about a person by the Contacts reference. A hub stores facts, not events.
- Your stint at a workplace is in User. A colleague's stint at the same workplace is in Contacts. A reader matches the names.

## Claims

A claim is a fact as one app infers it. An app writes all its claims of one kind in one scope, `<app>.<kinds>`, for example `photos.trips` or `contacts.homes`.

| Field | Meaning |
|---|---|
| `key` | The app's own stable id for the claim, 1 to 200 characters. It stays the same while the app infers the same fact. |
| `kind` | A kind of the hub. |
| `confidence` | 0 to 1. |
| `method` | The rule or model and its version, for example `rule:trip-nearness/2` or `card:vcard/1`. |
| `generation` | An integer that goes up with each run of the producer. |
| `seen` | Optional: `{ first, last }`, the UTC times at which the evidence was first and last observed. |
| `fields` | The fact, in the shape of its kind. |
| `sources` | At most 100 references to the app's own records, `{ app, kind, id }`. Point to a group (a trip), not to every photo. |
| `subject` | Memex.Contacts only: the identity that the producer knows. See [contacts-records.md](contacts-records.md#subjects). |

Rules:

- A claims write **replaces** the claims of the scope. A claim of the scope that is not in the request is withdrawn. The app sends everything it infers now, and the hub finds the changes.
- A scope with many claims uses `partition` (for example a year). The replace then covers only that partition. A scope uses partitions always or never.
- One request has at most 5 000 claims. Every claim of a request has the same `generation`. The hub refuses a request with a lower `generation` than the last one that it stored for the scope or partition (409, code `stale-generation`), so a late retry never replaces newer claims. An equal generation is a repeat of the same run and is accepted. A request can also carry `generation` at the top level; it must equal the generation of its claims. An empty `claims` list (a run that found nothing) must carry it when the hub has a generation for the scope or partition, so that a late retry of an empty run is refused too (400 without it).
- **Time.** `from` and `to` in `fields` say when the fact was true. `seen` says when the evidence was observed. An address book proves that an address was listed, not that someone lived there: card revisions from 2023 to 2026 give `seen` and no `from`, and readers show "listed 2023–2026". A missing `to` means "still true" only when the record has a `from`. `to` needs evidence of an end, for example a move. A newer value never ends a span: one card can list several organizations at once.
- Claims are not queued. When a hub cannot be reached, the producer sends its current claims at its next run.

## Records

A record is one fact. The hub makes it from the claims of one or more apps and from the corrections of the person.

| Field | Meaning |
|---|---|
| `id` | `<kind>_<32 lowercase hex>`. It never changes. A record keeps the fact id of its first claim ([derived-facts.md](derived-facts.md#fact-ids)), so corrections on it stay valid after a rebuild. |
| `kind` | A kind of the hub. |
| `version` | Goes up by one at each change of the record. |
| `state` | `active`, or `rejected` when the person said that the fact is wrong. |
| `origin` | `inferred` (from claims) or `user` (the person made it with `create`). |
| `confidence` | The highest confidence of its claims; 1 for a record that the person made. |
| `review` | `true` when the record is on the quiet review list (see [Review](#review)). Apps never ask the person to confirm. |
| `reviewReasons` | Only when `review` is `true`: why. |
| `fields` | The fact, in the shape of its kind. |
| `provenance` | For each field, and each list element, what gave it (see [Provenance](#provenance)). |
| `alternatives` | For each field, the values that lost (see [Combining](#combining)). |
| `corrected` | The names of the fields that the person set. |
| `claims` | The claims that the record comes from: `scope`, `partition`, `key`, `confidence`, and `seen`. |
| `sources` | At most 100 references to records in the apps. |

## Joins

A claim with a new key gets a new record, or joins a record by the join rule of its kind. Joining claims is automatic. When a key comes back after a withdrawal, it gets its earlier record id, so the corrections on that id apply again.

| Kind | Claims join when |
|---|---|
| `home` | The same subject; the same normalized address, or locations within 150 m (or the given radius); and spans that overlap or are less than 90 days apart. |
| `workplace` | The same subject; the same normalized name, or a site within the radius. |
| `place`, `stay` | Memex.User only: locations inside the radius (150 m when not given) and dates or times that overlap. |
| `trip` | Memex.User only: overlapping days, and one more independent kind of evidence: a shared destination town or country, or a shared participant (the nearness rule of Photos `TidyQueries`). |
| `person` | Memex.User: the same `contact`. Memex.Contacts: never; two persons become one only by a merge. |
| `circle`, `date`, `relation`, `identity` | Memex.Contacts only: the same subject (or the same pair of subjects for a relation) and the same circle name, date type, relation type, or handle. |
| `chapter`, `milestone` | Never. |

- In Memex.User, the subject of every claim is the owner.
- A location pin and a text address join only when the street and the number of the pin are known. Memex has no forward geocoding in v1. Otherwise the review list shows the records as `possible-duplicate`, and one `merge` joins them.
- A claim that gives only a town joins a precise record only when the subject has exactly one such record in that town during the overlap.
- An inferred record of one app joins a record that the person made by the same rules. The person's fields win.
- A record that loses all its claims is removed. A record that the person made stays.
- Joining two persons is never automatic. It is a `merge` correction, and only the person makes it.

## Combining

Each field of a record comes from the joined claims and the corrections:

- **Spans** (`from` and `to`, `firstDay` and `lastDay`, `arrival` and `departure`): the union of the claims at confidence 0.5 or higher and at the precision of the record. A claim at a coarser precision (a town for a home with an address, a month for a record with days) confirms the record and adds its source, but its bounds go to `alternatives` with the reason `coarser`. A gap of more than 90 days between the joined claims puts the record on the review list (`gap`).
- An open-ended home that overlaps a later home in another town goes to the review list with the suggested end as an alternative of `to` (reason `suggested-end`). The engine never sets a move date.
- **Lists** (`members`, `participants`, `destinations`, `countries`, `residents`, `stints`, `otherNames`): the union of the claims. Each element keeps its own sources in `provenance`. A correction can edit a list with `{ add, remove }` (see [Corrections](#corrections)).
- **Single values:** the person's correction, else the value of the strongest claim. A tie prefers a value from the address book over an inferred value, then the newer `seen.last`. The values that lose stay in `alternatives` with the reason `weaker`.
- **Partial dates refine:** `1984` and `1984-03-12` give `1984-03-12`, with both sources. Partial dates that do not refine each other (`1984-03` and `1985`) keep the stronger one, put the other in `alternatives` with the reason `conflict`, and put the record on the review list.

## Provenance

`provenance` maps each field to what gave it: which app gave which field.

- A key is a field name, or `<field>/<index>` for one element of a list field, for example `participants/1`.
- A value is a list of origins: a claim `{ scope, partition, key }`, or a correction `{ correction }`. A value that several claims give lists all of them.
- A field that a correction set lists that correction first.

```json
"provenance": {
  "title": [{ "correction": "cor_d0f631ca1ddba8db3bcfcb9e057cdc98" }],
  "firstDay": [{ "scope": "photos.trips", "key": "trip-1842" }],
  "participants/1": [{ "scope": "photos.trips", "key": "trip-1842" }]
},
"alternatives": {
  "title": [{ "value": "Lisbon", "from": [{ "scope": "photos.trips", "key": "trip-1842" }], "reason": "weaker" }]
}
```

## Review

`review` is `true` when one of these is true and the person has not decided it with a correction:

| `reviewReasons` | When |
|---|---|
| `low-confidence` | The confidence is below 0.5. |
| `conflict` | Two claims give partial dates that do not refine each other. |
| `suggested-end` | An open-ended home overlaps a later home in another town. |
| `gap` | The joined claims of a span have a gap of more than 90 days. |
| `possible-duplicate` | The record is possibly the same as another record of the subject, for example a pin and a text address. |

Apps show these records in a quiet list. They never ask the person to confirm.

## Corrections

A correction is a decision of the person. The hub stores it as a record of its own, and inference never changes it.

| `op` | Fields | Does |
|---|---|---|
| `set` | `record`, `fields` | Sets fields. They stay when apps infer again. |
| `clear` | `record`, `names` | Removes the person's value of these fields. The inferred value applies again. |
| `reject` | `record` | The fact is wrong. The record gets `state: rejected` and stays hidden, also when its claims come back. |
| `restore` | `record` | Undoes a reject. |
| `merge` | `records` (two or more) | Joins records of one kind. The first id stays. Later claims for the other records go to it. |
| `create` | `kind`, `fields`, optional `sources` | Makes a record that the person owns, with `origin: user`. |

Memex.Contacts adds `unmerge`, `pin`, and `unpin` ([contacts-records.md](contacts-records.md#corrections-merges-and-pins)).

- **Id and time.** Every correction has `id` and `createdAt`, and the app makes both when the person acts. `id` is `cor_` and 32 lowercase hex digits, for example a UUID v7 without its dashes. `createdAt` is the UTC time at which the person made the edit, not the time of the send. Every correction also has `app`: the app in which the person acted.
- **Repeats.** The hub stores each `id` once. A correction with an `id` that the hub has stored is a repeat: the hub stores nothing new and returns the stored correction, with its result now and `repeat: true`. This is true also when the earlier call failed before the app got the response. A `create` with `sources` is also a repeat when an earlier `create` has the same `kind`, `sources`, and `fields`; the hub stores the new `id` as an alias of the earlier correction and returns `repeatOf`.
- **Order.** The hub orders corrections by `createdAt`, then by the order in which they arrived. The order of the sends does not matter: for the same field of the same record, the correction with the later `createdAt` wins, also when it arrived first. `reject` and `restore` of one record follow the same rule. Each correction stays in the history.
- **List edits.** In a `set`, the value of a list field can be `{ "add": [...], "remove": [...] }` instead of a whole list. The hub applies the edits in order over the union of the claims. Claims can still add new elements; a removed element does not come back when a claim gives it again. A later `set` with a whole list replaces the edits, and a `clear` gives the list back to the claims. Elements compare by their JSON value.
- **Anchors.** The hub stores with each correction the claim keys of its record at that time (`anchors`). When the record id is unknown, for example after a rebuild, the correction attaches to the record that holds one of those keys. An app does not send `anchors`.
- A `set` or `clear` for a record that was merged applies to the record that it was merged into. A correction for a rejected record is stored and applied, and the record stays rejected until a `restore`.
- To split a record, reject it and create the parts.

### Results

A corrections write returns the corrections as stored and one result for each correction of the request, in the same order. `results[i].id` is always the `id` of the i-th correction of the request, also for a repeat, so the app finds its outbox item by it.

| Field | Meaning |
|---|---|
| `status` | `applied`, `superseded` (corrections with a later `createdAt` win completely), or `held` (stored and not applied). |
| `repeat`, `repeatOf` | See [Corrections](#corrections). |
| `record`, `version`, `state` | The record that holds the fact now, after the write. |
| `overridden` | The fields of a `set` or `clear` for which a correction with a later `createdAt` wins. |
| `reason` | Only for `held`: `{ code, message }`. |

**Held reasons.** A held correction is stored. It leaves the outbox, and the app keeps the person's value and marks the entry.

| `code` | When | What clears the mark |
|---|---|---|
| `required-field` | A `clear` would leave a required field of the kind without a value. | A later correction for the same field or record. |
| `record-rejected` | A `create` repeats a `create` whose record the person rejected. | A `restore` or a `reject` of that record. |
| `record-removed` | The record lost all its claims. | The change feed gives the record again with the same id; the hub applies the correction then. |
| `unknown-record` | The hub does not know the record id, and no anchor finds it. | A later correction for the same field or record, or the person removes the local entry. |
| `not-merged` | Memex.Contacts: an `unmerge` of a person that is not merged. | A later correction for the same person. |

A hub refuses a whole call only when the request itself is wrong, for example a correction that does not match its schema (400). It then stores nothing. A corrections write has no 404, 409, or 422, and a hub never drops a correction.

## The outbox

What a person enters is always accepted. An app never refuses or loses an edit because a hub is stopped, starting, or failing.

- The app writes the edit to its own database at once. In the same transaction, it writes the correction to a durable outbox in that database, with its **target hub**: `user` or `contacts`. Then the screen shows the edit as saved. An app may show that an edit waits to sync, never that it was not saved.
- A background sync sends the outbox of each hub in `createdAt` order, at most 500 corrections in one call, whenever the hub can be reached. It starts the hub on demand: `ensureUser` or `ensureApp`.
- After a failure, the sync tries again with a backoff, for example from 1 second up to 5 minutes. It goes on after a restart, because the outbox is in the app's database.
- A correction leaves the outbox only when the hub has stored it: the response has a result with its `id`. A timeout or a lost response leaves it in the outbox, and the next send is safe because the hub stores each `id` once.
- A correction can refer to a record that a `create` in the outbox will make. It keeps the app's local id until the hub returns the record id of that `create`; a send ends before the first correction that still has a local id.
- When a hub refuses a whole call (400), the sync sends the corrections of that call one at a time. A correction that is still refused stays in the outbox with the error as its mark, with the corrections that refer to its local id, and the sync goes on with the next ones. It tries a marked correction again after an app update. One bad correction never stops the others.
- Undo is a correction like any other: `reject` for a `create`, a `set` with the earlier values for a `set`, `restore` for a `reject`. The app does not remove an unsent correction from the outbox to undo it.
- The shared clients carry the outbox and the sync in TypeScript and C#, so apps do not each build them: `FactsSync` of `@tjalve/memex-user-client` and of `Memex.User.Client` (memex.node). Both keep their tables (prefix `memex_facts_`, migration scope `memex-user-client`) in the app's database. The TypeScript client records its migrations in the `schema_migrations` table of `@tjalve/memex-sqlite`, as every TypeScript app does; the C# client records them in its own `memex_facts_migrations` table, so it never touches a migration table of a .NET app.

[user-records.md](user-records.md#edits-are-saved-locally-and-sync-in-the-background) gives the details of reading back and of held marks for Memex.User. They are the same for Memex.Contacts.

## The change feed

`<hub>.changes.list` is the feed that apps use to keep a local copy.

- Input: `since` (a cursor, or none for every record), `kinds`, `limit` (default 500, at most 5 000). Memex.Contacts also takes `person`.
- Each change has `cursor`, `op` (`upsert` or `remove`), `id`, `kind`, `version`, `at`, and `record` (the full record for `upsert`). Memex.Contacts adds `person`, the person that the record is about.
- A change is in the feed only after its transaction commits.
- A removed record that was merged has `mergedInto`. A merged Contacts person is an `upsert` whose record has `mergedInto`, because the person stays as a redirect.
- A rejected record comes as an `upsert` with `state: rejected`, so that a local copy can hide it.
- The output is `{ items, next }`. `next` is `null` when there are no more changes now. The app stores the `cursor` of the last change that it applied.
- The reader applies a change when its `version` is equal to or higher than the local `version`, to every field that has no correction in the outbox and no mark. So the screen never jumps back to an older value.

## Fixtures

Each hub has its fixtures: [fixtures/user/](fixtures/user/) and [fixtures/contacts/](fixtures/contacts/). An `index.json` names the schema of each file. `packages/schema/test/contracts.test.ts` checks every fixture against its schema and reads and writes each one back byte for byte, in the layout of `packages/schema/test/fixture-json.ts`. The TypeScript and C# clients do the same.
