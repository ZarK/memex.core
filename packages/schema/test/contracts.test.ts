// The facts contracts: every fixture of contracts/fixtures/user/ and contracts/fixtures/contacts/
// matches the schema that its index.json names, every schema uses only keywords that the checker
// applies, and every fixture reads and writes back byte for byte.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { KEYWORDS, keywords, makeChecker } from './json-schema.js';
import { writeFixtureJson } from './fixture-json.js';
import type {
  ContactsChange,
  ContactsClaim,
  ContactsCorrection,
  ContactsRecord,
  FactsRecord,
  UserChange,
  UserClaim,
  UserCorrection,
  UserRecord,
} from '../src/index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const text = (path: string) => readFileSync(join(ROOT, path), 'utf-8').replace(/\r\n/g, '\n');

const SCHEMA_DIRS = ['schemas/user', 'schemas/contacts', 'schemas/facts'];
const files: Record<string, unknown> = { 'schemas/surfaces/error.json': JSON.parse(text('schemas/surfaces/error.json')) };
for (const dir of SCHEMA_DIRS) {
  for (const name of readdirSync(join(ROOT, dir))) files[`${dir}/${name}`] = JSON.parse(text(`${dir}/${name}`));
}
const OPENAPI = ['openapi/user.v1.yaml', 'openapi/contacts.v1.yaml'];
for (const path of OPENAPI) files[path] = parseYaml(text(path));
const check = makeChecker(files);

describe('facts schemas', () => {
  it('use only the keywords that the test checker applies', () => {
    const found = new Set<string>();
    for (const [path, schema] of Object.entries(files)) {
      if (path.endsWith('.yaml')) keywords((schema as { components: { schemas: unknown } }).components.schemas, found, true);
      else keywords(schema, found);
    }
    expect([...found].filter((k) => !KEYWORDS.has(k))).toEqual([]);
  });

  it('forbid fields that they do not name, on every object with properties', () => {
    const open: string[] = [];
    const walk = (node: unknown, at: string) => {
      if (Array.isArray(node)) return node.forEach((n, i) => walk(n, `${at}/${i}`));
      if (typeof node !== 'object' || node === null) return;
      const o = node as Record<string, unknown>;
      if (o.properties !== undefined && o.additionalProperties === undefined && o.type === 'object') open.push(at);
      for (const [k, v] of Object.entries(o)) walk(v, `${at}/${k}`);
    };
    for (const dir of SCHEMA_DIRS) for (const [path, schema] of Object.entries(files)) if (path.startsWith(dir)) walk(schema, path);
    expect(open).toEqual([]);
  });

  it('never say household', () => {
    const paths = [...Object.keys(files).filter((p) => !p.startsWith('schemas/surfaces')), 'contracts/user-records.md', 'contracts/contacts-records.md', 'contracts/facts.md'];
    expect(paths.filter((p) => /household/i.test(text(p)))).toEqual([]);
  });
});

for (const dir of ['user', 'contacts']) {
  const base = `contracts/fixtures/${dir}`;
  const index = JSON.parse(text(`${base}/index.json`)) as { fixtures: Record<string, string> };

  describe(`${base}`, () => {
    it('index.json names every fixture file, and only those', () => {
      const names = readdirSync(join(ROOT, base)).filter((n) => n !== 'index.json').sort();
      expect(Object.keys(index.fixtures).sort()).toEqual(names);
    });

    for (const [name, schema] of Object.entries(index.fixtures)) {
      it(`${name} matches ${schema}`, () => {
        expect(check(schema, JSON.parse(text(`${base}/${name}`)))).toEqual([]);
      });
      it(`${name} reads and writes back without change`, () => {
        const original = text(`${base}/${name}`);
        expect(writeFixtureJson(JSON.parse(original))).toBe(original);
      });
    }

    it('index.json reads and writes back without change', () => {
      const original = text(`${base}/index.json`);
      expect(writeFixtureJson(JSON.parse(original))).toBe(original);
    });
  });
}

// Values that the schemas must refuse: the v2 rules, not only the shapes.
const U = 'schemas/user/';
const C = 'schemas/contacts/';
const fixture = (path: string) => JSON.parse(text(path)) as Record<string, unknown>;
const userRecord = (name: string) => fixture(`contracts/fixtures/user/${name}`) as unknown as UserRecord & Record<string, unknown>;
const contactsRecord = (name: string) => fixture(`contracts/fixtures/contacts/${name}`) as unknown as ContactsRecord & Record<string, unknown>;
const userClaims = () => (fixture('contracts/fixtures/user/claims-write.request.json').claims as UserClaim[]);
const contactsClaim = (name: string) => (fixture(`contracts/fixtures/contacts/${name}`).claims as ContactsClaim[])[0]!;

