// The rules of contracts/facts.md that the fixtures do not show on their own.
import { describe, expect, it } from 'vitest';
import {
  contactsHub,
  FactsError,
  openFacts,
  userHub,
  type ClaimInput,
  type Correction,
} from '../src/index.js';
import { openDatabase } from '@tjalve/memex-sqlite';
import { nodeSqlite } from '@tjalve/memex-sqlite/node-sqlite';
import { check, clock, counter, newHub } from './helpers.js';

const trip = (key: string, firstDay: string, lastDay: string, extra: Record<string, unknown> = {}, confidence = 0.9): ClaimInput => ({
  key,
  kind: 'trip',
  confidence,
  method: 'rule:test/1',
  generation: 1,
  fields: { title: key, firstDay, lastDay, countries: ['PT'], ...extra },
  sources: [{ app: 'photos', kind: 'trip', id: key }],
});
let n = 0;
const cor = (c: Omit<Correction, 'id' | 'app' | 'createdAt'> & { createdAt?: string }): Correction => {
  n += 1;
  return { id: `cor_${n.toString(16).padStart(32, '0')}`, app: 'photos', createdAt: '2026-11-20T10:00:00Z', ...c } as Correction;
};

describe('claims', () => {
  it('refuses a lower generation and accepts an equal one', () => {
    const f = newHub(userHub);
    f.writeClaims({ scope: 'photos.trips', claims: [{ ...trip('a', '2025-05-01', '2025-05-03'), generation: 5 }] });
    expect(() => f.writeClaims({ scope: 'photos.trips', claims: [{ ...trip('a', '2025-05-01', '2025-05-03'), generation: 4 }] })).toThrow(
      expect.objectContaining({ code: 'stale-generation', status: 409 }),
    );
    const again = f.writeClaims({ scope: 'photos.trips', claims: [{ ...trip('a', '2025-05-01', '2025-05-03'), generation: 5 }] });
    expect(again.changeId).toBeNull();
    expect(again.counts).toEqual({ created: 0, updated: 0, unchanged: 1, withdrawn: 0, removed: 0 });
  });

  it('refuses wrong requests whole, and partitions used sometimes', () => {
    const f = newHub(userHub);
    expect(() => f.writeClaims({ scope: 'photos.trips', claims: [{ ...trip('a', '2025-05-01', '2025-05-03'), kind: 'home' }] })).toThrow(FactsError);
    expect(() => f.writeClaims({ scope: 'photos.unknowns', claims: [] })).toThrow(/no kind/);
    expect(() =>
      f.writeClaims({ scope: 'photos.trips', claims: [trip('a', '2025-05-01', '2025-05-03'), { ...trip('b', '2025-06-01', '2025-06-03'), generation: 2 }] }),
    ).toThrow(/same generation/);
    const { title: _t, ...noTitle } = trip('a', '2025-05-01', '2025-05-03').fields;
    expect(() => f.writeClaims({ scope: 'photos.trips', claims: [{ ...trip('a', '2025-05-01', '2025-05-03'), fields: noTitle }] })).toThrow(/needs title/);
    f.writeClaims({ scope: 'photos.trips', partition: '2025', claims: [trip('a', '2025-05-01', '2025-05-03')] });
    expect(() => f.writeClaims({ scope: 'photos.trips', claims: [] })).toThrow(/partitions always or never/);
    expect(f.listRecords('trip').items).toHaveLength(1);
  });

  it('withdraws a claim, removes its record, and gives the key its record id back', () => {
    const f = newHub(userHub);
    const first = f.writeClaims({ scope: 'photos.trips', claims: [trip('a', '2025-05-01', '2025-05-03')] });
    const id = first.records[0]!.id!;
    const gone = f.writeClaims({ scope: 'photos.trips', claims: [], generation: 1 });
    expect(gone.counts).toMatchObject({ withdrawn: 1, removed: 1 });
    expect(f.getRecord(id)).toBeUndefined();
    const back = f.writeClaims({ scope: 'photos.trips', claims: [trip('a', '2025-05-01', '2025-05-03')] });
    expect(back.records[0]!.id).toBe(id);
    expect(f.getRecord(id)!.version).toBe(3);
    const ops = f.listChanges().items.map((c) => `${c.op} v${c.version}`);
    expect(ops).toEqual(['upsert v1', 'remove v2', 'upsert v3']);
  });

  it('joins a Finance and a Health trip into the Photos trip: the span covers them all, lists hold the union', () => {
    const f = newHub(userHub);
    f.writeClaims({ scope: 'photos.trips', claims: [trip('p', '2025-05-02', '2025-05-08', { participants: [{ app: 'contacts', kind: 'person', id: 'ct_sam' }] })] });
    f.writeClaims({ scope: 'finance.trips', claims: [{ ...trip('f', '2025-05-01', '2025-05-07'), confidence: 0.7, fields: { title: 'Card payments in PT', firstDay: '2025-05-01', lastDay: '2025-05-07', countries: ['PT'] } }] });
    // A weak claim confirms but does not stretch the span.
    f.writeClaims({ scope: 'health.trips', claims: [{ ...trip('h', '2025-05-04', '2025-05-10'), confidence: 0.4, fields: { title: 'Run', firstDay: '2025-05-04', lastDay: '2025-05-10', destinations: [{ name: 'Belém', town: 'Lisbon', country: 'PT' }] } }] });
    const [t] = f.listRecords('trip').items;
    expect(f.listRecords('trip').items).toHaveLength(1);
    expect(t!.fields).toMatchObject({ title: 'p', firstDay: '2025-05-01', lastDay: '2025-05-08', countries: ['PT'] });
    expect(t!.fields.destinations).toEqual([{ name: 'Belém', town: 'Lisbon', country: 'PT' }]);
    expect(t!.provenance.firstDay).toEqual([{ scope: 'finance.trips', key: 'f' }]);
    expect(t!.provenance.lastDay).toEqual([{ scope: 'photos.trips', key: 'p' }]);
    expect(t!.provenance.countries).toEqual([
      { scope: 'photos.trips', key: 'p' },
      { scope: 'finance.trips', key: 'f' },
    ]);
    expect(t!.alternatives.lastDay).toEqual([{ value: '2025-05-10', from: [{ scope: 'health.trips', key: 'h' }], reason: 'weaker' }]);
    expect(t!.alternatives.title!.map((a) => a.value)).toEqual(['Card payments in PT', 'Run']);
    expect(check('schemas/user/record.json', t)).toEqual([]);
  });

  it('keeps trips apart without a shared place or person, and puts a gap on review after a merge', () => {
    const f = newHub(userHub);
    const out = f.writeClaims({
      scope: 'photos.trips',
      claims: [trip('a', '2025-01-01', '2025-01-05'), trip('b', '2025-01-03', '2025-01-04', { countries: ['ES'] }), trip('c', '2025-07-01', '2025-07-02')],
    });
    expect(new Set(out.records.map((r) => r.id)).size).toBe(3);
    const [a, , c] = out.records.map((r) => r.id!);
    const merged = f.writeCorrections({ corrections: [cor({ op: 'merge', records: [a!, c!] })] });
    expect(merged.results[0]).toMatchObject({ status: 'applied', record: a });
    const r = f.getRecord(a!)!;
    expect(r.reviewReasons).toEqual(['gap']);
    expect(r.fields).toMatchObject({ firstDay: '2025-01-01', lastDay: '2025-07-02' });
    const removal = f.listChanges().items.find((x) => x.op === 'remove')!;
    expect(removal).toMatchObject({ id: c, mergedInto: a });
    // Later claims for the merged record go to the record it went into.
    f.writeClaims({ scope: 'photos.trips', claims: [trip('a', '2025-01-01', '2025-01-05'), trip('b', '2025-01-03', '2025-01-04', { countries: ['ES'] }), trip('c', '2025-07-01', '2025-07-03')] });
    expect(f.getRecord(a!)!.fields.lastDay).toBe('2025-07-03');
    expect(f.getRecord(c!)).toBeUndefined();
  });

  it('refines partial dates and puts dates that do not refine on review', () => {
    const f = newHub(userHub);
    const ms = (key: string, date: string, confidence = 0.8): ClaimInput => ({
      key,
      kind: 'milestone',
      confidence,
      method: 'rule:test/1',
      generation: 1,
      fields: { title: 'Debt paid', date },
      sources: [{ app: 'finance', kind: 'debt', id: key }],
    });
    // Milestones never join, so one producer gives both values to one record only through a merge.
    const out = f.writeClaims({ scope: 'finance.milestones', claims: [ms('a', '1984'), ms('b', '1984-03-12'), ms('c', '1985')] });
    const [a, b, c] = out.records.map((r) => r.id!);
    f.writeCorrections({ corrections: [cor({ op: 'merge', records: [a!, b!] })] });
    const r = f.getRecord(a!)!;
    expect(r.fields.date).toBe('1984-03-12');
    expect(r.provenance.date).toEqual([{ scope: 'finance.milestones', key: 'b' }, { scope: 'finance.milestones', key: 'a' }]);
    expect(r.alternatives.date).toEqual([{ value: '1984', from: [{ scope: 'finance.milestones', key: 'a' }], reason: 'coarser' }]);
    expect(r.review).toBe(false);
    f.writeCorrections({ corrections: [cor({ op: 'merge', records: [a!, c!], createdAt: '2026-11-20T10:01:00Z' })] });
    const r2 = f.getRecord(a!)!;
    expect(r2.reviewReasons).toEqual(['conflict']);
    expect(r2.alternatives.date).toContainEqual({ value: '1985', from: [{ scope: 'finance.milestones', key: 'c' }], reason: 'conflict' });
  });

  it('returns the first result for a repeated idempotency key and changes nothing on a dry run', () => {
    const f = newHub(userHub);
    const a = f.writeClaims({ scope: 'photos.trips', claims: [trip('a', '2025-05-01', '2025-05-03')], idempotencyKey: 'run-1' });
    const b = f.writeClaims({ scope: 'photos.trips', claims: [], idempotencyKey: 'run-1' });
    expect(b).toEqual(a);
    expect(f.listRecords('trip').items).toHaveLength(1);
    const dry = f.writeCorrections({ corrections: [cor({ op: 'reject', record: a.records[0]!.id! })], dryRun: true });
    expect(dry.changeId).toBeNull();
    expect(dry.results[0]!.state).toBe('rejected');
    expect(f.getRecord(a.records[0]!.id!)!.state).toBe('active');
    expect(f.listCorrections().items).toEqual([]);
  });
});

