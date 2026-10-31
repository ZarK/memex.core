# Memex.Contacts records

**Version:** 1 (25 October 2026). The JSON Schemas are in [schemas/contacts/](../schemas/contacts/) and [schemas/facts/](../schemas/facts/facts.json). The OpenAPI file for these capabilities is [openapi/contacts.v1.yaml](../openapi/contacts.v1.yaml).

Memex.Contacts keeps facts about other people and the edges between people: their homes, workplaces, circles, relations, dates, and identities, each over time. Every app that knows something about a person writes it as claims: Contacts itself from each revision of a card, Photos from what the person enters about a linked person, and later Conversations and Calendar. Contacts joins the claims for a person into one picture over time, and every app reads it.

Contacts runs the same facts engine as Memex.User, `@tjalve/memex-facts`. The shared rules are in [facts.md](facts.md): claims and their fields, joins, combining, provenance, review, corrections and their results, the outbox, and the change feed. This contract gives what is particular to Contacts: persons and merges, subjects, the kinds, and the operations.

Facts about the owner go to Memex.User ([user-records.md](user-records.md)). Contacts sends the owner's own card as claims to User (`contacts.persons`, `contacts.homes`, `contacts.workplaces`, with `seen` only).

Import, search, and the other parts of Contacts (cards, revisions, sources, the CardDAV client) are in the Contacts repository and its plan. This contract covers the facts and the persons that they are about.

## Privacy

- Everything stays on the owner's machines. Nothing comes from public sources.
- Contacts holds the address book with its revisions, what the person entered, and facts derived from these. In v1 it holds no message text, subjects, attachments, group titles, or copies of interactions. When you last talked comes from Conversations by reference, when it is asked.
- Derived facts are marked by their provenance. They are not in a vCard export by default, and a later two-way sync never writes them to the address book provider.
- The agent never confirms a merge, links a handle, or corrects a person by itself. The MCP tool `contacts_corrections_write` sets `destructiveHint`.

## Service

- Contacts follows [surfaces.md](surfaces.md): loopback HTTP on `127.0.0.1`, port 0, a new token at each launch, and the app record `<apps>/contacts.json`. Its data is in `~/Memex/Contacts/`, in the `data` folder of [storage.md](storage.md).
- Apps start it with `ensureApp`. It stops when it is idle.
- Its MCP server has every read capability and `contacts.corrections.write`. Claims come only from apps, over HTTP.

## Persons

A person is the record that every other kind is about. Contacts makes persons from its own cards: each source card gives one claim in the scope `contacts.persons`, with the card as its subject. Only Contacts writes person claims. The person makes a new person with `create`.

| Field | Meaning |
|---|---|
| `name` | Required. |
| `otherNames` | Other names, for example a nickname or a maiden name. |
| `type` | `person`, `organization`, or `unknown`. An employer on a card does not make the card an organization. |

- A person id is `person_` and 32 lowercase hex digits. It never changes.
- Two persons become one only by a `merge` correction from the person. Equal names never merge, and no rule merges by itself. Contacts proposes merges, for example by an exact phone or e-mail; the person confirms them, one by one or many at once.
- A merged person stays as a **redirect**: its record has `mergedInto`, the person it was merged into. Contacts never rewrites the references that other apps keep, so an app that holds the merged id finds the person through the redirect, and an `unmerge` gives the old id back.
- After a merge, the claims of both persons join under the person that stays. After an unmerge, each claim goes back to the person of its source card. Records made after the merge stay with the person that stayed.
- A **pin** keeps two persons apart: "these are two people, stop proposing". Proposals respect a pin until an `unpin`. A merge from the person is the person's own decision and is applied also when a pin exists; it removes the pin.

## Subjects

A claim in Contacts has `subject`: the identity that the producer knows. It is exactly one of:

| Subject | Who uses it |
|---|---|
| `{ "person": "person_…" }` | An app that holds a Contacts reference, for example Photos for a face group that the person linked. |
| `{ "card": "card_…" }` | Contacts itself, for the claims from a source card. |
| `{ "handle": "+12015550147", "at": "…" }` | An app that knows a handle, for example Conversations. `at` is required: the time of the evidence. |

