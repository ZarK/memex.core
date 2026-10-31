import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { assertSchemaMatches, migrate, openDatabase } from '@tjalve/memex-sqlite';
import { nodeSqlite } from '@tjalve/memex-sqlite/node-sqlite';
import {
  migrateCore,
  CORE_MIGRATIONS_DIR,
  createEntity,
  getEntity,
  softDeleteEntity,
  link,
  recordProvenance,
  findEntityByProvenance,
  listProvenanceByBatch,
  factId,
  writeFacts,
  getFact,
  factSources,
  factsBySource,
  resolveFact,
  addCorrection,
  newCorrectionId,
  applyListEdits,
  listCorrections,
  exportCorrections,
  importCorrections,
  CorrectionError,
  type FactInput,
} from '../src/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTRACTS = join(HERE, '..', '..', '..', 'contracts');
const FIXTURES = join(CONTRACTS, 'fixtures', 'schema');

function open() {
  return openDatabase(':memory:', { driver: nodeSqlite, idleCheckpointMs: 0 });
}

function freshDb() {
  const db = open();
  migrateCore(db);
  return db;
}

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf-8')) as T;
}

function fixtureText(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf-8').replace(/\r\n/g, '\n');
}

// What an app makes when the person acts: an id and the time of the edit.
let clock = Date.parse('2026-11-18T10:00:00.000Z');
function stamp() {
  clock += 1000;
  return { id: newCorrectionId(), createdAt: new Date(clock).toISOString() };
}

const tripFacts = fixture<{ scope: string; facts: FactInput[] }>('facts.json');

describe('migrations', () => {
  it('applies the core migrations once and is idempotent', () => {
    const db = open();
    const first = migrateCore(db);
    expect(first.applied).toEqual(['0001_entity_spine.sql', '0002_derived_facts.sql']);
    const second = migrateCore(db);
    expect(second.applied).toEqual([]);
    assertSchemaMatches(db, (reference) => migrate(reference, 'core', CORE_MIGRATIONS_DIR));
  });

  it('bundled migration 0001 matches the canonical contract DDL', () => {
    const contract = readFileSync(join(CONTRACTS, 'entity-schema.sql'), 'utf-8');
    const migration = readFileSync(join(CORE_MIGRATIONS_DIR, '0001_entity_spine.sql'), 'utf-8');
    expect(migration).toBe(contract);
  });

  it('upgrades a 0.1 database and keeps its rows', () => {
    const db = open();
    // What @memex/schema 0.1 left: schema_migrations without a checksum column.
    db.exec(`CREATE TABLE schema_migrations (
      scope TEXT NOT NULL,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      PRIMARY KEY (scope, name))`);
    db.exec(readFileSync(join(CORE_MIGRATIONS_DIR, '0001_entity_spine.sql'), 'utf-8'));
    db.run("INSERT INTO schema_migrations (scope, name) VALUES ('core', '0001_entity_spine.sql')");
    const id = createEntity(db, 'finance.transaction');
    db.run(
      "INSERT INTO provenance (id, entity_id, source, content_hash) VALUES ('p1', ?, 'import:csv:x', 'h1')",
      id,
    );
    expect(migrateCore(db).applied).toEqual(['0002_derived_facts.sql']);
    const row = db.get<Record<string, unknown>>("SELECT * FROM provenance WHERE id = 'p1'");
    expect(row).toMatchObject({ entity_id: id, batch_id: null, file_hash: null, reader: null });
  });

  it('refuses to upgrade a database with two provenance rows for one (source, content_hash)', () => {
    const db = open();
    migrate(db, 'core', [
      { name: '0001_entity_spine.sql', sql: readFileSync(join(CORE_MIGRATIONS_DIR, '0001_entity_spine.sql'), 'utf-8') },
    ]);
    const a = createEntity(db, 'finance.transaction');
    const b = createEntity(db, 'finance.transaction');
    db.run("INSERT INTO provenance (id, entity_id, source, content_hash) VALUES ('p1', ?, 's:x', 'h')", a);
    db.run("INSERT INTO provenance (id, entity_id, source, content_hash) VALUES ('p2', ?, 's:x', 'h')", b);
    expect(() => migrateCore(db)).toThrow(/UNIQUE/);
    // The failed migration rolled back: still on 0001, both rows kept.
    expect(db.all("SELECT name FROM schema_migrations WHERE scope = 'core'")).toHaveLength(1);
    expect(db.all('SELECT id FROM provenance')).toHaveLength(2);
  });
});