describe('corrections', () => {
  it('holds a correction for a removed record and applies it when the record comes back', () => {
    const f = newHub(userHub);
    const id = f.writeClaims({ scope: 'photos.trips', claims: [trip('a', '2025-05-01', '2025-05-03')] }).records[0]!.id!;
    f.writeClaims({ scope: 'photos.trips', claims: [], generation: 1 });
    const held = f.writeCorrections({ corrections: [cor({ op: 'set', record: id, fields: { title: 'Porto' } })] });
    expect(held.results[0]).toMatchObject({ status: 'held', reason: { code: 'record-removed' }, record: id });
    f.writeClaims({ scope: 'photos.trips', claims: [trip('a', '2025-05-01', '2025-05-03')] });
    expect(f.getRecord(id)!.fields.title).toBe('Porto');
  });

  it('holds a correction for an unknown record, and a clear that would empty a required field', () => {
    const f = newHub(userHub);
    const unknown = f.writeCorrections({ corrections: [cor({ op: 'set', record: 'trip_0123456789abcdef0123456789abcdef', fields: { title: 'X' } })] });
    expect(unknown.results[0]).toMatchObject({ status: 'held', reason: { code: 'unknown-record' } });
    const made = f.writeCorrections({
      corrections: [cor({ op: 'create', kind: 'place', fields: { name: 'Café', type: 'cafe', location: { lat: 60.39, lon: 5.32 } } })],
    });
    const place = made.results[0]!.record!;
    const clear = f.writeCorrections({ corrections: [cor({ op: 'clear', record: place, names: ['name'], createdAt: '2026-11-20T10:05:00Z' })] });
    expect(clear.results[0]).toMatchObject({ status: 'held', reason: { code: 'required-field' } });
    expect(f.getRecord(place)!.fields.name).toBe('Café');
    // The held correction is stored; a repeat gives the same result.
    expect(f.writeCorrections({ corrections: [clear.corrections[0]!] }).results[0]).toMatchObject({ status: 'held', repeat: true });
  });

  it('orders reject and restore by createdAt, and marks the earlier one superseded', () => {
    const f = newHub(userHub);
    const id = f.writeClaims({ scope: 'photos.trips', claims: [trip('a', '2025-05-01', '2025-05-03')] }).records[0]!.id!;
    const restore = cor({ op: 'restore', record: id, createdAt: '2026-11-20T10:02:00Z' });
    const reject = cor({ op: 'reject', record: id, createdAt: '2026-11-20T10:01:00Z' });
    f.writeCorrections({ corrections: [restore] });
    const late = f.writeCorrections({ corrections: [reject] });
    expect(late.results[0]).toMatchObject({ status: 'superseded', state: 'active' });
    expect(f.getRecord(id)!.state).toBe('active');
  });

  it('keeps corrections across a rebuild into a new database: anchors find the records again', () => {
    const f = newHub(userHub);
    const id = f.writeClaims({ scope: 'photos.trips', claims: [trip('a', '2025-05-01', '2025-05-03')] }).records[0]!.id!;
    const set = cor({ op: 'set', record: id, fields: { title: 'Lisbon' } });
    f.writeCorrections({ corrections: [set] });
    const stored = f.listCorrections().items;
    expect(stored[0]!.anchors).toEqual([{ scope: 'photos.trips', key: 'a' }]);
    // A new database: corrections come first (from the archive), claims later, under another key order.
    const g = newHub(userHub);
    g.writeClaims({ scope: 'photos.trips', claims: [trip('z', '2024-01-01', '2024-01-02', { countries: ['NO'] })] });
    const early = g.writeCorrections({ corrections: [{ ...stored[0]!, record: 'trip_ffffffffffffffffffffffffffffffff' }] });
    expect(early.results[0]).toMatchObject({ status: 'held', reason: { code: 'unknown-record' } });
    g.writeClaims({ scope: 'photos.trips', claims: [trip('z', '2024-01-01', '2024-01-02', { countries: ['NO'] }), trip('a', '2025-05-01', '2025-05-03')] });
    const lisbon = g.listRecords('trip').items.find((r) => r.claims[0]!.key === 'a')!;
    expect(lisbon.fields.title).toBe('Lisbon');
    expect(lisbon.provenance.title).toEqual([{ correction: set.id }]);
  });

  it('refuses a wrong correction whole and stores nothing', () => {
    const f = newHub(userHub);
    const good = cor({ op: 'create', kind: 'milestone', fields: { title: 'A', date: '2020' } });
    const bad = { ...cor({ op: 'set', record: 'trip_0123456789abcdef0123456789abcdef', fields: { colour: 'red' } }) };
    expect(() => f.writeCorrections({ corrections: [good, bad] })).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => f.writeCorrections({ corrections: [cor({ op: 'unmerge', record: 'person_0123456789abcdef0123456789abcdef' })] })).toThrow(/no op 'unmerge'/);
    expect(f.listCorrections().items).toEqual([]);
  });
});