describe('the schemas refuse', () => {
  const refused: [string, string, unknown][] = [
    ['a person with role member', `${U}record.json`, (() => { const r = userRecord('person.record.json'); return { ...r, fields: { ...r.fields, role: 'member' } }; })()],
    ['a stint that names a person', `${U}record.json`, (() => {
      const r = userRecord('workplace.record.json');
      return { ...r, fields: { ...r.fields, stints: [{ person: 'person_4c1029697ee358715d3a14a2add817c4', from: '2019-08' }] } };
    })()],
    ['a record without provenance', `${U}record.json`, (() => { const { provenance: _p, ...r } = userRecord('trip.record.json'); return r; })()],
    ['a record on the review list without a reason', `${U}record.json`, (() => { const { reviewReasons: _r, ...r } = userRecord('home.record.json'); return r; })()],
    ['a claim without method', `${U}claim.json`, (() => { const { method: _m, ...c } = userClaims()[0]!; return c; })()],
    ['a claim without generation', `${U}claim.json`, (() => { const { generation: _g, ...c } = userClaims()[0]!; return c; })()],
    ['a claim with an unknown field', `${U}claim.json`, { ...userClaims()[0]!, household: true }],
    ['a provenance entry that is neither a claim nor a correction', `${U}record.json`, { ...userRecord('trip.record.json'), provenance: { title: [{ app: 'photos' }] } }],
    ['an alternative with an unknown reason', `${U}record.json`, { ...userRecord('home.record.json'), alternatives: { to: [{ value: '2023-06', from: [{ correction: 'cor_5b0e8d7c2a9f4e61b3d07c58a1e2f946' }], reason: 'newer' }] } }],
    ['a user correction without createdAt', `${U}correction.json`, { id: 'cor_d0f631ca1ddba8db3bcfcb9e057cdc98', op: 'reject', record: 'trip_be3b7aabcbc567ddfdcace1a9d735bf4', app: 'photos' }],
    ['a user correction with an id of the wrong form', `${U}correction.json`, { id: 'cor_1', op: 'reject', record: 'trip_be3b7aabcbc567ddfdcace1a9d735bf4', app: 'photos', createdAt: '2026-11-20T17:40:31Z' }],
    ['a Contacts claim without a subject', `${C}claim.json`, (() => { const { subject: _s, ...c } = contactsClaim('claims-write.request.json'); return c; })()],
    ['a handle subject without the time of its evidence', `${C}claim.json`, { ...contactsClaim('conversations-identities-claims-write.request.json'), subject: { handle: '+12015550147' } }],
    ['a Contacts subject with two identities', `${C}claim.json`, { ...contactsClaim('claims-write.request.json'), subject: { card: 'card_89548698ab5ef8c33b1bf5e6f011405f', handle: '+12015550147' } }],
    ['a relation claim without the other person', `${C}claim.json`, (() => { const { other: _o, ...c } = contactsClaim('photos-relations-claims-write.request.json'); return c; })()],
    ['a home claim with another person', `${C}claim.json`, { ...contactsClaim('claims-write.request.json'), other: { person: 'person_bb472edb86809a761936d90c70aeb434' } }],
    ['a home record without its person', `${C}record.json`, (() => { const { person: _p, ...r } = contactsRecord('home.record.json'); return r; })()],
    ['a home record with mergedInto', `${C}record.json`, { ...contactsRecord('home.record.json'), mergedInto: 'person_bb472edb86809a761936d90c70aeb434' }],
    ['a person record about a person', `${C}record.json`, { ...contactsRecord('person.record.json'), person: 'person_bb472edb86809a761936d90c70aeb434' }],
    ['a home with no address, town, or location', `${C}home.json`, { label: 'home' }],
    ['a pin of three persons', `${C}correction.json`, {
      id: 'cor_0123456789abcdef0123456789abcdef', op: 'pin', app: 'contacts', createdAt: '2026-11-21T11:02:00Z',
      records: ['person_bb472edb86809a761936d90c70aeb434', 'person_1a82856897e2b43e6a9500d987493ca5', 'person_0123456789abcdef0123456789abcdef'],
    }],
    ['an unmerge of a home', `${C}correction.json`, { id: 'cor_0123456789abcdef0123456789abcdef', op: 'unmerge', app: 'contacts', createdAt: '2026-11-22T08:00:00Z', record: 'home_0123456789abcdef0123456789abcdef' }],
    ['a create of a home without its person', `${C}correction.json`, {
      id: 'cor_0123456789abcdef0123456789abcdef', op: 'create', kind: 'home', fields: { town: 'Trondheim' }, app: 'photos', createdAt: '2026-11-21T10:00:00Z',
    }],
    ['a list edit with an unknown key', 'schemas/facts/facts.json#/$defs/listEdit', { add: [1], replace: [2] }],
    ['an empty list edit', 'schemas/facts/facts.json#/$defs/listEdit', {}],
  ];
  for (const [what, schema, value] of refused) {
    it(what, () => {
      expect(check(schema, value)).not.toEqual([]);
    });
  }

  it('but accept a list edit in a set correction', () => {
    const c = (fixture('contracts/fixtures/user/corrections-list-edit.request.json').corrections as UserCorrection[])[0]!;
    expect(check('schemas/facts/facts.json#/$defs/listEdit', c.fields!.participants)).toEqual([]);
  });
});

describe('the TypeScript types', () => {
  it('describe the fixtures', () => {
    // Compile-time: these assignments check that the fixtures' shapes and the types agree on the
    // names that apps read. The runtime checks above are the schema checks.
    const trip: UserRecord = userRecord('trip.record.json');
    const facts: FactsRecord = trip;
    const home: ContactsRecord = contactsRecord('home.record.json');
    const change = (fixture('contracts/fixtures/contacts/changes-list.response.json').items as ContactsChange[])[2]!;
    const userChange = (fixture('contracts/fixtures/user/changes-list.response.json').items as UserChange[])[0]!;
    const correction = (fixture('contracts/fixtures/contacts/corrections-write.request.json').corrections as ContactsCorrection[])[0]!;
    expect(facts.provenance.title).toEqual([{ correction: 'cor_d0f631ca1ddba8db3bcfcb9e057cdc98' }]);
    expect(home.person).toMatch(/^person_/);
    expect(change.mergedInto).toBe(home.id);
    expect(userChange.record?.kind).toBe('trip');
    expect(correction.createdAt).toMatch(/Z$/);
  });
});
