// Every fixture of contracts/fixtures/user/ through the engine, in the order of the story the
// fixtures tell: Photos trips, the owner's person, the first corrections, a Finance and a
// Contacts home that confirm the home the person entered, a Health stay, repeats, edits
// that arrive in the reverse order, and a list edit. Fixture record ids are mapped to the
// ids that the engine makes; every output is checked against the contract schemas.
import { describe, expect, it } from 'vitest';
import {
  userHub,
  type ClaimsWriteInput,
  type CorrectionsWriteInput,
  type CorrectionsWriteOutput,
  type FactsRecordOut,
} from '../src/index.js';
import { check, fixture, fixtureNames, mapIds, newHub } from './helpers.js';

const API = 'openapi/user.v1.yaml#/components/schemas';

describe('user fixtures through the engine', () => {
  const facts = newHub(userHub);
  const ids = new Map<string, string>(); // fixture id -> engine id
  const back = () => new Map([...ids].map(([a, b]) => [b, a]));
  const used = new Set<string>();
  const use = (name: string) => {
    used.add(name);
    return fixture('user', name);
  };
  const corrections = (name: string): CorrectionsWriteOutput => {
    const input = mapIds(use(name), ids) as unknown as CorrectionsWriteInput;
    expect(check(`${API}/CorrectionsWriteInput`, input)).toEqual([]);
    const out = facts.writeCorrections(input);
    expect(check(`${API}/CorrectionsWriteOutput`, out)).toEqual([]);
    return out;
  };
  const claims = (input: ClaimsWriteInput) => {
    expect(check(`${API}/ClaimsWriteInput`, input)).toEqual([]);
    const out = facts.writeClaims(input);
    expect(check(`${API}/ClaimsWriteOutput`, out)).toEqual([]);
    return out;
  };
  const record = (fixtureId: string): FactsRecordOut => {
    const r = facts.getRecord(ids.get(fixtureId) ?? fixtureId)!;
    expect(r).toBeDefined();
    expect(check('schemas/user/record.json', r)).toEqual([]);
    return r;
  };

  it('writes the Photos trips and maps the fixture ids', () => {
    const out = claims(use('claims-write.request.json') as unknown as ClaimsWriteInput);
    const expected = use('claims-write.response.json') as { records: { key: string; id: string }[] };
    expect(out.records.map((r) => r.key)).toEqual(expected.records.map((r) => r.key));
    expect(out.counts).toMatchObject({ created: 2, withdrawn: 0 });
    expected.records.forEach((r, i) => ids.set(r.id, out.records[i]!.id!));
    // A trip below confidence 0.5 is on the quiet review list.
    expect(record('trip_9cabab35b4b615729dfde9c5214f82bc').reviewReasons).toEqual(['low-confidence']);
  });

  it('writes the owner person from the record fixture', () => {
    const p = use('person.record.json') as unknown as FactsRecordOut;
    const c = p.claims[0]!;
    const out = claims({
      scope: c.scope,
      claims: [
        {
          key: c.key,
          kind: 'person',
          confidence: c.confidence,
          method: 'card:vcard/1',
          generation: 1,
          seen: c.seen!,
          fields: p.fields,
          sources: p.sources,
        },
      ],
    });
    ids.set(p.id, out.records[0]!.id!);
    const r = record(p.id);
    expect(r.fields).toEqual(p.fields);
    expect(r.provenance).toEqual(p.provenance);
    expect(r.claims).toEqual(p.claims);
  });

  it('stores the first corrections: a title, a reject, a milestone, the owner link, and a home', () => {
    const out = corrections('corrections-write.request.json');
    const expected = use('corrections-write.response.json') as unknown as CorrectionsWriteOutput;
    expect(out.results.map((r) => [r.id, r.status, r.repeat, r.state])).toEqual(
      expected.results.map((r) => [r.id, r.status, r.repeat, r.state]),
    );
    // The records that the creates made.
    expected.results.forEach((r, i) => {
      if (!ids.has(r.record!)) ids.set(r.record!, out.results[i]!.record!);
    });
    const withoutAnchors = (list: CorrectionsWriteOutput['corrections']) => list.map(({ anchors: _a, ...c }) => c);
    expect(withoutAnchors(mapIds(out.corrections, back()))).toEqual(withoutAnchors(expected.corrections));
    const trip = record('trip_be3b7aabcbc567ddfdcace1a9d735bf4');
    // The trip fixture after these corrections. Memex.User reads the owner's own Contacts
    // reference as the owner's id when it serves a record; the engine stores it as given.
    const tripFixture = use('trip.record.json') as unknown as FactsRecordOut;
    const owner = { app: 'contacts', kind: 'person', id: 'ct_alex' };
    const asStored = mapIds(tripFixture.fields, new Map([[JSON.stringify('person_4c1029697ee358715d3a14a2add817c4'), JSON.stringify(owner)]]));
    expect(mapIds(trip.fields, back())).toEqual(asStored);
    expect(trip.claims).toEqual(tripFixture.claims);
    expect(trip.sources).toEqual(tripFixture.sources);
    expect(trip.corrected).toEqual(tripFixture.corrected);
    expect(trip.fields.title).toBe('Lisbon with Sam');
    expect(trip.alternatives.title).toEqual([{ value: 'Lisbon', from: [{ scope: 'photos.trips', key: 'trip-1842' }], reason: 'weaker' }]);
    expect(trip.provenance.title).toEqual([{ correction: 'cor_d0f631ca1ddba8db3bcfcb9e057cdc98' }]);
    const rejected = record('trip_9cabab35b4b615729dfde9c5214f82bc');
    expect(rejected.state).toBe('rejected');
    expect(rejected.review).toBe(false);
    const milestone = record('milestone_7f7f85b1e7d5ffd45265405b7236de39');
    expect(milestone).toMatchObject({ origin: 'user', confidence: 1, fields: { title: 'Moved to Bergen', date: '2019-08' } });
  });

  it('joins a Finance town and the owner card into the home the person entered, with a suggested end', () => {
    claims(use('finance-claims-write.request.json') as unknown as ClaimsWriteInput);
    claims(use('contacts-claims-write.request.json') as unknown as ClaimsWriteInput);
    const expected = use('home.record.json') as unknown as FactsRecordOut;
    const home = record('home_4ea140588150773ce3aace786aeef7f4');
    const mapped = mapIds(home, back());
    expect(mapped.fields).toEqual(expected.fields);
    expect(mapped.origin).toBe('user');
    expect(mapped.review).toBe(true);
    expect(mapped.reviewReasons).toEqual(expected.reviewReasons);
    expect(mapped.alternatives).toEqual(expected.alternatives);
    expect(mapped.corrected).toEqual(expected.corrected);
    expect(mapped.claims).toEqual(expected.claims);
    expect(mapped.sources).toEqual(expected.sources);
    // Every field the fixture names has the same first origin; town lists all three apps.
    for (const [field, origins] of Object.entries(expected.provenance)) {
      expect(mapped.provenance[field]?.[0]).toEqual(origins[0]);
    }
    expect(mapped.provenance.town).toEqual(expected.provenance.town);
    // Oslo stays a home of its own: a town-only claim joins only a record in its town.
    const homes = facts.listRecords('home').items;
    expect(homes.map((h) => h.fields.town).sort()).toEqual(['Bergen', 'Oslo']);
  });

  it('writes a Health stay in a partition, and a Photos stay as a dry run that stores nothing', () => {
    const health = claims(use('health-claims-write.request.json') as unknown as ClaimsWriteInput);
    expect(health.counts.created).toBe(1);
    const dry = claims(use('stays-claims-write.request.json') as unknown as ClaimsWriteInput);
    expect(dry.changeId).toBeNull();
    expect(dry.counts.created).toBe(1);
    expect(facts.listRecords('stay').items).toHaveLength(1);
    expect(facts.listClaims('photos.stays')).toEqual([]);
  });

  it('returns the stored correction for a repeat by id', () => {
    const out = corrections('corrections-repeat.request.json');
    const expected = use('corrections-repeat.response.json') as unknown as CorrectionsWriteOutput;
    expect(out.changeId).toBeNull();
    expect(out.results.map((r) => [r.id, r.status, r.repeat, r.state])).toEqual(expected.results.map((r) => [r.id, r.status, r.repeat, r.state]));
    expect(mapIds(out.results[0]!.record, back())).toBe(expected.results[0]!.record);
  });

  it('stores a create sent again with a new id as an alias of the earlier create', () => {
    const out = corrections('corrections-create-repeat.request.json');
    const expected = use('corrections-create-repeat.response.json') as unknown as CorrectionsWriteOutput;
    expect(out.changeId).toBeNull();
    const [r] = out.results;
    expect(r).toMatchObject({ id: expected.results[0]!.id, status: 'applied', repeat: true, repeatOf: expected.results[0]!.repeatOf });
    expect(mapIds(r!.record, back())).toBe(expected.results[0]!.record);
    expect(out.corrections[0]!.id).toBe('cor_5b0e8d7c2a9f4e61b3d07c58a1e2f946');
    expect(facts.listRecords('home').items).toHaveLength(2);
  });

  it('lets the later createdAt win when two edits of one field arrive in the reverse order', () => {
    const first = corrections('corrections-out-of-order-1.request.json');
    expect(first.results[0]).toMatchObject({ status: 'applied', repeat: false });
    expect(first.results[0]!.overridden).toBeUndefined();
    const firstExpected = use('corrections-out-of-order-1.response.json') as unknown as CorrectionsWriteOutput;
    expect(first.results.map((r) => [r.id, r.status, r.repeat, r.state])).toEqual(firstExpected.results.map((r) => [r.id, r.status, r.repeat, r.state]));
    const second = corrections('corrections-out-of-order-2.request.json');
    const expected = use('corrections-out-of-order-2.response.json') as unknown as CorrectionsWriteOutput;
    expect(second.results[0]).toMatchObject({ status: 'applied', overridden: expected.results[0]!.overridden });
    const trip = record('trip_be3b7aabcbc567ddfdcace1a9d735bf4');
    expect(trip.fields.title).toBe('Lisbon and Sintra');
    expect(trip.fields.lastDay).toBe('2025-05-09');
    expect(trip.alternatives.lastDay).toEqual([{ value: '2025-05-08', from: [{ scope: 'photos.trips', key: 'trip-1842' }], reason: 'weaker' }]);
    expect(trip.alternatives.title?.map((a) => a.value)).toEqual(['Lisbon']);
  });

  it('edits the participants with add and remove, and anchors the correction to its claims', () => {
    const out = corrections('corrections-list-edit.request.json');
    const expected = use('corrections-list-edit.response.json') as unknown as CorrectionsWriteOutput;
    expect(out.corrections[0]!.anchors).toEqual(expected.corrections[0]!.anchors);
    expect(out.results[0]).toMatchObject({ status: 'applied', repeat: false, state: 'active' });
    const trip = record('trip_be3b7aabcbc567ddfdcace1a9d735bf4');
    expect(trip.fields.participants).toEqual([
      { app: 'contacts', kind: 'person', id: 'ct_alex' },
      { app: 'contacts', kind: 'person', id: 'ct_kim' },
    ]);
    expect(trip.provenance['participants/1']).toEqual([{ correction: 'cor_01d3b9f27a6c4e58b0a1c2d3e4f5a6b7' }]);
    expect(trip.corrected).toEqual(['title', 'lastDay', 'participants']);
    // The removed participant does not come back when Photos sends its claims again.
    claims(use('claims-write.request.json') as unknown as ClaimsWriteInput);
    expect(record('trip_be3b7aabcbc567ddfdcace1a9d735bf4').fields.participants).toHaveLength(2);
  });

  it('lists, gets, and feeds records in the shapes of the contract', () => {
    const list = facts.listRecords('trip', { ...mapIds(use('trips-list.request.json') as Record<string, never>, ids), includeRejected: true });
    expect(check(`${API}/RecordPage`, list)).toEqual([]);
    const page = use('trips-list.response.json') as { items: FactsRecordOut[] };
    expect(mapIds(list.items.map((r) => r.id), back())).toEqual(expect.arrayContaining(page.items.map((r) => r.id)));
    expect(check(`${API}/RecordEnvelope`, { record: record('trip_be3b7aabcbc567ddfdcace1a9d735bf4') })).toEqual([]);
    use('trips-get.response.json');
    // The workplace that the person made, from its record fixture.
    const w = use('workplace.record.json') as unknown as FactsRecordOut;
    const corrId = (w.provenance.name![0] as { correction: string }).correction;
    const made = facts.writeCorrections({
      corrections: [{ id: corrId, op: 'create', kind: 'workplace', fields: w.fields, sources: w.sources, app: 'photos', createdAt: w.createdAt }],
    });
    const workplace = facts.getRecord(made.results[0]!.record!)!;
    expect(check('schemas/user/record.json', workplace)).toEqual([]);
    expect(workplace.fields).toEqual(w.fields);
    expect(mapIds(workplace.provenance, new Map())).toEqual(w.provenance);
    expect(workplace).toMatchObject({ origin: 'user', confidence: 1, review: false, corrected: w.corrected, claims: [], sources: w.sources });
    const request = use('changes-list.request.json') as { kinds: string[] };
    const changes = facts.listChanges({ kinds: request.kinds, limit: 500 });
    expect(check(`${API}/ChangesListOutput`, changes)).toEqual([]);
    expect(changes.items.some((c) => c.op === 'upsert' && c.record?.state === 'rejected')).toBe(true);
    use('changes-list.response.json');
    const all = facts.listChanges();
    for (const c of all.items) expect(check(`${API}/Change`, c)).toEqual([]);
  });

  it('read every user fixture', () => {
    expect(fixtureNames('user').filter((n) => !used.has(n))).toEqual([]);
  });
});
