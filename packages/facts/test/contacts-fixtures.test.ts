// Every fixture of contracts/fixtures/contacts/ through the engine: Jon Example exists twice
// (an Apple card and a Google card); card revisions give his homes, workplaces, dates, and
// identities; Conversations resolves a phone at the message date and waits on a shared
// address; Photos sends a confirmed circle and a relation; the person enters a home, merges
// the two Jons, keeps two persons apart, completes a birthday, edits residents, and merges
// two homes; then unmerges. Fixture ids are mapped to engine ids; every output is checked
// against the contract schemas.
import { describe, expect, it } from 'vitest';
import {
  contactsHub,
  type ClaimsWriteInput,
  type CorrectionsWriteInput,
  type CorrectionsWriteOutput,
  type FactsRecordOut,
} from '../src/index.js';
import { check, fixture, fixtureNames, mapIds, newHub } from './helpers.js';

const API = 'openapi/contacts.v1.yaml#/components/schemas';
const JON_APPLE = 'person_bb472edb86809a761936d90c70aeb434';
const JON_GOOGLE = 'person_1a82856897e2b43e6a9500d987493ca5';
const KARI = 'person_55579b557896d0ce1764c47fed644f9b';
const OLA = 'person_9194944df25777c5bf080bcbd639b75b';