- Contacts resolves the subject to a person when it fuses the claim, and again after each merge, unmerge, or handle correction. The record has the result in `person`.
- A handle resolves only when exactly one person holds the identity, valid at `at`. A shared identity, a handle that two persons hold, and an unparsed handle never resolve.
- A claim whose subject does not resolve is stored and counted as `unresolved`. It joins a record when its subject resolves.
- A relation has `other`, the second subject, and so can a date that links two persons, for example an anniversary. The record has the result in `other`.
- Handles that a message sends with `fromMe` are the owner's. "Not Anna" on a handle rejects that identity of Anna, and Conversations resolves again from the change feed.

## Kinds

Every record except a person has `person`: the person that it is about. Required fields are in bold.

| Kind | Fields | Join ([facts.md](facts.md#joins)) |
|---|---|---|
| `person` | **`name`**, `otherNames`, `type` | Never; only a `merge`. |
| `home` | `type` (`home` or `cabin`), `label`, `location`, `address`, `town`, `country`, `from`, `to`, `residents` (each: **`person`**, `from`, `to`, `child`: the other persons who lived there). At least one of `address`, `town`, or `location`. | The same person; the same normalized address or locations within 150 m; spans that overlap or are less than 90 days apart. |
| `workplace` | **`name`**, `type` (`employer`, `client`, `own`, or `school`), `sites` (each: **`location`**, `label`, `type`), `stints` (each: `from`, `to`, `title`) | The same person; the same normalized name or a site within the radius. |
| `circle` | **`name`**, `from`, `to` | The same person and the same name. |
| `relation` | **`type`** (`partner`, `parent`, `child`, `sibling`, `family`, `friend`, `colleague`, or `other`), `label`, `from`, `to`; the record has `other` | The same pair and the same type. |
| `date` | **`type`** (`birthday`, `anniversary`, `memorial`, `firstMet`, or `other`), **`date`**, `label`; the record can have `other` | The same person (or pair) and the same type. |
| `identity` | **`type`** (`email`, `phone`, or `handle`), **`value`**, `service`, `label`, `from`, `to`, `shared` | The same person and the same handle. |

Value rules:

- `from`, `to`, `location`, and `country` follow [user-records.md](user-records.md#kinds). A card proves that a value was listed, not when it was true: card claims have `seen` and no `from` or `to`, and readers show "listed from" and "listed until" ([facts.md](facts.md#claims)).
- `date` is `YYYY`, `YYYY-MM`, `YYYY-MM-DD`, or `--MM-DD` for a birthday without a year. `1984` and `--03-12` refine to `1984-03-12` only with a correction or a claim that gives the whole date.
- `value` is the normalized handle of [message.md](message.md): E.164 for a phone, a lowercase address for e-mail, or `<service>:<name>`. `from` and `to` let a reused number resolve by the date of the evidence. `shared: true` marks an identity that more than one person uses, for example a family address; it never resolves evidence to one person.
- A person in `residents`, `person`, or `other` is a Contacts person id. The owner, too, is a Contacts person (the `contact` of the owner in User).

## Claims

Claims follow [facts.md](facts.md#claims), with `subject` and, for a relation or a date, `other`. Scopes are `<app>.<kinds>` with the kinds `persons`, `homes`, `workplaces`, `circles`, `relations`, `dates`, and `identities`.

```json
{
  "scope": "contacts.homes",
  "claims": [
    {
      "key": "card_f8bd9d9b97259addc818793929b06c90:adr:0",
      "kind": "home",
      "subject": { "card": "card_f8bd9d9b97259addc818793929b06c90" },
      "confidence": 0.9,
      "method": "card:vcard/1",
      "generation": 41,
      "seen": { "first": "2023-03-01T09:00:00Z", "last": "2026-11-16T10:00:00Z" },
      "fields": { "label": "home", "address": "Eksempelveien 1", "town": "Trondheim", "country": "NO" },
      "sources": [{ "app": "contacts", "kind": "card", "id": "card_f8bd9d9b97259addc818793929b06c90" }]
    }
  ]
}
```

| Scope | Producer |
|---|---|
| `contacts.persons`, `contacts.homes`, `contacts.workplaces`, `contacts.dates`, `contacts.identities` | Contacts, from each revision of each card |
| `photos.circles` | Photos: the circles that the person confirms on "Who you're with". Suggested circles stay in Photos. |
| `photos.relations`, `photos.dates` | Photos: what the person enters between linked persons |
| `conversations.identities` | Conversations, later: handles seen with a person |

- `contacts.claims.write` replaces the claims of the scope or partition, and refuses a lower `generation` with 409 (`stale-generation`).
- The response gives `changeId`, `summary`, the counts (`created`, `updated`, `unchanged`, `withdrawn`, `removed`, and `unresolved`), and for each key the record id, or `null` while its subject does not resolve.
- What the person enters about a linked person in another app (a home with its residents, a workplace) is a `create` or `set` correction through the outbox, not a claim, so a new library cannot remove it.

## Corrections, merges, and pins

Corrections follow [facts.md](facts.md#corrections). Contacts adds three operations:

| `op` | Fields | Does |
|---|---|---|
| `unmerge` | `record` (a merged person) | Undoes the merge of that person. It gets its id and its source cards back; each claim goes back to the person of its card. |
| `pin` | `records` (two persons) | Keeps the two persons apart. Proposals respect it. |
| `unpin` | `records` (two persons) | Removes the pin. |

- `merge` of persons: the first id stays, and every other person gets `mergedInto`. `merge` of other records works as in User: the other records are removed with `mergedInto` in the change feed.
- `create` of a kind other than person has `person`, the person that the new record is about, and for a relation `other`.
- An `unmerge` of a person that is not merged is stored and held with the reason `not-merged`.
- A correction for a merged person, or for a record of a merged person, applies to the person that it was merged into. After an unmerge, a correction stays with the record that it was made on.
- Contacts writes corrections and merge decisions to the archive, so a rebuild from the archive keeps them. Corrections attach again by their record id or by their anchors ([facts.md](facts.md#corrections)).

## Changes

`contacts.changes.list` follows [facts.md](facts.md#the-change-feed). Each change also has `person`: the person that the record is about, or for a person record its own id. A reader can filter by `person`.

- A merged person comes as an `upsert` whose record has `mergedInto`. An unmerge comes as an `upsert` of the person without `mergedInto`, followed by the records that went back to it.
- A merged record of another kind comes as a `remove` with `mergedInto`.

## Capabilities

| Id | Kind | Does |
|---|---|---|
| `contacts.claims.write` | write | Replaces the claims of a scope or partition. HTTP only. |
| `contacts.corrections.write` | write | Stores corrections, merges, unmerges, and pins (at most 500 in one call). |
| `contacts.corrections.list` | read | Lists corrections, for one record or all. |
| `contacts.changes.list` | read | The change feed. |
| `contacts.<kinds>.list` | read | For each kind: `contacts.persons.list`, `contacts.homes.list`, `contacts.workplaces.list`, `contacts.circles.list`, `contacts.relations.list`, `contacts.dates.list`, `contacts.identities.list`. |
| `contacts.<kinds>.get` | read | For each kind: one record by `id`. A merged person comes back with `mergedInto`. |

List inputs: `from` and `to`, `person` (Contacts follows redirects, so a merged person's id finds the records of the person that stayed), `review`, `includeRejected`, `includeMerged` (persons only), `limit` (default 100, at most 1 000), and `cursor`.

## Fixtures

All example people, numbers and addresses in this contract and its fixtures are made up. Phone numbers are in the US range 555-0100 to 555-0199, which is kept for fiction, and mail addresses use `example.com`, `example.net` and `example.org`.

[fixtures/contacts/](fixtures/contacts/) holds a fictional person, Jon Example, who exists twice (an Apple card and a Google card): claims writes from card revisions for homes, workplaces, dates, and identities (one of them a shared family address), a claims write from Conversations with handle subjects (the phone resolves to Jon at the message date; the shared address does not resolve, and its claim waits), the circle and the relation that the person confirmed in Photos, a record of each kind, the person that stayed and the merged person with its redirect, a page of `contacts.homes.list` asked by the merged id, corrections (a home that the person entered in Photos with a resident, a merge of the two persons, a pin, a birthday year, a list edit of residents, and a merge of two homes), an unmerge and a held unmerge, and a page of changes. `index.json` names the schema of each file. `packages/schema/test/contracts.test.ts` checks each fixture against its schema and writes it back byte for byte; the TypeScript and C# clients must do the same.
