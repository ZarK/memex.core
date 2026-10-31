import { createHash } from 'node:crypto';
import type { SqliteDatabase } from '@tjalve/memex-sqlite';
import { listCorrections } from './corrections.js';
import { isListEdit, type ListEdit } from './records.js';
import type { FactRow, FactSourceRow } from './types.js';

/** '<app>.<kinds>', for example 'photos.trips' or 'finance.categories'. */
export const SCOPE_PATTERN = /^[a-z][a-z0-9]*\.[a-z][a-z0-9.-]*$/;
/** A fact kind, for example 'trip' or 'finance.category'. It has no underscore. */
export const KIND_PATTERN = /^[a-z][a-z0-9.-]*$/;
/** '<kind>_<32 hex>'. */
export const FACT_ID_PATTERN = /^[a-z][a-z0-9.-]*_[0-9a-f]{32}$/;

/** A record that a fact comes from: an entity in this database, or a record in another app. */
export type FactSource = { entity: string } | { app: string; kind: string; id: string };

export interface FactInput {
  /** The producer's own stable id for the fact. It stays the same while the producer infers the same fact. */
  key: string;
  kind: string;
  /** The fact. A JSON object. */
  fields: Record<string, unknown>;
  /** 0 to 1. */
  confidence: number;
  /** The rule or model and its version, for example 'rule:trip-nearness/2'. */
  method: string;
  /** The entity in this database that the fact is about, if any. */
  entityId?: string;
  sources?: FactSource[];
}

export interface WriteFactsOptions {
  /** Replace only the facts of this partition of the scope, for example a year. */
  partition?: string;
}

export interface WriteFactsResult {
  created: number;
  updated: number;
  unchanged: number;
  withdrawn: number;
  /** The fact id of each input, in input order. */
  ids: string[];
}

export interface ResolvedFact {
  id: string;
  kind: string;
  /** null for a fact that the user made. */
  scope: string | null;
  key: string | null;
  /** rejected: the user said that the fact is wrong. withdrawn: its producer no longer infers it. */
  state: 'active' | 'withdrawn' | 'rejected';
  origin: 'inferred' | 'user';
  confidence: number;
  /** The inferred fields with the user's fields over them. */
  fields: Record<string, unknown>;
  /** The names of the fields that the user set, sorted. */
  corrected: string[];
}

/**
 * The stable id of the fact that a producer infers: '<kind>_' and the first 32
 * hex digits of the SHA-256 of '<scope>\n<key>' (UTF-8). The same input gives
 * the same id in every database, so corrections apply again after re-inference
 * and after an import into a new database.
 */
export function factId(kind: string, scope: string, key: string): string {
  if (!KIND_PATTERN.test(kind)) throw new Error(`Invalid fact kind '${kind}'.`);
  const hash = createHash('sha256').update(`${scope}\n${key}`, 'utf8').digest('hex');
  return `${kind}_${hash.slice(0, 32)}`;
}

/**
 * Replace the facts of a producer scope (or of one partition of it) with the
 * facts it infers now, in one transaction. A fact that is not in the list is
 * withdrawn, not deleted, and comes back with the same id. Corrections are
 * never touched.
 */