describe('the hub database', () => {
  it('belongs to one hub', () => {
    const db = openDatabase(':memory:', { driver: nodeSqlite, idleCheckpointMs: 0 });
    openFacts(db, { hub: userHub, now: clock(), randomHex: counter() });
    expect(() => openFacts(db, { hub: contactsHub })).toThrow(expect.objectContaining({ code: 'wrong-hub' }));
  });

  it('registers kinds as data: a hub with a kind of its own', () => {
    const hub = {
      name: 'test',
      subjects: 'owner' as const,
      kinds: [
        { kind: 'book', plural: 'books', fields: ['title', 'isbn', 'readers'], required: ['title'], lists: ['readers'], join: { rule: 'same' as const, fields: ['isbn'] } },
      ],
    };
    const db = openDatabase(':memory:', { driver: nodeSqlite, idleCheckpointMs: 0 });
    const f = openFacts(db, { hub, now: clock(), randomHex: counter() });
    const book = (key: string, readers: string[], title = 'Dune') => ({ key, kind: 'book', confidence: 0.8, method: 'rule:t/1', generation: 1, fields: { title, isbn: '978-0441013593', readers } });
    f.writeClaims({ scope: 'shelf.books', claims: [book('s1', ['ann'])] });
    f.writeClaims({ scope: 'library.books', claims: [book('l1', ['bob', 'ann'], 'Dune (1965)')] });
    const [r] = f.listRecords('book').items;
    expect(f.listRecords('book').items).toHaveLength(1);
    expect(r!.fields).toEqual({ title: 'Dune', isbn: '978-0441013593', readers: ['ann', 'bob'] });
    expect(r!.provenance['readers/0']).toEqual([{ scope: 'shelf.books', key: 's1' }, { scope: 'library.books', key: 'l1' }]);
  });
});
