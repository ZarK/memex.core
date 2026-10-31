import { migrate, type Migration, type SqliteDatabase } from "@tjalve/memex-sqlite";
import {
  checkCorrection,
  createdMs,
  isLocalId,
  localRefs,
  newCorrectionId,
  newLocalId,
  targetsOf,
  utcNow,
  withRecordIds,
  type Hub,
  type HubCorrection,
  type HubCorrectionResult,
  type HubRecord,
} from "./corrections.js";

/**
 * The tables of the client in the app's own database: the outbox, the held marks, the record ids of the
 * app's creates, the feed cursor, the local copy, and the records that wait to be read back. They have the prefix memex_facts_ and the migration scope
 * memex-user-client, so they sit beside the app's own tables.
 */
export const STORE_SCOPE = "memex-user-client";

export const STORE_MIGRATIONS: readonly Migration[] = [
  {
    name: "0001_outbox.sql",
    sql: `
CREATE TABLE memex_facts_outbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  hub TEXT NOT NULL CHECK (hub IN ('user', 'contacts')),
  id TEXT NOT NULL UNIQUE,
  created_ms INTEGER NOT NULL,
  local_id TEXT,
  correction TEXT NOT NULL,
  refused TEXT,
  refused_version TEXT,
  mark_cleared INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  saved_at TEXT NOT NULL
);
CREATE INDEX memex_facts_outbox_order ON memex_facts_outbox (hub, created_ms, seq);

CREATE TABLE memex_facts_held (
  id TEXT PRIMARY KEY,
  hub TEXT NOT NULL,
  created_ms INTEGER NOT NULL,
  correction TEXT NOT NULL,
  record TEXT,
  code TEXT NOT NULL,
  message TEXT NOT NULL,
  held_at TEXT NOT NULL
);

CREATE TABLE memex_facts_local_id (
  hub TEXT NOT NULL,
  local_id TEXT NOT NULL,
  record TEXT NOT NULL,
  PRIMARY KEY (hub, local_id)
);

CREATE TABLE memex_facts_cursor (
  hub TEXT PRIMARY KEY,
  cursor TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE memex_facts_copy (
  hub TEXT NOT NULL,
  id TEXT NOT NULL,
  kind TEXT NOT NULL,
  version INTEGER NOT NULL,
  state TEXT NOT NULL,
  removed INTEGER NOT NULL DEFAULT 0,
  merged_into TEXT,
  record TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (hub, id)
);
`,
  },
  {
    name: "0002_read_back.sql",
    sql: `
CREATE TABLE memex_facts_read_back (
  hub TEXT NOT NULL,
  record TEXT NOT NULL,
  added_at TEXT NOT NULL,
  PRIMARY KEY (hub, record)
);
`,
  },
];

/** Installs or updates the client's tables. Call it once at the app's start, outside a transaction. */
export function installStore(db: SqliteDatabase): void {
  migrate(db, STORE_SCOPE, STORE_MIGRATIONS);
}

/** A correction in the outbox. */
export interface OutboxItem {
  hub: Hub;
  correction: HubCorrection;
  /** For a create: the app's id for the new record until the hub gives its id. */
  localId?: string;
  /** The hub refused it (400): the error, and the app version that saw it. The sync tries it again after an app update. */
  refused?: { code: string; message: string; field?: string; appVersion: string; cleared: boolean };
  attempts: number;
  savedAt: string;
}

/** A correction that the hub stored and did not apply (facts.md, Held reasons). */
export interface HeldMark {
  hub: Hub;
  correction: HubCorrection;
  record?: string;
  code: string;
  message: string;
  heldAt: string;
}

/** A record of the local copy, with the hub's fields and the person's edits that wait. */
export interface LocalRecord {
  hub: Hub;
  id: string;
  kind: string;
  version: number;
  state: string;
  removed: boolean;
  mergedInto?: string;
  record: HubRecord;
}

/** A correction to save: id and createdAt are made now when they are left out; app comes from the store. */
export type CorrectionInput = Omit<HubCorrection, "id" | "createdAt" | "app"> & { id?: string; createdAt?: string; app?: string };

/** What save returns: the correction as it waits in the outbox, and the local id of a create. */
export interface SavedCorrection {
  correction: HubCorrection;
  localId?: string;
}

interface OutboxRow {
  seq: number;
  hub: Hub;
  id: string;
  created_ms: number;
  local_id: string | null;
  correction: string;
  refused: string | null;
  refused_version: string | null;
  mark_cleared: number;
  attempts: number;
  saved_at: string;
}