export function writeFacts(
  db: SqliteDatabase,
  scope: string,
  facts: readonly FactInput[],
  options: WriteFactsOptions = {},
): WriteFactsResult {
  if (!SCOPE_PATTERN.test(scope)) throw new Error(`Invalid fact scope '${scope}'.`);
  const partition = options.partition ?? null;
  return db.transaction(() => {
    const result: WriteFactsResult = { created: 0, updated: 0, unchanged: 0, withdrawn: 0, ids: [] };
    const seen = new Set<string>();
    for (const input of facts) {
      checkFact(input);
      const id = factId(input.kind, scope, input.key);
      if (seen.has(id)) throw new Error(`The fact '${input.key}' of kind '${input.kind}' is in the list twice.`);
      seen.add(id);
      result.ids.push(id);
      const fields = JSON.stringify(input.fields);
      const entityId = input.entityId ?? null;
      const sources = [...new Set((input.sources ?? []).map(sourceKey))].sort();
      const row = db.get<FactRow>('SELECT * FROM fact WHERE id = ?', id);
      if (!row) {
        db.run(
          `INSERT INTO fact (id, kind, scope, key, partition, entity_id, fields, confidence, method)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id, input.kind, scope, input.key, partition, entityId, fields, input.confidence, input.method,
        );
        insertSources(db, id, sources);
        result.created += 1;
        continue;
      }
      if (row.scope !== scope || row.key !== input.key) {
        throw new Error(`The fact id ${id} belongs to '${row.scope}' '${row.key}'.`);
      }
      const same =
        row.state === 'active' &&
        row.partition === partition &&
        row.entity_id === entityId &&
        row.fields === fields &&
        row.confidence === input.confidence &&
        row.method === input.method &&
        sameList(factSources(db, id).map(sourceKey).sort(), sources);
      if (same) {
        result.unchanged += 1;
        continue;
      }
      db.run(
        `UPDATE fact SET partition = ?, entity_id = ?, fields = ?, confidence = ?, method = ?, state = 'active',
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?`,
        partition, entityId, fields, input.confidence, input.method, id,
      );
      db.run('DELETE FROM fact_source WHERE fact_id = ?', id);
      insertSources(db, id, sources);
      result.updated += 1;
    }
    const active = db.all<{ id: string }>(
      "SELECT id FROM fact WHERE scope = ? AND partition IS ? AND state = 'active'",
      scope,
      partition,
    );
    for (const { id } of active) {
      if (seen.has(id)) continue;
      db.run(
        "UPDATE fact SET state = 'withdrawn', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
        id,
      );
      result.withdrawn += 1;
    }
    return result;
  });
}

export function getFact(db: SqliteDatabase, id: string): FactRow | undefined {
  return db.get<FactRow>('SELECT * FROM fact WHERE id = ?', id);
}

/** The records that a fact comes from. */
export function factSources(db: SqliteDatabase, id: string): FactSource[] {
  return db
    .all<FactSourceRow>('SELECT * FROM fact_source WHERE fact_id = ? ORDER BY rowid', id)
    .map((row) =>
      row.entity_id !== null
        ? { entity: row.entity_id }
        : { app: row.app!, kind: row.kind!, id: row.ref_id! },
    );
}

/** The ids of the facts that come from a record, for example to infer again after the record changed. */
export function factsBySource(db: SqliteDatabase, source: FactSource): string[] {
  const rows =
    'entity' in source
      ? db.all<{ fact_id: string }>(
          'SELECT fact_id FROM fact_source WHERE entity_id = ? ORDER BY fact_id',
          source.entity,
        )
      : db.all<{ fact_id: string }>(
          'SELECT fact_id FROM fact_source WHERE app = ? AND kind = ? AND ref_id = ? ORDER BY fact_id',
          source.app,
          source.kind,
          source.id,
        );
  return rows.map((row) => row.fact_id);
}

/**
 * A fact as the user sees it: the inferred fact with the corrections applied in
 * order. set and clear change fields, reject and restore change the state,
 * create makes a fact that the user owns. A set whose value for a field is a
 * list edit ({add, remove}) edits the list instead of replacing it: removed
 * elements stay out also when the producer infers them again, and new inferred
 * elements still come in. merge is left to the caller. Returns undefined when
 * there is no fact and no create correction for the id.
 */
export function resolveFact(db: SqliteDatabase, id: string): ResolvedFact | undefined {
  const row = getFact(db, id);
  let kind = row?.kind;
  let origin: ResolvedFact['origin'] = 'inferred';
  let rejected = false;
  const user = new Map<string, unknown>();
  const edits = new Map<string, ListEdit[]>();
  const setField = (name: string, value: unknown) => {
    if (isListEdit(value)) edits.set(name, [...(edits.get(name) ?? []), value]);
    else {
      user.set(name, value);
      edits.delete(name);
    }
  };
  for (const c of listCorrections(db, id)) {
    if (c.op === 'set') for (const [name, value] of Object.entries(c.fields!)) setField(name, value);
    else if (c.op === 'clear') {
      for (const name of c.names!) {
        user.delete(name);
        edits.delete(name);
      }
    } else if (c.op === 'reject') rejected = true;
    else if (c.op === 'restore') rejected = false;
    else if (c.op === 'create') {
      origin = 'user';
      kind = c.kind!;
      for (const [name, value] of Object.entries(c.fields!)) setField(name, value);
    }
  }
  if (kind === undefined) return undefined;
  const inferred = row && origin === 'inferred' ? (JSON.parse(row.fields) as Record<string, unknown>) : {};
  const fields: Record<string, unknown> = { ...inferred, ...Object.fromEntries(user) };
  for (const [name, list] of edits) fields[name] = applyListEdits(fields[name], list);
  return {
    id,
    kind,
    scope: origin === 'inferred' ? row!.scope : null,
    key: origin === 'inferred' ? row!.key : null,
    state: rejected ? 'rejected' : origin === 'user' ? 'active' : row!.state,
    origin,
    confidence: origin === 'user' ? 1 : row!.confidence,
    fields,
    corrected: [...new Set([...user.keys(), ...edits.keys()])].sort(),
  };
}

/**
 * Apply list edits in order. Elements compare by their JSON value: the order of
 * the properties of an object does not matter.
 */
export function applyListEdits(base: unknown, edits: readonly ListEdit[]): unknown[] {
  let list = Array.isArray(base) ? [...base] : [];
  for (const edit of edits) {
    const removed = new Set((edit.remove ?? []).map(jsonValueKey));
    list = list.filter((x) => !removed.has(jsonValueKey(x)));
    for (const x of edit.add ?? []) {
      const key = jsonValueKey(x);
      if (!list.some((y) => jsonValueKey(y) === key)) list.push(x);
    }
  }
  return list;
}

/** The JSON form of a value with the properties of every object in sorted order. */
function jsonValueKey(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    typeof v === 'object' && v !== null && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

function checkFact(input: FactInput): void {
  if (typeof input.key !== 'string' || input.key.length < 1 || input.key.length > 200) {
    throw new Error(`A fact key must have 1 to 200 characters: '${input.key}'.`);
  }
  if (!KIND_PATTERN.test(input.kind)) throw new Error(`Invalid fact kind '${input.kind}'.`);
  if (typeof input.fields !== 'object' || input.fields === null || Array.isArray(input.fields)) {
    throw new Error(`The fields of fact '${input.key}' must be an object.`);
  }
  if (!(input.confidence >= 0 && input.confidence <= 1)) {
    throw new Error(`The confidence of fact '${input.key}' must be from 0 to 1.`);
  }
  if (typeof input.method !== 'string' || input.method.length === 0) {
    throw new Error(`Fact '${input.key}' has no method.`);
  }
}

// One string per source, so that a list can be sorted, compared, and deduplicated.
function sourceKey(source: FactSource): string {
  return 'entity' in source
    ? JSON.stringify([source.entity])
    : JSON.stringify([source.app, source.kind, source.id]);
}

function insertSources(db: SqliteDatabase, factId: string, keys: readonly string[]): void {
  for (const key of keys) {
    const parts = JSON.parse(key) as string[];
    if (parts.length === 1) {
      db.run('INSERT INTO fact_source (fact_id, entity_id) VALUES (?, ?)', factId, parts[0]!);
    } else {
      db.run(
        'INSERT INTO fact_source (fact_id, app, kind, ref_id) VALUES (?, ?, ?, ?)',
        factId, parts[0]!, parts[1]!, parts[2]!,
      );
    }
  }
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}
