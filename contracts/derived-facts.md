# Derived facts and corrections

**Version:** schema 0.4 (`@tjalve/memex-schema` 0.4.0, migration `0002_derived_facts.sql` in the scope `core`; 0.4 changes no tables). The consumer is `@tjalve/memex-facts`, the engine of Memex.User and Memex.Contacts ([facts.md](facts.md)).

Memex apps infer facts automatically and do not ask the user to confirm them. Every derived fact keeps a confidence, the rule or model that made it, and its sources. A user correction is a record of its own: inference never changes or removes it, and it applies again when the app infers the same fact again.

The DDL in [packages/schema/migrations/0002_derived_facts.sql](../packages/schema/migrations/0002_derived_facts.sql) is canonical. Fixtures for TypeScript and C# are in [fixtures/schema/](fixtures/schema/).

## Provenance v2

Three new columns on `provenance`, all optional:

| Column | Meaning |
|---|---|
| `batch_id` | The import run that wrote the row. An import lists and undoes a run by it. |
| `file_hash` | SHA-256 (lowercase hex) of the whole source file. |
| `reader` | The parser and its version, for example `finance.csv.sparebank1/2`. |

`(source, content_hash)` is now a unique index. A second row with the same key is refused; rows without a `content_hash` do not take part. A database that already has duplicate keys refuses migration 0002 and stays on 0001 until the app removes the duplicates.

## Facts

A fact is one thing that a producer inferred. Table `fact`:

| Column | Meaning |
|---|---|
| `id` | `<kind>_<32 hex>`, see [Fact ids](#fact-ids). It never changes. |
| `kind` | For example `trip` or `finance.category`: lowercase letters, digits, `.` and `-`, no `_`. |
| `scope` | The producer: `<app>.<kinds>`, for example `photos.trips`. |
| `key` | The producer's own stable id for the fact, 1 to 200 characters. |
| `partition` | Optional part of the scope, for example a year. A scope uses partitions always or never. |
| `entity_id` | Optional: the entity in this database that the fact is about. |
| `fields` | The fact, a JSON object. |
| `confidence` | 0 to 1. |
| `method` | The rule or model and its version, for example `rule:trip-nearness/2`. |
| `state` | `active`, or `withdrawn` when the producer no longer infers it. |

Table `fact_source` holds the records that a fact comes from: an entity in this database (`entity_id`), or a record in another app (`app`, `kind`, `ref_id`, the `ref` of [user-records.md](user-records.md)).

`writeFacts(db, scope, facts, { partition })` **replaces** the facts of the scope or partition in one transaction, like `user.claims.write`. A fact that is not in the list is withdrawn, never deleted. When it comes back, it has the same id and its corrections apply again.

### Fact ids

The id of a fact is `<kind>_` and the first 32 lowercase hex digits of the SHA-256 of the UTF-8 bytes of `<scope>` + `"\n"` + `<key>`.

The same producer and key give the same id in every database. That is why corrections survive re-inference and also an export into a new database, where re-inference makes the facts again. A fact that the user made (`create`) has a random id of the same form.

## Corrections

Table `correction`. A correction has an id `cor_<32 hex>` and a time `createdAt`, which the app makes when the person acts, the fact it changes (`fact_id`, no foreign key, so that it outlives a withdrawn fact and can be imported before the fact exists), `op`, `app` (the app in which the user acted), a JSON `body` with its operands, and `created_at`.

| `op` | Operands | Does |
|---|---|---|
| `set` | `record`, `fields` | Sets fields. They stay when apps infer again. |
| `clear` | `record`, `names` | Removes the user's value of these fields. The inferred value applies again. |
| `reject` | `record` | The fact is wrong. It stays rejected, also when it is inferred again. |
| `restore` | `record` | Undoes a reject. |
| `merge` | `records` (two or more) | Joins facts of one kind. The first id stays. The consumer applies it. |
| `create` | `record`, `kind`, `fields` | A fact that the user owns. |

### Records that the user made

What the user enters by hand, for example a home, a workplace or a named place, is a `create` correction: a record that the user made, with a random id of the form `<kind>_<32 hex>`. It is never a fact of a producer. So `writeFacts` never withdraws it: a new Photos library that sends an empty list does not remove the user's homes. The user changes the record with `set` and `clear`, and removes it with `reject` (`restore` brings it back).

- A record is created once. A second `create` for the same `record` is refused, also in an import, because it would reset fields that the user set later. An app that sends existing entries again (Photos on its first run) skips the records it sent before.
- A `create` cannot use the id of an inferred fact.
- An edit of the person is always accepted. The app saves the correction in its own database with a durable outbox, and the shared client sends it to the hub in the background ([facts.md](facts.md#the-outbox)). The client carries the outbox; this package does not queue corrections.

`addCorrection(db, input)` stores a correction with the `id` and `createdAt` of the input; `newCorrectionId()` makes an id. A correction with an `id` that is already stored is a repeat: nothing new is stored, and the stored correction comes back. The same `id` with other content is refused. Corrections are ordered by `createdAt`, then by the order in which they were stored.

`resolveFact(db, id)` gives the fact as the user sees it: the corrections of the fact in time order over the inferred fields, with `state` (`active`, `withdrawn`, or `rejected`), `origin` (`inferred` or `user`), and `corrected` (the field names that the user set). A `set` whose value for a list field is `{ add, remove }` edits the list ([facts.md](facts.md#corrections)): removed elements stay out when the producer infers them again, and new inferred elements come in. `merge` is stored and exported, but the consumer decides what it means, for example Memex.User moves later claims to the first record.

## JSON Lines export

`exportCorrections(db)` writes every correction as one line of JSON, in the order they were made; `importCorrections(db, text)` reads it back. The lines are the export of `memex-user corrections export` ([user-records.md](user-records.md)), and their property names follow `schemas/user/correction.json`: `record` is the fact id.

```json
{"id":"cor_3f6a0c1e9b2d4a7f8e5c1b0d9a8f7e61","op":"set","app":"photos","record":"trip_0451f6f8dcec05dfbabdd9f2b737f179","fields":{"title":"Lisbon with Sam"},"createdAt":"2026-11-18T10:00:00.000Z"}
```

- Property order: `id`, `op`, `app`, `record`, `records`, `kind`, `fields`, `names`, `createdAt`. Properties that the op does not use are left out. No spaces. Characters outside ASCII are written as they are, not as `\u` escapes.
- `createdAt` is UTC with milliseconds. An import accepts any UTC time and stores it with milliseconds.
- The JSON Schema of one line is [correction.schema.json](correction.schema.json).
- An import checks every line before it writes, and writes in one transaction. A correction that is already stored is skipped. The same id with other content is refused. An error names the line.
- The export of an import is byte-identical to the file, when the file came from an export.

## Not in 0.4

- Records that join the claims of several producers, provenance per field, and alternatives are in `@tjalve/memex-facts` ([facts.md](facts.md#records)). A record keeps the fact id of its first claim as its id, so that corrections on it stay valid.
- No limits on the number of sources per fact (User allows 100) or facts per write (User allows 5 000); the consumer enforces its own limits.