interface CopyRow {
  hub: Hub;
  id: string;
  kind: string;
  version: number;
  state: string;
  removed: number;
  merged_into: string | null;
  record: string;
}

/** A change of the feed, or a record that the app read back, to apply to the local copy. */
export interface IncomingChange {
  op: "upsert" | "remove";
  id: string;
  kind: string;
  version: number;
  record?: HubRecord;
  mergedInto?: string;
}

/**
 * The outbox, the held marks, and the local copy of one app database. Every method is synchronous and runs in the
 * caller's transaction when there is one, so an app writes its own edit and the correction in one transaction.
 */
export class FactsStore {
  constructor(
    readonly db: SqliteDatabase,
    readonly app: string,
  ) {}

  // ------------------------------------------------------------ saving

  /**
   * Saves a person's edit: applies it to the local copy and puts the correction in the outbox, in one transaction (the
   * caller's, when it has one). It never fails because a hub is stopped or failing.
   */
  save(hub: Hub, input: CorrectionInput): SavedCorrection {
    const now = Date.now();
    const correction = { ...input, id: input.id ?? newCorrectionId(now), createdAt: input.createdAt ?? utcNow(now), app: input.app ?? this.app } as HubCorrection;
    checkCorrection(hub, correction);
    const localId = correction.op === "create" ? newLocalId(now) : undefined;
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO memex_facts_outbox (hub, id, created_ms, local_id, correction, saved_at) VALUES (?, ?, ?, ?, ?, ?)`,
        hub,
        correction.id,
        createdMs(correction.createdAt),
        localId ?? null,
        JSON.stringify(correction),
        utcNow(),
      );
      this.applyEdit(hub, correction, localId);
    });
    return localId ? { correction, localId } : { correction };
  }

  /** The items of a hub's outbox in createdAt order, then in the order they were saved. */
  outbox(hub: Hub): OutboxItem[] {
    return this.rows(hub).map((r) => this.item(r));
  }

  /** The held marks of a hub. */
  held(hub: Hub): HeldMark[] {
    return this.db
      .all<{ hub: Hub; correction: string; record: string | null; code: string; message: string; held_at: string }>(
        "SELECT * FROM memex_facts_held WHERE hub = ? ORDER BY created_ms, id",
        hub,
      )
      .map((r) => ({ hub: r.hub, correction: JSON.parse(r.correction), ...(r.record ? { record: r.record } : {}), code: r.code, message: r.message, heldAt: r.held_at }));
  }

  /** The record id that the hub gave the create of a local id. */
  recordIdOf(hub: Hub, localId: string): string | undefined {
    return this.db.get<{ record: string }>("SELECT record FROM memex_facts_local_id WHERE hub = ? AND local_id = ?", hub, localId)?.record;
  }

  /** The id under which the local copy keeps a record: the hub's id once a create has one, else the local id. */
  currentId(hub: Hub, id: string): string {
    return isLocalId(id) ? (this.recordIdOf(hub, id) ?? id) : id;
  }

  /**
   * The person removes a local entry (user-records.md, Held corrections): its marks for unknown-record and refused
   * corrections clear, and the local copy forgets the record. Nothing is sent for it.
   */
  removeLocalEntry(hub: Hub, id: string): void {
    const record = this.currentId(hub, id);
    this.db.transaction(() => {
      this.db.run("DELETE FROM memex_facts_held WHERE hub = ? AND record = ? AND code = 'unknown-record'", hub, record);
      for (const row of this.rows(hub)) {
        if (!row.refused) continue;
        const c = JSON.parse(row.correction) as HubCorrection;
        if (targetsOf(c, row.local_id).some((t) => this.currentId(hub, t.record) === record)) {
          this.db.run("UPDATE memex_facts_outbox SET mark_cleared = 1 WHERE seq = ?", row.seq);
        }
      }
      this.db.run("DELETE FROM memex_facts_copy WHERE hub = ? AND id = ?", hub, record);
    });
  }

  // ------------------------------------------------------------ sending

  /**
   * The next corrections to send, at most `limit`, in createdAt order (facts.md, The outbox): a correction that the hub
   * refused is left out until the app version changes, with the corrections that refer to its local id; the batch ends
   * before the first correction that refers to a local id whose create has no record id yet.
   */
  nextBatch(hub: Hub, appVersion: string, limit = 500): { seq: number; correction: HubCorrection; localId?: string }[] {
    const batch: { seq: number; correction: HubCorrection; localId?: string }[] = [];
    const blocked = new Set<string>();
    const pendingCreates = new Set(this.rows(hub).filter((r) => r.local_id).map((r) => r.local_id!));
    for (const row of this.rows(hub)) {
      const c = JSON.parse(row.correction) as HubCorrection;
      if (row.refused && row.refused_version === appVersion) {
        if (row.local_id) blocked.add(row.local_id);
        continue;
      }
      const refs = localRefs(c).filter((l) => l !== row.local_id);
      if (refs.some((l) => blocked.has(l))) {
        if (row.local_id) blocked.add(row.local_id);
        continue;
      }
      const unresolved = refs.filter((l) => !this.recordIdOf(hub, l));
      if (unresolved.length) {
        if (unresolved.some((l) => pendingCreates.has(l))) break;
        // A local id that no create in the outbox makes and the hub never gave: the app has a mistake. The correction
        // stays, with a mark, and the others go on.
        this.markRefused(row.seq, { code: "unknown-local-id", message: `The correction refers to ${unresolved.join(", ")}, which no create in the outbox makes.` }, appVersion);
        if (row.local_id) blocked.add(row.local_id);
        continue;
      }
      batch.push({ seq: row.seq, correction: withRecordIds(c, (l) => this.recordIdOf(hub, l)), ...(row.local_id ? { localId: row.local_id } : {}) });
      if (batch.length >= limit) break;
    }
    return batch;
  }

  /** Counts a send attempt. */
  countAttempt(seqs: number[]): void {
    this.db.transaction(() => {
      for (const seq of seqs) this.db.run("UPDATE memex_facts_outbox SET attempts = attempts + 1 WHERE seq = ?", seq);
    });
  }

  /** The hub refused the correction (400): it stays in the outbox with the error as its mark. */
  markRefused(seq: number, error: { code: string; message: string; field?: string }, appVersion: string): void {
    this.db.run(
      "UPDATE memex_facts_outbox SET refused = ?, refused_version = ?, mark_cleared = 0 WHERE seq = ?",
      JSON.stringify({ code: error.code, message: error.message, ...(error.field ? { field: error.field } : {}) }),
      appVersion,
      seq,
    );
  }

  /**
   * The hub stored these corrections: each leaves the outbox. A create gives its local id the record id; a held
   * correction keeps its mark; a stored correction clears the marks that it decides (user-records.md, Held
   * corrections); the local copy takes the version of each result. The records to read back once (those with
   * overridden, superseded, repeatOf, or a record other than the one in the correction) are written to the read-back
   * table in the same transaction, so a read back that fails or never runs is done in a later round. Returns them.
   */
  stored(hub: Hub, sent: { seq: number; correction: HubCorrection; localId?: string }[], results: HubCorrectionResult[]): string[] {
    const readBack = new Set<string>();
    this.db.transaction(() => {
      results.forEach((result, i) => {
        const item = sent[i];
        if (!item || item.correction.id !== result.id) return;
        const c = item.correction;
        this.db.run("DELETE FROM memex_facts_outbox WHERE seq = ?", item.seq);
        if (item.localId && result.record) {
          this.db.run("INSERT OR REPLACE INTO memex_facts_local_id (hub, local_id, record) VALUES (?, ?, ?)", hub, item.localId, result.record);
          this.renameCopy(hub, item.localId, result.record);
        }
        this.clearMarks(hub, c, item.localId);
        if (result.status === "held") {
          this.db.run(
            "INSERT OR REPLACE INTO memex_facts_held (id, hub, created_ms, correction, record, code, message, held_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            c.id,
            hub,
            createdMs(c.createdAt),
            JSON.stringify(c),
            result.record ?? c.record ?? null,
            result.reason?.code ?? "held",
            result.reason?.message ?? "",
            utcNow(),
          );
        }
        if (result.record && result.version !== undefined) {
          this.db.run("UPDATE memex_facts_copy SET version = ? WHERE hub = ? AND id = ? AND version < ?", result.version, hub, result.record, result.version);
        }
        const other = result.record !== undefined && result.record !== c.record;
        if (result.record && (result.overridden || result.status === "superseded" || result.repeatOf || other)) readBack.add(result.record);
      });
      const now = utcNow();
      for (const record of readBack) this.db.run("INSERT OR IGNORE INTO memex_facts_read_back (hub, record, added_at) VALUES (?, ?, ?)", hub, record, now);
    });
    return [...readBack];
  }

  /** The records that wait to be read back once (user-records.md, Reading back), oldest first. */
  readBacks(hub: Hub): string[] {
    return this.db.all<{ record: string }>("SELECT record FROM memex_facts_read_back WHERE hub = ? ORDER BY added_at, record", hub).map((r) => r.record);
  }

  /**
   * A record was read back: the record (undefined when the hub no longer has it) goes into the local copy and the
   * record leaves the read-back table, in one transaction. Returns whether the local copy took it.
   */
  readBackDone(hub: Hub, id: string, record: HubRecord | undefined): boolean {
    let applied = false;
    this.db.transaction(() => {
      if (record) applied = this.applyChange(hub, { op: "upsert", id: record.id, kind: record.kind, version: record.version, record });
      this.db.run("DELETE FROM memex_facts_read_back WHERE hub = ? AND record = ?", hub, id);
    });
    return applied;
  }

  /** The marks that a stored correction decides clear: a later correction of the same field or the same record. */
  private clearMarks(hub: Hub, c: HubCorrection, localId?: string): void {
    const created = createdMs(c.createdAt);
    const targets = targetsOf(c, localId).map((t) => ({ ...t, record: this.currentId(hub, t.record) }));
    if (!targets.length) return;
    const decides = (other: HubCorrection, otherLocal: string | null, code: string | null): boolean => {
      if (createdMs(other.createdAt) > created) return false;
      if (code === "record-rejected") return (c.op === "reject" || c.op === "restore") && targets.some((t) => t.record === this.currentId(hub, other.record ?? ""));
      if (code === "record-removed") return false; // clears when the feed gives the record again
      return targetsOf(other, otherLocal).some((o) =>
        targets.some(
          (t) =>
            t.record === this.currentId(hub, o.record) &&
            (c.op === "reject" || c.op === "restore" || c.op === "merge" || t.fields === "*" || o.fields === "*" || o.fields.some((f) => (t.fields as string[]).includes(f))),
        ),
      );
    };
    for (const h of this.db.all<{ id: string; correction: string; code: string }>("SELECT id, correction, code FROM memex_facts_held WHERE hub = ?", hub)) {
      if (h.id !== c.id && decides(JSON.parse(h.correction), null, h.code)) this.db.run("DELETE FROM memex_facts_held WHERE id = ?", h.id);
    }
    for (const row of this.rows(hub)) {
      if (row.refused && !row.mark_cleared && decides(JSON.parse(row.correction), row.local_id, null)) {
        this.db.run("UPDATE memex_facts_outbox SET mark_cleared = 1 WHERE seq = ?", row.seq);
      }
    }
  }

  // ------------------------------------------------------------ the feed and the local copy

  /** The cursor of the last change that the app applied. */
  cursor(hub: Hub): string | undefined {
    return this.db.get<{ cursor: string }>("SELECT cursor FROM memex_facts_cursor WHERE hub = ?", hub)?.cursor;
  }

  /** Applies changes of the feed and stores the cursor of the last one, in one transaction. */
  applyChanges(hub: Hub, changes: (IncomingChange & { cursor: string })[]): number {
    if (!changes.length) return 0;
    let applied = 0;
    this.db.transaction(() => {
      for (const change of changes) if (this.applyChange(hub, change)) applied++;
      this.db.run(
        "INSERT INTO memex_facts_cursor (hub, cursor, updated_at) VALUES (?, ?, ?) ON CONFLICT (hub) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at",
        hub,
        changes[changes.length - 1]!.cursor,
        utcNow(),
      );
    });
    return applied;
  }

  /**
   * Applies one change to the local copy (facts.md, The change feed): when its version is equal to or higher than the
   * local version, to every field that is not protected. A protected field keeps its local value, so the screen never
   * jumps back to an older value. Returns false when the change is older than the local copy.
   */
  applyChange(hub: Hub, change: IncomingChange): boolean {
    const local = this.copyRow(hub, change.id);
    if (local && change.version < local.version) return false;
    if (change.op === "upsert") this.db.run("DELETE FROM memex_facts_held WHERE hub = ? AND record = ? AND code = 'record-removed'", hub, change.id);
    if (change.op === "remove") {
      if (local) {
        this.db.run(
          "UPDATE memex_facts_copy SET version = ?, removed = 1, merged_into = ?, updated_at = ? WHERE hub = ? AND id = ?",
          change.version,
          change.mergedInto ?? null,
          utcNow(),
          hub,
          change.id,
        );
      }
      return true;
    }
    const incoming = structuredClone(change.record!) as HubRecord & { mergedInto?: string };
    const protectedFields = this.protectedFields(hub, change.id);
    if (local && protectedFields.size) {
      const mine = JSON.parse(local.record) as HubRecord;
      const fields = incoming.fields as Record<string, unknown>;
      if (protectedFields.has("*")) {
        incoming.fields = structuredClone(mine.fields);
        incoming.state = mine.state;
      } else {
        for (const f of protectedFields) {
          if (f === "state") incoming.state = mine.state;
          else if (f in mine.fields) fields[f] = structuredClone((mine.fields as Record<string, unknown>)[f]);
          else delete fields[f];
        }
      }
    }
    this.db.run(
      `INSERT INTO memex_facts_copy (hub, id, kind, version, state, removed, merged_into, record, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)
       ON CONFLICT (hub, id) DO UPDATE SET kind = excluded.kind, version = excluded.version, state = excluded.state, removed = 0,
         merged_into = excluded.merged_into, record = excluded.record, updated_at = excluded.updated_at`,
      hub,
      change.id,
      change.kind,
      change.version,
      incoming.state,
      incoming.mergedInto ?? null,
      JSON.stringify(incoming),
      utcNow(),
    );
    return true;
  }

  /**
   * The protected fields of a record: those of the corrections in the outbox, and of the corrections with a mark (held,
   * or refused and not cleared). "*" protects the whole record, "state" the state.
   */
  protectedFields(hub: Hub, id: string): Set<string> {
    const out = new Set<string>();
    const add = (c: HubCorrection, localId: string | null) => {
      for (const t of targetsOf(c, localId)) {
        if (this.currentId(hub, t.record) !== id) continue;
        if (t.fields === "*") out.add("*");
        else t.fields.forEach((f) => out.add(f));
      }
    };
    for (const row of this.rows(hub)) if (!(row.refused && row.mark_cleared)) add(JSON.parse(row.correction), row.local_id);
    for (const h of this.db.all<{ correction: string }>("SELECT correction FROM memex_facts_held WHERE hub = ?", hub)) add(JSON.parse(h.correction), null);
    return out;
  }

  /** One record of the local copy, by the hub's id or by the local id of a create. */
  record(hub: Hub, id: string): LocalRecord | undefined {
    const row = this.copyRow(hub, this.currentId(hub, id));
    return row ? this.local(row) : undefined;
  }

  /** The records of the local copy, without removed ones unless asked. */
  records(hub: Hub, options: { kind?: string; includeRemoved?: boolean } = {}): LocalRecord[] {
    return this.db
      .all<CopyRow>("SELECT * FROM memex_facts_copy WHERE hub = ? AND (? IS NULL OR kind = ?) ORDER BY kind, id", hub, options.kind ?? null, options.kind ?? null)
      .filter((r) => options.includeRemoved || !r.removed)
      .map((r) => this.local(r));
  }

  /** The person's edit in the local copy, at once, so the screen shows it as saved. */
  private applyEdit(hub: Hub, c: HubCorrection, localId?: string): void {
    const now = utcNow();
    if (c.op === "create") {
      const record = {
        id: localId!,
        kind: c.kind!,
        version: 0,
        state: "active",
        origin: "user",
        confidence: 1,
        review: false,
        fields: structuredClone(c.fields ?? {}),
        provenance: {},
        alternatives: {},
        corrected: Object.keys(c.fields ?? {}),
        claims: [],
        sources: c.sources ?? [],
        createdAt: c.createdAt,
        updatedAt: c.createdAt,
      } as unknown as HubRecord;
      this.db.run(
        "INSERT INTO memex_facts_copy (hub, id, kind, version, state, record, updated_at) VALUES (?, ?, ?, 0, 'active', ?, ?)",
        hub,
        localId!,
        c.kind!,
        JSON.stringify(record),
        now,
      );
      return;
    }
    const update = (id: string, change: (r: HubRecord & { mergedInto?: string }) => void, merged?: { removed: boolean; mergedInto: string | null }) => {
      const row = this.copyRow(hub, this.currentId(hub, id));
      if (!row) return;
      const r = JSON.parse(row.record) as HubRecord;
      change(r);
      this.db.run(
        "UPDATE memex_facts_copy SET record = ?, state = ?, removed = ?, merged_into = ?, updated_at = ? WHERE hub = ? AND id = ?",
        JSON.stringify(r),
        r.state,
        merged ? (merged.removed ? 1 : 0) : row.removed,
        merged ? merged.mergedInto : row.merged_into,
        now,
        hub,
        row.id,
      );
    };
    switch (c.op) {
      case "set":
        update(c.record!, (r) => {
          const fields = r.fields as Record<string, unknown>;
          for (const [k, v] of Object.entries(c.fields ?? {})) fields[k] = isListEdit(v) ? editList(fields[k], v) : structuredClone(v);
          r.corrected = [...new Set([...(r.corrected ?? []), ...Object.keys(c.fields ?? {})])];
        });
        break;
      case "clear":
        // The inferred value is not known here; the field keeps its value until the hub's record comes back.
        update(c.record!, (r) => {
          r.corrected = (r.corrected ?? []).filter((n) => !(c.names ?? []).includes(n));
        });
        break;
      case "reject":
        update(c.record!, (r) => {
          r.state = "rejected";
        });
        break;
      case "restore":
        update(c.record!, (r) => {
          r.state = "active";
        });
        break;
      case "merge": {
        const [first, ...rest] = (c.records ?? []).map((id) => this.currentId(hub, id));
        for (const id of rest) update(id, () => {}, { removed: true, mergedInto: first! });
        break;
      }
      case "unmerge":
        update(
          c.record!,
          (r) => {
            delete (r as { mergedInto?: string }).mergedInto;
          },
          { removed: false, mergedInto: null },
        );
        break;
      default:
        break;
    }
  }

  private renameCopy(hub: Hub, localId: string, record: string): void {
    const row = this.copyRow(hub, localId);
    if (!row) return;
    const existing = this.copyRow(hub, record);
    const r = JSON.parse(row.record) as HubRecord;
    r.id = record;
    if (existing) {
      // The hub's record arrived first (the feed, or a create that repeats an earlier one): keep it, with the person's fields.
      this.db.run("DELETE FROM memex_facts_copy WHERE hub = ? AND id = ?", hub, localId);
      return;
    }
    this.db.run("UPDATE memex_facts_copy SET id = ?, record = ? WHERE hub = ? AND id = ?", record, JSON.stringify(r), hub, localId);
  }

  private rows(hub: Hub): OutboxRow[] {
    return this.db.all<OutboxRow>("SELECT * FROM memex_facts_outbox WHERE hub = ? ORDER BY created_ms, seq", hub);
  }

  private item(r: OutboxRow): OutboxItem {
    const refused = r.refused ? (JSON.parse(r.refused) as { code: string; message: string; field?: string }) : undefined;
    return {
      hub: r.hub,
      correction: JSON.parse(r.correction),
      ...(r.local_id ? { localId: r.local_id } : {}),
      ...(refused ? { refused: { ...refused, appVersion: r.refused_version ?? "", cleared: r.mark_cleared === 1 } } : {}),
      attempts: r.attempts,
      savedAt: r.saved_at,
    };
  }

  private copyRow(hub: Hub, id: string): CopyRow | undefined {
    return this.db.get<CopyRow>("SELECT * FROM memex_facts_copy WHERE hub = ? AND id = ?", hub, id);
  }

  private local(r: CopyRow): LocalRecord {
    return {
      hub: r.hub,
      id: r.id,
      kind: r.kind,
      version: r.version,
      state: r.state,
      removed: r.removed === 1,
      ...(r.merged_into ? { mergedInto: r.merged_into } : {}),
      record: JSON.parse(r.record),
    };
  }
}

function isListEdit(v: unknown): v is { add?: unknown[]; remove?: unknown[] } {
  return typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length > 0 && Object.keys(v).every((k) => k === "add" || k === "remove");
}

/** A list edit over the local list: removed elements go, added ones join when they are not there. Elements compare by JSON. */
function editList(current: unknown, edit: { add?: unknown[]; remove?: unknown[] }): unknown[] {
  const key = (v: unknown) => JSON.stringify(v);
  const removed = new Set((edit.remove ?? []).map(key));
  const out = (Array.isArray(current) ? current : []).filter((v) => !removed.has(key(v)));
  for (const v of edit.add ?? []) if (!out.some((x) => key(x) === key(v))) out.push(structuredClone(v));
  return out;
}