describe('entity helpers', () => {
  it('creates and reads an entity', () => {
    const db = freshDb();
    const id = createEntity(db, 'finance.account');
    const row = getEntity(db, id);
    expect(row?.type).toBe('finance.account');
    expect(row?.deleted_at).toBeNull();
    expect(row?.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('soft-deletes without removing the row', () => {
    const db = freshDb();
    const id = createEntity(db, 'finance.account');
    softDeleteEntity(db, id);
    expect(getEntity(db, id)?.deleted_at).not.toBeNull();
  });

  it('link is idempotent per (from, to, type)', () => {
    const db = freshDb();
    const a = createEntity(db, 'finance.transaction');
    const b = createEntity(db, 'finance.category');
    link(db, a, b, 'categorized_as');
    link(db, a, b, 'categorized_as');
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM relationship WHERE from_id = ?', a)?.n).toBe(1);
  });

  it('enforces foreign keys on relationships', () => {
    const db = freshDb();
    expect(() => link(db, 'nope', 'also-nope', 'x')).toThrow();
  });
});

describe('provenance v2', () => {
  it('finds an entity by (source, content_hash)', () => {
    const db = freshDb();
    const id = createEntity(db, 'finance.transaction');
    recordProvenance(db, {
      entityId: id,
      source: 'import:csv:sparebank1',
      sourceRef: 'statement-2010-01.csv',
      contentHash: 'abc123',
    });
    expect(findEntityByProvenance(db, 'import:csv:sparebank1', 'abc123')).toBe(id);
    expect(findEntityByProvenance(db, 'import:csv:sparebank1', 'missing')).toBeUndefined();
    expect(findEntityByProvenance(db, 'connector:actual', 'abc123')).toBeUndefined();
  });

  it('refuses a second row for one (source, content_hash) and allows rows without a hash', () => {
    const db = freshDb();
    const a = createEntity(db, 'finance.transaction');
    const b = createEntity(db, 'finance.transaction');
    recordProvenance(db, { entityId: a, source: 'import:csv:x', contentHash: 'h' });
    expect(() => recordProvenance(db, { entityId: b, source: 'import:csv:x', contentHash: 'h' })).toThrow(/UNIQUE/);
    recordProvenance(db, { entityId: b, source: 'import:csv:y', contentHash: 'h' });
    recordProvenance(db, { entityId: a, source: 'import:csv:x' });
    recordProvenance(db, { entityId: b, source: 'import:csv:x' });
  });

  it('keeps batch_id, file_hash and reader, and lists the rows of a batch', () => {
    const db = freshDb();
    const rows = fixture<Record<string, string | null>[]>('provenance-v2.json');
    for (const row of rows) {
      createEntity(db, 'finance.transaction', row.entity_id!);
      expect(row.content_hash).toMatch(/^[0-9a-f]{64}$/);
      if (row.file_hash !== null) expect(row.file_hash).toMatch(/^[0-9a-f]{64}$/);
      recordProvenance(db, {
        entityId: row.entity_id!,
        source: row.source!,
        sourceRef: row.source_ref ?? undefined,
        contentHash: row.content_hash ?? undefined,
        batchId: row.batch_id ?? undefined,
        fileHash: row.file_hash ?? undefined,
        reader: row.reader ?? undefined,
      });
    }
    const batch = listProvenanceByBatch(db, rows[0]!.batch_id!);
    expect(batch).toHaveLength(1);
    expect(batch[0]).toMatchObject({
      entity_id: rows[0]!.entity_id,
      file_hash: rows[0]!.file_hash,
      reader: rows[0]!.reader,
    });
    expect(Object.keys(batch[0]!).sort()).toEqual(Object.keys(rows[0]!).sort());
  });
});

describe('derived facts', () => {
  it('gives every (kind, scope, key) the id in fact-ids.json', () => {
    for (const v of fixture<{ kind: string; scope: string; key: string; id: string }[]>('fact-ids.json')) {
      expect(factId(v.kind, v.scope, v.key)).toBe(v.id);
    }
  });

  it('writes facts with their sources and counts the changes', () => {
    const db = freshDb();
    const first = writeFacts(db, tripFacts.scope, tripFacts.facts);
    expect(first).toMatchObject({ created: 4, updated: 0, unchanged: 0, withdrawn: 0 });
    const lisbon = first.ids[0]!;
    expect(getFact(db, lisbon)).toMatchObject({ kind: 'trip', scope: 'photos.trips', state: 'active', confidence: 0.92 });
    expect(factSources(db, lisbon)).toEqual([{ app: 'photos', kind: 'trip', id: 'trip_lisbon_2025' }]);
    expect(factsBySource(db, { app: 'photos', kind: 'trip', id: 'trip_lisbon_2025' })).toEqual([lisbon]);

    const again = writeFacts(db, tripFacts.scope, tripFacts.facts);
    expect(again).toMatchObject({ created: 0, updated: 0, unchanged: 4, withdrawn: 0 });

    const changed = tripFacts.facts.map((f, i) => (i === 0 ? { ...f, confidence: 0.95 } : f));
    expect(writeFacts(db, tripFacts.scope, changed)).toMatchObject({ updated: 1, unchanged: 3 });
  });

  it('withdraws facts that the producer no longer infers and brings them back with the same id', () => {
    const db = freshDb();
    const { ids } = writeFacts(db, tripFacts.scope, tripFacts.facts);
    const lisbonFeb = ids[2]!;
    const without = writeFacts(db, tripFacts.scope, tripFacts.facts.filter((f) => f.key !== 'trip_lisbon_2025_feb'));
    expect(without).toMatchObject({ withdrawn: 1, unchanged: 3 });
    expect(getFact(db, lisbonFeb)?.state).toBe('withdrawn');
    const back = writeFacts(db, tripFacts.scope, tripFacts.facts);
    expect(back).toMatchObject({ updated: 1, unchanged: 3 });
    expect(getFact(db, lisbonFeb)?.state).toBe('active');
  });

  it('replaces only the given partition', () => {
    const db = freshDb();
    const stay = (key: string): FactInput => ({ key, kind: 'stay', confidence: 0.8, method: 'rule:stays/1', fields: { key } });
    writeFacts(db, 'photos.stays', [stay('a'), stay('b')], { partition: '2024' });
    writeFacts(db, 'photos.stays', [stay('c')], { partition: '2025' });
    const result = writeFacts(db, 'photos.stays', [stay('a')], { partition: '2024' });
    expect(result).toMatchObject({ unchanged: 1, withdrawn: 1 });
    expect(getFact(db, factId('stay', 'photos.stays', 'c'))?.state).toBe('active');
  });

  it('links facts to entities in this database', () => {
    const db = freshDb();
    const txn = createEntity(db, 'finance.transaction');
    const { ids } = writeFacts(db, 'finance.categories', [
      {
        key: `txn:${txn}`,
        kind: 'finance.category',
        confidence: 0.7,
        method: 'merchant-memory/1',
        entityId: txn,
        fields: { category: 'groceries' },
        sources: [{ entity: txn }, { entity: txn }],
      },
    ]);
    expect(factSources(db, ids[0]!)).toEqual([{ entity: txn }]);
    expect(factsBySource(db, { entity: txn })).toEqual(ids);
    expect(() =>
      writeFacts(db, 'finance.categories', [
        { key: 'x', kind: 'finance.category', confidence: 0.7, method: 'm', fields: {}, sources: [{ entity: 'missing' }] },
      ]),
    ).toThrow();
  });

  it('refuses bad input and rolls back the whole write', () => {
    const db = freshDb();
    const ok = tripFacts.facts[0]!;
    expect(() => writeFacts(db, 'trips', [ok])).toThrow(/scope/);
    expect(() => writeFacts(db, tripFacts.scope, [ok, { ...ok, confidence: 1.5 }])).toThrow(/confidence/);
    expect(() => writeFacts(db, tripFacts.scope, [ok, ok])).toThrow(/twice/);
    expect(() => writeFacts(db, tripFacts.scope, [{ ...ok, kind: 'bad_kind' }])).toThrow(/kind/);
    expect(db.all('SELECT id FROM fact')).toHaveLength(0);
  });
});

describe('corrections', () => {
  it('resolves the fixture facts with the fixture corrections', () => {
    const db = freshDb();
    writeFacts(db, tripFacts.scope, tripFacts.facts);
    expect(importCorrections(db, fixtureText('corrections.jsonl'))).toEqual({ added: 6, unchanged: 0 });
    const expected = fixture<{ id: string }[]>('resolved.json');
    for (const fact of expected) expect(resolveFact(db, fact.id)).toEqual(fact);
    expect(resolveFact(db, 'trip_00000000000000000000000000000000')).toBeUndefined();
  });

  it('survive re-inference: a withdrawn and returning fact gets its corrections again', () => {
    const db = freshDb();
    const { ids } = writeFacts(db, tripFacts.scope, tripFacts.facts);
    const lisbon = ids[0]!;
    addCorrection(db, { ...stamp(), op: 'set', app: 'photos', record: lisbon, fields: { title: 'Lisbon with Sam' } });

    writeFacts(db, tripFacts.scope, []);
    expect(resolveFact(db, lisbon)).toMatchObject({ state: 'withdrawn', fields: { title: 'Lisbon with Sam' } });

    const renamed = tripFacts.facts.map((f) => ({ ...f, fields: { ...f.fields, title: 'Lisboa' } }));
    writeFacts(db, tripFacts.scope, renamed);
    expect(resolveFact(db, lisbon)).toMatchObject({ state: 'active', fields: { title: 'Lisbon with Sam' }, corrected: ['title'] });
    expect(listCorrections(db, lisbon)).toHaveLength(1);
  });

  it('export and import carry corrections to a new database, where re-inference finds them', () => {
    const db = freshDb();
    writeFacts(db, tripFacts.scope, tripFacts.facts);
    importCorrections(db, fixtureText('corrections.jsonl'));
    const jsonl = exportCorrections(db);
    expect(jsonl).toBe(fixtureText('corrections.jsonl'));

    const fresh = freshDb();
    expect(importCorrections(fresh, jsonl)).toEqual({ added: 6, unchanged: 0 });
    expect(importCorrections(fresh, jsonl)).toEqual({ added: 0, unchanged: 6 });
    // The milestone that the user made exists before any inference.
    expect(resolveFact(fresh, 'milestone_5d1e0c7a9b3f4e2d8c6a1b0f9e8d7c6b')?.origin).toBe('user');
    writeFacts(fresh, tripFacts.scope, tripFacts.facts);
    for (const fact of fixture<{ id: string }[]>('resolved.json')) {
      expect(resolveFact(fresh, fact.id)).toEqual(resolveFact(db, fact.id));
    }
    expect(exportCorrections(fresh)).toBe(jsonl);
  });

  it('addCorrection keeps the id and time that the app made, and makes the id of a created fact', () => {
    const db = freshDb();
    const id = 'cor_3f6a0c1e9b2d4a7f8e5c1b0d9a8f7e99';
    const c = addCorrection(db, { id, createdAt: '2026-11-18T10:00:00Z', op: 'create', app: 'workspace', kind: 'milestone', fields: { title: 'Car loan paid off', date: '2024-06' } });
    expect(c.id).toBe(id);
    expect(c.record).toMatch(/^milestone_[0-9a-f]{32}$/);
    expect(c.createdAt).toBe('2026-11-18T10:00:00.000Z');
    expect(listCorrections(db)).toEqual([c]);
    expect(resolveFact(db, c.record!)).toMatchObject({ origin: 'user', confidence: 1, state: 'active' });
    const merge = addCorrection(db, { ...stamp(), op: 'merge', app: 'photos', records: [c.record!, 'milestone_0123456789abcdef0123456789abcdef'] });
    expect(merge.record).toBeUndefined();
    expect(listCorrections(db, c.record!)).toEqual([c, merge]);
    expect(newCorrectionId()).toMatch(/^cor_[0-9a-f]{32}$/);
  });

  it('addCorrection stores an id once: a repeat returns the stored correction, other content is refused', () => {
    const db = freshDb();
    const record = 'trip_0451f6f8dcec05dfbabdd9f2b737f179';
    const input = { id: 'cor_0a0b0c0d0e0f40418a1b2c3d4e5f6a7b', createdAt: '2026-11-18T10:00:00Z', op: 'set' as const, app: 'photos', record, fields: { title: 'Lisbon' } };
    const first = addCorrection(db, input);
    expect(addCorrection(db, input)).toEqual(first);
    expect(listCorrections(db)).toHaveLength(1);
    expect(() => addCorrection(db, { ...input, fields: { title: 'Porto' } })).toThrow(/already stored with other content/);
    // A create without a record id is a repeat by its id: the record id of the first send comes back.
    const create = { id: 'cor_1a1b1c1d1e1f40418a1b2c3d4e5f6a7b', createdAt: '2026-11-18T10:01:00Z', op: 'create' as const, app: 'photos', kind: 'home', fields: { name: 'Nordnes' } };
    const made = addCorrection(db, create);
    expect(addCorrection(db, create)).toEqual(made);
  });

  it('orders corrections by createdAt, not by the order of the sends', () => {
    const db = freshDb();
    const record = 'trip_0451f6f8dcec05dfbabdd9f2b737f179';
    addCorrection(db, { id: 'cor_2a2b2c2d2e2f40418a1b2c3d4e5f6a7b', createdAt: '2026-11-18T10:05:00Z', op: 'set', app: 'photos', record, fields: { title: 'Later' } });
    addCorrection(db, { id: 'cor_3a3b3c3d3e3f40418a1b2c3d4e5f6a7b', createdAt: '2026-11-18T10:00:00Z', op: 'set', app: 'photos', record, fields: { title: 'Earlier' } });
    expect(listCorrections(db, record).map((c) => c.fields!.title)).toEqual(['Earlier', 'Later']);
  });

  it('applies list edits: removed elements stay out after re-inference, new inferred elements come in', () => {
    const db = freshDb();
    const scope = 'photos.trips';
    const sam = { app: 'contacts', kind: 'person', id: 'ct_sam' };
    const kim = { app: 'contacts', kind: 'person', id: 'ct_kim' };
    const lee = { app: 'contacts', kind: 'person', id: 'ct_lee' };
    const base = { key: 'trip-1', kind: 'trip', confidence: 0.9, method: 'rule:trip-nearness/2' };
    const [id] = writeFacts(db, scope, [{ ...base, fields: { title: 'Lisbon', participants: [sam] } }]).ids;
    addCorrection(db, { ...stamp(), op: 'set', app: 'photos', record: id!, fields: { participants: { add: [kim], remove: [sam] } } });
    expect(resolveFact(db, id!)?.fields.participants).toEqual([kim]);
    expect(resolveFact(db, id!)?.corrected).toEqual(['participants']);
    writeFacts(db, scope, [{ ...base, fields: { title: 'Lisbon', participants: [sam, lee] } }]);
    expect(resolveFact(db, id!)?.fields.participants).toEqual([lee, kim]);
    // A full list replaces the edits; a clear gives the list back to inference.
    addCorrection(db, { ...stamp(), op: 'set', app: 'photos', record: id!, fields: { participants: [sam] } });
    expect(resolveFact(db, id!)?.fields.participants).toEqual([sam]);
    addCorrection(db, { ...stamp(), op: 'clear', app: 'photos', record: id!, names: ['participants'] });
    expect(resolveFact(db, id!)?.fields.participants).toEqual([sam, lee]);
    expect(applyListEdits(undefined, [{ add: [1] }, { remove: [1], add: [2] }])).toEqual([2]);
  });

  it('compares list elements by JSON value, whatever the order of their properties', () => {
    const resident = { person: 'person_bb472edb86809a761936d90c70aeb434', from: '2019-08', child: false };
    const sameResident = { child: false, from: '2019-08', person: 'person_bb472edb86809a761936d90c70aeb434' };
    expect(applyListEdits([resident], [{ remove: [sameResident] }])).toEqual([]);
    expect(applyListEdits([resident], [{ add: [sameResident] }])).toEqual([resident]);
  });

  it('keeps a record that the user made when no producer infers it, with set and reject on it', () => {
    const db = freshDb();
    const home = addCorrection(db, { ...stamp(), op: 'create', app: 'photos', kind: 'home', fields: { name: 'Nordnes', from: '2019-08' } });
    const work = addCorrection(db, { ...stamp(), op: 'create', app: 'photos', kind: 'workplace', fields: { name: 'Harbour office' } });
    // A new library sends an empty list before it reads the records back: the records stay.
    writeFacts(db, 'photos.homes', []);
    writeFacts(db, 'photos.workplaces', []);
    expect(resolveFact(db, home.record!)).toMatchObject({ origin: 'user', state: 'active', scope: null, fields: { name: 'Nordnes' } });

    addCorrection(db, { ...stamp(), op: 'set', app: 'photos', record: home.record!, fields: { to: '2023-05' } });
    addCorrection(db, { ...stamp(), op: 'reject', app: 'photos', record: work.record! });
    expect(resolveFact(db, home.record!)).toMatchObject({ state: 'active', fields: { name: 'Nordnes', from: '2019-08', to: '2023-05' } });
    expect(resolveFact(db, work.record!)?.state).toBe('rejected');

    // Sent again, for example on a second first run: refused, so the later set stays.
    expect(() => addCorrection(db, { ...stamp(), op: 'create', app: 'photos', kind: 'home', record: home.record!, fields: { name: 'Nordnes' } })).toThrow(
      /already created/,
    );
    expect(resolveFact(db, home.record!)?.fields.to).toBe('2023-05');
    // An inferred fact does not become a record that the user made.
    const { ids } = writeFacts(db, tripFacts.scope, tripFacts.facts);
    expect(() => addCorrection(db, { ...stamp(), op: 'create', app: 'photos', kind: 'trip', record: ids[0]!, fields: { title: 'x' } })).toThrow(
      /is an inferred fact/,
    );
    // The import refuses a second create with the line number and writes nothing.
    const again = JSON.stringify({ id: 'cor_0123456789abcdef0123456789abcdef', op: 'create', app: 'photos', record: home.record, kind: 'home', fields: { name: 'x' }, createdAt: '2026-11-18T10:00:00.000Z' });
    const before = exportCorrections(db);
    expect(() => importCorrections(db, exportCorrections(db) + again + '\n')).toThrow(/Line 5: the record .* is already created/);
    expect(exportCorrections(db)).toBe(before);
  });

  it('checks fields in their JSON form, so that every stored correction exports and imports again', () => {
    const db = freshDb();
    const record = 'trip_0451f6f8dcec05dfbabdd9f2b737f179';
    expect(() => addCorrection(db, { ...stamp(), op: 'set', app: 'photos', record, fields: { note: undefined } })).toThrow(
      /set needs fields with at least one field/,
    );
    expect(() => addCorrection(db, { ...stamp(), op: 'create', app: 'workspace', kind: 'milestone', fields: { title: undefined } })).toThrow(
      /create needs fields with at least one field/,
    );
    const c = addCorrection(db, { ...stamp(), op: 'set', app: 'photos', record, fields: { title: 'Lisbon', note: undefined } });
    expect(c.fields).toEqual({ title: 'Lisbon' });
    expect(Object.keys(c.fields!)).toEqual(['title']);
    expect(listCorrections(db)).toEqual([c]);
    const text = exportCorrections(db);
    expect(importCorrections(db, text)).toEqual({ added: 0, unchanged: 1 });
    expect(importCorrections(freshDb(), text)).toEqual({ added: 1, unchanged: 0 });
  });

  it('refuses invalid lines with the line number and writes nothing', () => {
    const db = freshDb();
    const good = fixtureText('corrections.jsonl').split('\n')[0]!;
    const cases: [string, RegExp][] = [
      ['{not json', /Line 2: not valid JSON/],
      ['{"id":"cor_1","op":"reject","app":"photos","record":"trip_0451f6f8dcec05dfbabdd9f2b737f179","createdAt":"2026-11-18T10:00:00Z"}', /Line 2: invalid id/],
      ['{"id":"cor_3f6a0c1e9b2d4a7f8e5c1b0d9a8f7e70","op":"drop","app":"photos","record":"trip_0451f6f8dcec05dfbabdd9f2b737f179","createdAt":"2026-11-18T10:00:00Z"}', /invalid op/],
      ['{"id":"cor_3f6a0c1e9b2d4a7f8e5c1b0d9a8f7e70","op":"set","app":"photos","record":"trip_0451f6f8dcec05dfbabdd9f2b737f179","fields":{},"createdAt":"2026-11-18T10:00:00Z"}', /at least one field/],
      ['{"id":"cor_3f6a0c1e9b2d4a7f8e5c1b0d9a8f7e70","op":"reject","app":"photos","record":"trip_0451f6f8dcec05dfbabdd9f2b737f179","names":["x"],"createdAt":"2026-11-18T10:00:00Z"}', /reject has no 'names'/],
      ['{"id":"cor_3f6a0c1e9b2d4a7f8e5c1b0d9a8f7e70","op":"merge","app":"photos","records":["trip_0451f6f8dcec05dfbabdd9f2b737f179"],"createdAt":"2026-11-18T10:00:00Z"}', /two or more/],
      ['{"id":"cor_3f6a0c1e9b2d4a7f8e5c1b0d9a8f7e70","op":"create","app":"photos","record":"trip_0451f6f8dcec05dfbabdd9f2b737f179","kind":"milestone","fields":{"title":"x"},"createdAt":"2026-11-18T10:00:00Z"}', /must start with 'milestone_'/],
      ['{"id":"cor_3f6a0c1e9b2d4a7f8e5c1b0d9a8f7e70","op":"restore","app":"photos","record":"trip_0451f6f8dcec05dfbabdd9f2b737f179","createdAt":"yesterday"}', /UTC time/],
      ['{"id":"cor_3f6a0c1e9b2d4a7f8e5c1b0d9a8f7e70","op":"restore","app":"photos","record":"trip_0451f6f8dcec05dfbabdd9f2b737f179","extra":1,"createdAt":"2026-11-18T10:00:00Z"}', /unknown property 'extra'/],
    ];
    for (const [line, message] of cases) {
      expect(() => importCorrections(db, `${good}\n${line}\n`)).toThrow(message);
    }
    expect(() => importCorrections(db, `${good}\n{`)).toThrow(CorrectionError);
    expect(listCorrections(db)).toEqual([]);
  });

  it('refuses a stored id with other content', () => {
    const db = freshDb();
    const good = fixtureText('corrections.jsonl').split('\n')[0]!;
    importCorrections(db, good);
    expect(() => importCorrections(db, good.replace('Lisbon with Sam', 'Lisbon'))).toThrow(/other content/);
  });

  it('normalizes times to milliseconds, so that a line without them round-trips to the export form', () => {
    const db = freshDb();
    importCorrections(
      db,
      '{"id":"cor_3f6a0c1e9b2d4a7f8e5c1b0d9a8f7e70","op":"reject","app":"photos","record":"trip_0451f6f8dcec05dfbabdd9f2b737f179","createdAt":"2026-11-18T10:00:00Z"}\r\n',
    );
    expect(exportCorrections(db)).toContain('"createdAt":"2026-11-18T10:00:00.000Z"');
  });
});