describe('contacts fixtures through the engine', () => {
  const facts = newHub(contactsHub);
  const ids = new Map<string, string>();
  const back = () => new Map([...ids].map(([a, b]) => [b, a]));
  const used = new Set<string>();
  const use = <T = Record<string, unknown>>(name: string): T => {
    used.add(name);
    return fixture<T>('contacts', name);
  };
  const claims = (input: ClaimsWriteInput) => {
    const mapped = mapIds(input, ids);
    expect(check(`${API}/ClaimsWriteInput`, mapped)).toEqual([]);
    const out = facts.writeClaims(mapped);
    expect(check(`${API}/ClaimsWriteOutput`, out)).toEqual([]);
    return out;
  };
  const corrections = (name: string, prepare?: (input: CorrectionsWriteInput) => void): CorrectionsWriteOutput => {
    const input = mapIds(use(name), ids) as unknown as CorrectionsWriteInput;
    expect(check(`${API}/CorrectionsWriteInput`, input)).toEqual([]);
    prepare?.(input);
    const out = facts.writeCorrections(input);
    expect(check(`${API}/CorrectionsWriteOutput`, out)).toEqual([]);
    return out;
  };
  const record = (fixtureId: string): FactsRecordOut => {
    const r = facts.getRecord(ids.get(fixtureId) ?? fixtureId)!;
    expect(r).toBeDefined();
    expect(check('schemas/contacts/record.json', r)).toEqual([]);
    return r;
  };
  const results = (out: CorrectionsWriteOutput) => out.results.map((r) => [r.id, r.status, r.repeat, r.state, r.reason?.code]);

  it('makes one person from each card', () => {
    const apple = use<FactsRecordOut>('person.record.json');
    const google = use<FactsRecordOut>('person-merged.record.json');
    const card = (key: string, name: string, extra: Record<string, unknown>, seen = { first: '2023-03-01T09:00:00Z', last: '2026-11-16T10:00:00Z' }) => ({
      key,
      kind: 'person',
      subject: { card: key },
      confidence: 1,
      method: 'card:vcard/1',
      generation: 41,
      seen,
      fields: { name, type: 'person', ...extra },
      sources: [{ app: 'contacts', kind: 'card', id: key }],
    });
    const out = claims({
      scope: 'contacts.persons',
      claims: [
        card(apple.claims[0]!.key, 'Jon Example', {}),
        card(google.claims.length ? google.claims[0]!.key : 'card_89548698ab5ef8c33b1bf5e6f011405f', 'Jon Example', { otherNames: ['Jonny'] }, { first: '2024-01-10T12:00:00Z', last: '2026-11-16T10:00:00Z' }),
        // Two more people of the story, with made-up cards.
        card('card_00000000000000000000000000000a01', 'Kari Example', {}),
        card('card_00000000000000000000000000000b02', 'Ola Example', {}),
      ],
    });
    expect(out.counts).toMatchObject({ created: 4, unresolved: 0 });
    [JON_APPLE, JON_GOOGLE, KARI, OLA].forEach((id, i) => ids.set(id, out.records[i]!.id!));
    expect(record(JON_APPLE).fields).toEqual({ name: 'Jon Example', type: 'person' });
  });

  it('resolves card subjects: a home, two workplaces, a birthday, and two identities', () => {
    const home = claims(use<ClaimsWriteInput>('claims-write.request.json'));
    expect(home.counts).toEqual({ ...use<{ counts: object }>('claims-write.response.json').counts });
    ids.set('home_b49bdb6ef2147f6ba82c726cff7438e8', home.records[0]!.id!);
    const r = record('home_b49bdb6ef2147f6ba82c726cff7438e8');
    const expected = use<FactsRecordOut>('home.record.json');
    expect(mapIds(r, back())).toMatchObject({ person: expected.person, fields: expected.fields, provenance: expected.provenance, claims: expected.claims, sources: expected.sources });

    const work = claims(use<ClaimsWriteInput>('workplaces-claims-write.request.json'));
    expect(work.counts.created).toBe(2); // Fabrikam, then Contoso: a newer value never ends a span.
    const dates = claims(use<ClaimsWriteInput>('dates-claims-write.request.json'));
    ids.set('date_d64996479f5523b9b17e1b3d56dc8568', dates.records[0]!.id!);
    const idents = claims(use<ClaimsWriteInput>('identities-claims-write.request.json'));
    const identsExpected = use<{ counts: object; records: { id: string }[] }>('identities-claims-write.response.json');
    expect(idents.counts).toEqual(identsExpected.counts);
    identsExpected.records.forEach((x, i) => ids.set(x.id, idents.records[i]!.id!));
    const phone = record('identity_105ff82b9f019b502b4524759fa6c220');
    const phoneExpected = use<FactsRecordOut>('identity.record.json');
    expect(mapIds(phone, back())).toMatchObject({ person: phoneExpected.person, fields: phoneExpected.fields, provenance: phoneExpected.provenance, claims: phoneExpected.claims });
  });

  it('resolves a phone handle at the message date and keeps a shared address unresolved', () => {
    const out = claims(use<ClaimsWriteInput>('conversations-identities-claims-write.request.json'));
    const expected = use<{ counts: object; records: { key: string; id: string | null }[] }>('conversations-identities-claims-write.response.json');
    expect(out.counts).toEqual(expected.counts);
    expect(mapIds(out.records, back())).toEqual(expected.records);
    const phone = record('identity_105ff82b9f019b502b4524759fa6c220');
    expect(phone.claims.map((c) => c.scope)).toEqual(['contacts.identities', 'conversations.identities']);
  });

  it('takes the circle and the relation that the person confirmed in Photos', () => {
    const circle = claims(use<ClaimsWriteInput>('photos-circles-claims-write.request.json'));
    const c = facts.getRecord(circle.records[0]!.id!)!;
    expect(check('schemas/contacts/record.json', c)).toEqual([]);
    const circleExpected = use<FactsRecordOut>('circle.record.json');
    expect(mapIds(c, back())).toMatchObject({ person: circleExpected.person, fields: circleExpected.fields });
    const rel = claims(use<ClaimsWriteInput>('photos-relations-claims-write.request.json'));
    const relation = facts.getRecord(rel.records[0]!.id!)!;
    expect(check('schemas/contacts/record.json', relation)).toEqual([]);
    const relationExpected = use<FactsRecordOut>('relation.record.json');
    expect(mapIds(relation, back())).toMatchObject({
      person: relationExpected.person,
      other: relationExpected.other,
      fields: relationExpected.fields,
      provenance: relationExpected.provenance,
      claims: relationExpected.claims,
    });
  });

  it('lists the homes of the person that a merged id leads to', () => {
    const page = facts.listRecords('home', mapIds(use('homes-list.request.json'), ids));
    expect(check(`${API}/RecordPage`, page)).toEqual([]);
    // Before the merge, the Google Jon has no homes of his own.
    expect(page.items).toEqual([]);
    const all = facts.listRecords('home', { person: ids.get(JON_APPLE)!, from: '2024', to: '2026' });
    const expected = use<{ items: FactsRecordOut[] }>('homes-list.response.json');
    expect(mapIds(all.items.map((r) => r.id), back())).toEqual(expected.items.map((r) => r.id));
  });

  it('stores a created home, a person merge, a pin, a birthday year, a resident edit, and a home merge', () => {
    // The later corrections of this request name the home that the first one creates, so the
    // test gives the create the id the fixture shows (an app's outbox waits for that id instead).
    const out = corrections('corrections-write.request.json', (input) => {
      input.corrections[0]!.record = 'home_85c002863d4491ddb47f5b325a52f641';
    });
    const expected = use<CorrectionsWriteOutput>('corrections-write.response.json');
    expect(results(out).map((r) => r.slice(0, 3))).toEqual(results(expected).map((r) => r.slice(0, 3)));
    expect(out.results.every((r) => r.status === 'applied')).toBe(true);
    // The create's result names the record that holds the home now: the card home it was merged into.
    expect(mapIds(out.results[0]!.record, back())).toBe('home_b49bdb6ef2147f6ba82c726cff7438e8');
    expect(mapIds(out.corrections[5]!.anchors, back())).toEqual(expected.corrections[5]!.anchors);
    expect(mapIds(out.corrections[3]!.anchors, back())).toEqual(expected.corrections[3]!.anchors);

    // The two Jons are one person; the Google one stays as a redirect.
    const jon = record(JON_APPLE);
    const jonExpected = use<FactsRecordOut>('person.record.json');
    expect(mapIds(jon, back())).toMatchObject({ fields: jonExpected.fields, provenance: jonExpected.provenance, claims: jonExpected.claims, sources: jonExpected.sources });
    const merged = record(JON_GOOGLE);
    const mergedExpected = use<FactsRecordOut>('person-merged.record.json');
    expect(mapIds(merged, back())).toMatchObject({ mergedInto: mergedExpected.mergedInto, fields: mergedExpected.fields, claims: [], provenance: mergedExpected.provenance });
    const envelope = { record: merged };
    expect(check(`${API}/RecordEnvelope`, envelope)).toEqual([]);
    expect(mapIds(envelope, back()).record.id).toBe(use<{ record: FactsRecordOut }>('persons-get.response.json').record.id);

    // The birthday: the person's year refines the card's --03-12.
    const date = record('date_d64996479f5523b9b17e1b3d56dc8568');
    const dateExpected = use<FactsRecordOut>('date.record.json');
    expect(mapIds(date, back())).toMatchObject({
      person: dateExpected.person,
      fields: dateExpected.fields,
      provenance: dateExpected.provenance,
      alternatives: dateExpected.alternatives,
      corrected: dateExpected.corrected,
      review: false,
    });

    // The pin keeps Kari and Ola apart.
    expect(mapIds(facts.pins(), back())).toEqual([[KARI, OLA].sort()]);

    // The created home went into the card home; its fields and residents come along.
    expect(facts.getRecord('home_85c002863d4491ddb47f5b325a52f641')).toBeUndefined();
    expect(facts.followRecord('home_85c002863d4491ddb47f5b325a52f641')).toBe(ids.get('home_b49bdb6ef2147f6ba82c726cff7438e8'));
    const home = record('home_b49bdb6ef2147f6ba82c726cff7438e8');
    expect(home.review).toBe(false);
    expect(home.fields).toMatchObject({ address: 'Eksempelveien 1', label: "Jon's home", from: '2011' });
    expect(mapIds(home.fields.residents, back())).toEqual([{ person: KARI, from: '2016' }]);
    expect(home.sources.map((s) => s.app)).toEqual(['photos', 'contacts']);
    const changes = facts.listChanges({ kinds: ['home'] }).items;
    const removal = changes.find((c) => c.op === 'remove');
    expect(mapIds(removal, back())).toMatchObject({ id: 'home_85c002863d4491ddb47f5b325a52f641', mergedInto: 'home_b49bdb6ef2147f6ba82c726cff7438e8', person: JON_APPLE });
  });

  it('unmerges a person once and holds a second unmerge as not merged', () => {
    const out = corrections('corrections-unmerge.request.json');
    const expected = use<CorrectionsWriteOutput>('corrections-unmerge.response.json');
    expect(results(out)).toEqual(results(expected));
    const google = record(JON_GOOGLE);
    expect(google.mergedInto).toBeUndefined();
    expect(google.claims.map((c) => c.key)).toEqual(['card_89548698ab5ef8c33b1bf5e6f011405f']);
    expect(record(JON_APPLE).claims).toHaveLength(1);
  });

  it('feeds every change in the shape of the contract, with the person of each', () => {
    const request = use<{ kinds?: string[] }>('changes-list.request.json');
    const page = facts.listChanges({ ...(request.kinds ? { kinds: request.kinds } : {}), limit: 5000 });
    expect(check(`${API}/ChangesListOutput`, page)).toEqual([]);
    use('changes-list.response.json');
    const kinds = new Set(page.items.map((c) => c.kind));
    for (const k of request.kinds ?? []) expect(kinds.has(k)).toBe(true);
    for (const c of facts.listChanges({ limit: 5000 }).items) {
      expect(check(`${API}/Change`, c)).toEqual([]);
      expect(c.person).toBeDefined();
    }
    use('workplace.record.json');
    const work = facts.listRecords('workplace').items;
    expect(work.map((w) => w.fields.name).sort()).toEqual(['Contoso', 'Fabrikam']);
    for (const w of work) expect(check('schemas/contacts/record.json', w)).toEqual([]);
  });

  it('read every contacts fixture', () => {
    expect(fixtureNames('contacts').filter((n) => !used.has(n))).toEqual([]);
  });
});
