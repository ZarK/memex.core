# @tjalve/memex-schema

The core SQLite schema of Memex and helpers over it: the entity spine, provenance with the import dedupe key, derived facts with stable ids, and user corrections that survive re-inference. It also has the TypeScript types of the facts records of Memex.User and Memex.Contacts. See [contracts/derived-facts.md](../../contracts/derived-facts.md), [contracts/facts.md](../../contracts/facts.md), and [contracts/connector.md](../../contracts/connector.md).

It runs on [`@tjalve/memex-sqlite`](../sqlite/README.md).

```ts
import { openDatabase } from "@tjalve/memex-sqlite";
import { nodeSqlite } from "@tjalve/memex-sqlite/node-sqlite";
import { migrateCore, writeFacts, addCorrection, newCorrectionId, resolveFact, exportCorrections } from "@tjalve/memex-schema";

const db = openDatabase(join(paths.data, "user.db"), { driver: nodeSqlite });
migrateCore(db); // scope 'core': 0001_entity_spine.sql, 0002_derived_facts.sql

const { ids } = writeFacts(db, "photos.trips", [
  { key: "trip_lisbon_2025", kind: "trip", confidence: 0.92, method: "rule:trip-nearness/2",
    fields: { title: "Lisbon" }, sources: [{ app: "photos", kind: "trip", id: "trip_lisbon_2025" }] },
]);
// The app makes the id and the time when the person acts.
addCorrection(db, { id: newCorrectionId(), createdAt: new Date().toISOString(),
  op: "set", app: "photos", record: ids[0]!, fields: { title: "Lisbon with Sam" } });
resolveFact(db, ids[0]!); // fields.title is "Lisbon with Sam", also after the next writeFacts
const jsonl = exportCorrections(db); // importCorrections(otherDb, jsonl) reads it back
```

| Function | Does |
|---|---|
| `migrateCore(db)` | Applies the core migrations. `CORE_MIGRATIONS_DIR` is their folder, for `assertSchemaMatches`. |
| `createEntity`, `getEntity`, `touchEntity`, `softDeleteEntity`, `link` | The entity spine. |
| `recordProvenance`, `findEntityByProvenance`, `listProvenanceByBatch` | Provenance v2: `batchId`, `fileHash`, `reader`; `(source, contentHash)` is unique. |
| `factId(kind, scope, key)` | The stable id of a fact. |
| `writeFacts(db, scope, facts, { partition })` | Replaces the facts of a producer; facts that are not in the list are withdrawn. |
| `getFact`, `factSources`, `factsBySource` | Read facts and their sources. |
| `addCorrection`, `newCorrectionId`, `listCorrections` | Store corrections with the app's `id` and `createdAt` (a repeated `id` stores nothing new), make an id, and list them by `createdAt`. |
| `resolveFact(db, id)`, `applyListEdits` | The fact with the corrections applied, with list edits (`{ add, remove }`). |
| `UserRecord`, `ContactsRecord`, `UserClaim`, `ContactsClaim`, `UserCorrection`, `ContactsCorrection`, `UserChange`, `ContactsChange`, `Provenance`, `Alternatives`, `ListEdit`, `isListEdit` | Types of [user-records.md](../../contracts/user-records.md) v2 and [contacts-records.md](../../contracts/contacts-records.md). The JSON Schemas are canonical. |
| `exportCorrections`, `importCorrections` | Corrections as JSON Lines. |

It depends on `@tjalve/memex-sqlite` as `workspace:*`, so it installs only inside the memex.core workspace, not with `file:` or git from another repository. Use a released version instead: `pnpm pack` writes exact versions in place of `workspace:*`. Releases go through npm staged publishing; see [docs/releasing.md](../../docs/releasing.md).

0.3 replaces the better-sqlite3 `openDatabase` and `migrate` of 0.1 with `@tjalve/memex-sqlite`, which reads the `schema_migrations` rows that 0.1 wrote.

0.4 takes `id` and `createdAt` from the app in `addCorrection`, applies list edits in `resolveFact`, and adds the facts record types. It changes no tables.
