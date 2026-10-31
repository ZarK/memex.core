// Edge cases: rejects that stay on their own record, keys that come back
// into another record, creates with an id in use, field values against the kind schemas,
// empty claims writes and their generation, homes with near pins, and correction order.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { userHub, type ClaimInput, type Correction } from '../src/index.js';
import { check, newHub, ROOT } from './helpers.js';
// @ts-expect-error: a plain JavaScript build script with no types.
import { kindSchemasSource } from '../scripts/kind-schemas.mjs';

const trip = (key: string, generation: number, fields: Record<string, unknown> = {}): ClaimInput => ({
  key,
  kind: 'trip',
  confidence: 0.9,
  method: 'rule:trip/1',
  generation,
  fields: { title: 'Lisbon', firstDay: '2025-05-01', lastDay: '2025-05-08', countries: ['PT'], ...fields },
  sources: [],
});
const cor = (i: number, c: Record<string, unknown>): Correction =>
  ({ id: `cor_${i.toString(16).padStart(32, '0')}`, app: 'photos', createdAt: '2026-11-16T09:00:00Z', ...c }) as Correction;

describe('edge cases', () => {
  it('keeps a reject on the record that the person rejected when a longer trip would take its claim', () => {
    const f = newHub(userHub);
    const p = f.writeClaims({ scope: 'photos.trips', claims: [trip('P', 1)] }).records[0]!.id!;
    f.writeCorrections({ corrections: [cor(1, { op: 'set', record: p, fields: { title: 'Lisbon with Sam' } })] });
    const fin = f.writeClaims({
      scope: 'finance.trips',
      claims: [trip('F', 1, { title: 'Card payments in Portugal', firstDay: '2025-05-20', lastDay: '2025-05-21' })],
    }).records[0]!.id!;
    f.writeCorrections({ corrections: [cor(2, { op: 'reject', record: fin, createdAt: '2026-11-16T09:05:00Z' })] });
    f.writeClaims({ scope: 'photos.trips', claims: [trip('P', 2, { lastDay: '2025-05-22' })] });
    expect(f.getRecord(p)).toMatchObject({ state: 'active', fields: { title: 'Lisbon with Sam', lastDay: '2025-05-22' } });
    expect(f.getRecord(p)!.claims.map((c) => c.key)).toEqual(['P']);
    expect(f.getRecord(fin)).toMatchObject({ state: 'rejected' });
    expect(f.listRecords('trip').items.map((r) => r.id)).toEqual([p]);
    // A repeat of the reject still names the Finance record, and a reject never follows a merge.
    const again = f.writeCorrections({ corrections: [cor(2, { op: 'reject', record: fin, createdAt: '2026-11-16T09:05:00Z' })] });
    expect(again.results[0]).toMatchObject({ status: 'applied', record: fin, state: 'rejected', repeat: true });
    for (const r of f.listRecords('trip', { includeRejected: true }).items) expect(check('schemas/user/record.json', r)).toEqual([]);
  });

  it('gives a key that comes back into a record stored earlier its corrections again', () => {
    const f = newHub(userHub);
    const fin = f.writeClaims({
      scope: 'finance.trips',
      claims: [trip('F', 1, { title: 'Card payments', firstDay: '2025-06-10', lastDay: '2025-06-12' })],
    }).records[0]!.id!;
    const a = f.writeClaims({ scope: 'photos.trips', claims: [trip('A', 1)] }).records[0]!.id!;
    f.writeCorrections({ corrections: [cor(1, { op: 'set', record: a, fields: { title: 'Lisbon with Sam' } })] });
    f.writeClaims({ scope: 'photos.trips', claims: [], generation: 2 });
    const back = f.writeClaims({ scope: 'photos.trips', claims: [trip('A', 3, { lastDay: '2025-06-11' })] });
    expect(back.records[0]!.id).toBe(fin);
    expect(f.getRecord(fin)).toMatchObject({ fields: { title: 'Lisbon with Sam' }, corrected: ['title'] });
    expect(f.followRecord(a)).toBe(fin);
    const resend = f.writeCorrections({ corrections: [cor(1, { op: 'set', record: a, fields: { title: 'Lisbon with Sam' } })] });
    expect(resend.results[0]).toMatchObject({ status: 'applied', record: fin, repeat: true });
    const last = f.listChanges().items.filter((c) => c.id === a).pop();
    expect(last).toMatchObject({ op: 'remove', mergedInto: fin });
  });

  it('gives a create a new id when its record id is in use', () => {
    const f = newHub(userHub);
    const id = f.writeClaims({ scope: 'photos.trips', claims: [trip('t1', 1)] }).records[0]!.id!;
    f.writeCorrections({ corrections: [cor(1, { op: 'set', record: id, fields: { title: 'Lisbon with Sam' } })] });
    const made = f.writeCorrections({
      corrections: [
        cor(2, { op: 'create', kind: 'trip', record: id, fields: { title: 'My own trip', firstDay: '2024-01-01', lastDay: '2024-01-03' } }),
      ],
    });
    const mine = made.results[0]!.record!;
    expect(mine).not.toBe(id);
    expect(made.corrections[0]!.record).toBe(mine);
    expect(f.getRecord(id)).toMatchObject({ origin: 'inferred', fields: { title: 'Lisbon with Sam' } });
    expect(f.getRecord(mine)).toMatchObject({ origin: 'user', fields: { title: 'My own trip' } });

    const rid = `place_${'ab'.repeat(16)}`;
    const two = f.writeCorrections({
      corrections: [
        cor(3, { op: 'create', kind: 'place', record: rid, fields: { name: 'Cafe One', type: 'cafe', location: { lat: 59.9, lon: 10.7 } } }),
        cor(4, { op: 'create', kind: 'place', record: rid, fields: { name: 'Bar Two', type: 'bar', location: { lat: 63.4, lon: 10.4 } } }),
      ],
    });
    expect(two.results[0]!.record).toBe(rid);
    expect(two.results[1]!.record).not.toBe(rid);
    expect(f.listRecords('place').items.map((p) => p.fields.name).sort()).toEqual(['Bar Two', 'Cafe One']);
  });

  it('refuses claims and corrections whose field values break the kind schema', () => {
    const f = newHub(userHub);
    expect(() => f.writeClaims({ scope: 'health.trips', claims: [trip('bad', 1, { firstDay: 'soon', title: 42 })] })).toThrow(
      expect.objectContaining({ code: 'invalid', status: 400 }),
    );
    const id = f.writeClaims({ scope: 'photos.trips', claims: [trip('A', 1)] }).records[0]!.id!;
    expect(() => f.writeCorrections({ corrections: [cor(1, { op: 'set', record: id, fields: { title: null } })] })).toThrow(/title/);
    expect(() => f.writeCorrections({ corrections: [cor(1, { op: 'set', record: id, fields: { lastDay: 'later' } })] })).toThrow(/lastDay/);
    expect(() => f.writeCorrections({ corrections: [cor(1, { op: 'set', record: id, fields: { countries: { add: ['Portugal'] } } })] })).toThrow(
      /countries/,
    );
    expect(() =>
      f.writeCorrections({ corrections: [cor(1, { op: 'create', kind: 'trip', fields: { title: 'X', firstDay: '2025-13-01', lastDay: '2025-01-02' } })] }),
    ).toThrow(/firstDay/);
    expect(f.listCorrections().items).toEqual([]);
    expect(f.getRecord(id)!.fields).toEqual({ title: 'Lisbon', firstDay: '2025-05-01', lastDay: '2025-05-08', countries: ['PT'] });
    expect(f.writeCorrections({ corrections: [cor(2, { op: 'set', record: id, fields: { countries: { add: ['ES'] } } })] }).results[0]!.status).toBe(
      'applied',
    );
  });

  it('needs a generation for an empty claims write when the scope has one, and refuses a stale one', () => {
    const f = newHub(userHub);
    f.writeClaims({ scope: 'photos.trips', claims: [trip('t1', 4)] });
    expect(() => f.writeClaims({ scope: 'photos.trips', claims: [] })).toThrow(expect.objectContaining({ code: 'invalid', status: 400 }));
    expect(() => f.writeClaims({ scope: 'photos.trips', claims: [], generation: 3 })).toThrow(
      expect.objectContaining({ code: 'stale-generation', status: 409 }),
    );
    expect(() => f.writeClaims({ scope: 'photos.trips', claims: [trip('t1', 5)], generation: 6 })).toThrow(/generation of the claims/);
    expect(f.listRecords('trip').items).toHaveLength(1);
    expect(f.writeClaims({ scope: 'photos.trips', claims: [], generation: 5 }).counts).toMatchObject({ withdrawn: 1, removed: 1 });
    expect(() => f.writeClaims({ scope: 'photos.trips', claims: [trip('t1', 4)] })).toThrow(expect.objectContaining({ code: 'stale-generation' }));
    // A first write of a scope may be empty without a generation.
    expect(f.writeClaims({ scope: 'health.trips', claims: [] }).changeId).toBeNull();
  });

  it('joins two homes whose pins are close when their address texts differ', () => {
    const f = newHub(userHub);
    const home = (key: string, fields: Record<string, unknown>): ClaimInput => ({
      key,
      kind: 'home',
      confidence: 0.9,
      method: 'rule:home/1',
      generation: 1,
      fields: { type: 'home', town: 'Bergen', ...fields },
      sources: [],
    });
    f.writeClaims({ scope: 'photos.homes', claims: [home('h1', { location: { lat: 60.393, lon: 5.324 }, address: 'Eksempelveien 1', from: '2020-01' })] });
    f.writeClaims({
      scope: 'finance.homes',
      claims: [home('h2', { location: { lat: 60.39315, lon: 5.3241 }, address: 'Eksempelveien 1, 5003 Bergen', from: '2020-02' })],
    });
    const homes = f.listRecords('home').items;
    expect(homes).toHaveLength(1);
    expect(homes[0]!.claims.map((c) => c.key)).toEqual(['h1', 'h2']);
  });

  it('reports the earlier arrival superseded when two sets have the same createdAt', () => {
    const f = newHub(userHub);
    const id = f.writeClaims({ scope: 'photos.trips', claims: [trip('t1', 1)] }).records[0]!.id!;
    const r = f.writeCorrections({
      corrections: [cor(1, { op: 'set', record: id, fields: { title: 'A' } }), cor(2, { op: 'set', record: id, fields: { title: 'B' } })],
    });
    expect(r.results.map((x) => x.status)).toEqual(['superseded', 'applied']);
    expect(f.getRecord(id)!.fields.title).toBe('B');
  });

  it('compares seen.last as times, also with fractional seconds', () => {
    const f = newHub(userHub);
    const seen = (last: string) => ({ first: '2025-05-01T00:00:00Z', last });
    f.writeClaims({ scope: 'photos.trips', claims: [{ ...trip('a', 1, { title: 'Older' }), seen: seen('2025-05-09T00:00:00Z') }] });
    f.writeClaims({ scope: 'health.trips', claims: [{ ...trip('b', 1, { title: 'Newer' }), seen: seen('2025-05-09T00:00:00.500Z') }] });
    expect(f.listRecords('trip').items[0]!.fields.title).toBe('Newer');
  });

  it('refuses a list cursor that is not a page offset', () => {
    const f = newHub(userHub);
    f.writeClaims({ scope: 'photos.trips', claims: [trip('a', 1), trip('b', 1, { firstDay: '2025-09-01', lastDay: '2025-09-02' })] });
    expect(f.listRecords('trip', { limit: 1 }).next).toBe('1');
    expect(f.listRecords('trip', { limit: 1, cursor: '1' }).items).toHaveLength(1);
    for (const cursor of ['abc', '-1', '1.5', '']) expect(() => f.listRecords('trip', { cursor })).toThrow(expect.objectContaining({ code: 'invalid' }));
    expect(() => f.listCorrections({ cursor: 'x' })).toThrow(expect.objectContaining({ code: 'invalid' }));
  });

  it('keeps src/kind-schemas.ts the same as schemas/user and schemas/contacts', () => {
    const file = readFileSync(join(ROOT, 'packages/facts/src/kind-schemas.ts'), 'utf-8').replace(/\r\n/g, '\n');
    expect(file).toBe(kindSchemasSource());
  });
});
