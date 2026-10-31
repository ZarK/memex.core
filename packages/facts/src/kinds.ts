// Kind rules: what a hub registers for each of its kinds. The engine reads the
// fields, the required fields, the lists, the spans, the partial dates that
// refine, the precision, and the join rule from here, so both hubs run the same
// code with their own kinds (contracts/facts.md, user-records.md v2,
// contacts-records.md).
import {
  gapDays,
  isLocation,
  isObject,
  near,
  normalizeText,
  sameValue,
  type Interval,
} from './values.js';
import { makeChecker } from './json-schema.js';
import { KIND_SCHEMAS } from './kind-schemas.js';

/** One claim (or a record that the person made) as a join rule sees it. */
export interface JoinItem {
  fields: Record<string, unknown>;
  /** When the fact was true, or else when its evidence was seen. Missing: no time is known. */
  span?: Interval;
  /** The resolved second person of a relation or a date (Memex.Contacts). */
  other?: string | null;
}

/** A group of claims that will become one record. */
export interface JoinCluster {
  id: string;
  items: JoinItem[];
}

/**
 * Which clusters a new item may join, in the order given. The engine picks the
 * cluster that the claim was in before, if it is among them, else the first.
 */
export type JoinFunction = (item: JoinItem, clusters: readonly JoinCluster[]) => JoinCluster[];

export type JoinRule =
  | { rule: 'never' }
  /** The same values in these fields (text compares normalized); with `other`, the same second person. */
  | { rule: 'same'; fields: string[]; other?: boolean }
  /** Homes: the same normalized address, or locations within the radius; spans less than gapDays apart. */
  | { rule: 'home'; radiusM?: number; gapDays?: number }
  /** Workplaces: the same normalized name, or a site within the radius. */
  | { rule: 'workplace'; radiusM?: number }
  /** Places and stays: locations within the radius, and times that overlap when both have them. */
  | { rule: 'near'; radiusM?: number }
  /** Trips: overlapping days and a shared destination town or country, or a shared participant. */
  | { rule: 'trip' }
  | { rule: 'custom'; candidates: JoinFunction };

export interface SpanRule {
  from: string;
  to: string;
  /** date: partial dates; day: local dates; time: UTC times. */
  type: 'date' | 'day' | 'time';
}

export interface KindRule {
  kind: string;
  /** The plural that scopes and list capabilities use: photos.trips. */
  plural: string;
  /** The fields of the kind, in the order in which records list them. */
  fields: string[];
  required: string[];
  /** At least one of these fields must have a value. */
  requireOneOf?: string[];
  /** List fields: the union of the claims, with provenance per element and { add, remove } edits. */
  lists?: string[];
  /** Spans: the union of the claims at confidence 0.5 or higher and at the record's precision. */
  spans?: SpanRule[];
  /** Single partial dates that refine: 1984 and 1984-03-12 give 1984-03-12. */
  refine?: string[];
  /** How precise a claim's place is, for example 3 for an address, 2 for a town. A coarser claim's bounds go to alternatives. */
  precision?: (fields: Record<string, unknown>) => number;
  join: JoinRule;
  /** remove (default): a merged record is removed with mergedInto. redirect: it stays with mergedInto (Contacts persons). */
  merge?: 'remove' | 'redirect';
  /** An open-ended record that overlaps a later record in another town goes to review with the suggested end (homes). */
  suggestEnd?: boolean;
  /** A pin without a street and a text address of one subject are possibly the same (homes). */
  pinAddressDuplicates?: boolean;
  /** Memex.Contacts: whether claims carry `other`, the second subject. */
  other?: 'required' | 'optional';
}

export type HubSubjects = 'owner' | 'contacts';

export interface HubDefinition {
  /** user or contacts: the hub's name, for messages and the outbox. */
  name: string;
  /** owner: every claim is about the owner (Memex.User). contacts: claims have a subject that resolves to a person. */
  subjects: HubSubjects;
  kinds: KindRule[];
  /** Operations beyond the six of facts.md: unmerge, pin, unpin (Memex.Contacts). */
  extraOps?: ('unmerge' | 'pin' | 'unpin')[];
  /**
   * The errors of field values against the kind's schema; none means valid. With a field
   * name, it checks one value of that field (a set); without, a whole fields object.
   */
  fieldErrors?: (kind: string, fields: Record<string, unknown>, field?: string) => string[];
}

const checkSchema = makeChecker(KIND_SCHEMAS);

/** Field checks against the contract schemas in schemas/<dir>/<kind>.json. */
function contractFields(dir: 'user' | 'contacts'): NonNullable<HubDefinition['fieldErrors']> {
  return (kind, fields, field) =>
    field === undefined
      ? checkSchema(`schemas/${dir}/${kind}.json`, fields)
      : checkSchema(`schemas/${dir}/${kind}.json#/properties/${field}`, fields[field]).map((e) => `/${field}${e}`);
}

// ---- Join rules ----

const DEFAULT_RADIUS_M = 150;
const DEFAULT_GAP_DAYS = 90;

function spanNear(a: JoinItem, b: JoinItem, maxGapDays: number): boolean {
  if (!a.span || !b.span) return true;
  return gapDays(a.span, b.span) < maxGapDays;
}

function overlaps(a: JoinItem, b: JoinItem): boolean {
  if (!a.span || !b.span) return true;
  return gapDays(a.span, b.span) <= 0;
}

const isPrecise = (f: Record<string, unknown>) => normalizeText(f.address) !== undefined || isLocation(f.location);

function homeJoin(radiusM: number, maxGap: number): JoinFunction {
  const precisePair = (a: JoinItem, b: JoinItem) => {
    if (!spanNear(a, b, maxGap)) return false;
    // The same normalized address, or locations within the radius. A pin and a text address
    // without a pin join only through the address of the pin.
    const aa = normalizeText(a.fields.address);
    const ba = normalizeText(b.fields.address);
    if (aa !== undefined && aa === ba) return true;
    return isLocation(a.fields.location) && isLocation(b.fields.location) && near(a.fields.location, b.fields.location, radiusM);
  };
  const sameTown = (a: JoinItem, b: JoinItem) => {
    const t = normalizeText(a.fields.town);
    return t !== undefined && t === normalizeText(b.fields.town) && spanNear(a, b, maxGap);
  };
  const townOnly = (c: JoinCluster) => c.items.every((i) => !isPrecise(i.fields));
  return (item, clusters) => {
    if (isPrecise(item.fields)) {
      const direct = clusters.filter((c) => c.items.some((i) => isPrecise(i.fields) && precisePair(item, i)));
      if (direct.length > 0) return direct;
      // A precise claim takes over a town-only record when it is the only one in that town.
      const towns = clusters.filter((c) => townOnly(c) && c.items.some((i) => sameTown(item, i)));
      return towns.length === 1 ? towns : [];
    }
    if (normalizeText(item.fields.town) === undefined) return [];
    // A town-only claim joins a precise record only when the subject has exactly one such record in that town.
    const precise = clusters.filter((c) => !townOnly(c) && c.items.some((i) => isPrecise(i.fields) && sameTown(item, i)));
    if (precise.length === 1) return precise;
    return clusters.filter((c) => townOnly(c) && c.items.some((i) => sameTown(item, i)));
  };
}

function workplaceJoin(radiusM: number): JoinFunction {
  const sites = (f: Record<string, unknown>) =>
    Array.isArray(f.sites) ? f.sites.filter((s) => isObject(s) && isLocation(s.location)).map((s) => (s as { location: never }).location) : [];
  return (item, clusters) =>
    clusters.filter((c) =>
      c.items.some((i) => {
        const n = normalizeText(item.fields.name);
        if (n !== undefined && n === normalizeText(i.fields.name)) return true;
        return sites(item.fields).some((a) => sites(i.fields).some((b) => near(a, b, radiusM)));
      }),
    );
}

function nearJoin(radiusM: number): JoinFunction {
  return (item, clusters) =>
    clusters.filter((c) =>
      c.items.some(
        (i) =>
          isLocation(item.fields.location) &&
          isLocation(i.fields.location) &&
          near(item.fields.location, i.fields.location, radiusM) &&
          overlaps(item, i),
      ),
    );
}

function tripPlaces(f: Record<string, unknown>): { towns: Set<string>; countries: Set<string> } {
  const towns = new Set<string>();
  const countries = new Set<string>();
  if (Array.isArray(f.countries)) for (const c of f.countries) if (typeof c === 'string') countries.add(c.toUpperCase());
  if (Array.isArray(f.destinations)) {
    for (const d of f.destinations) {
      if (!isObject(d)) continue;
      const t = normalizeText(d.town);
      if (t) towns.add(t);
      if (typeof d.country === 'string') countries.add(d.country.toUpperCase());
    }
  }
  return { towns, countries };
}

const tripJoin: JoinFunction = (item, clusters) => {
  const a = tripPlaces(item.fields);
  const people = Array.isArray(item.fields.participants) ? item.fields.participants : [];
  return clusters.filter((c) =>
    c.items.some((i) => {
      if (!item.span || !i.span || gapDays(item.span, i.span) > 0) return false;
      const b = tripPlaces(i.fields);
      if ([...a.towns].some((t) => b.towns.has(t))) return true;
      if ([...a.countries].some((t) => b.countries.has(t))) return true;
      const others = Array.isArray(i.fields.participants) ? i.fields.participants : [];
      return people.some((p) => others.some((q) => sameValue(p, q)));
    }),
  );
};

function sameJoin(fields: readonly string[], withOther: boolean): JoinFunction {
  const norm = (v: unknown) => (typeof v === 'string' ? normalizeText(v) : v === undefined ? undefined : JSON.stringify(v));
  return (item, clusters) =>
    clusters.filter((c) =>
      c.items.some(
        (i) =>
          fields.every((f) => {
            const a = norm(item.fields[f]);
            return a !== undefined && a === norm(i.fields[f]);
          }) && (!withOther || (item.other ?? null) === (i.other ?? null)),
      ),
    );
}

/** The join function of a kind rule. */
export function joinFunction(rule: JoinRule): JoinFunction {
  switch (rule.rule) {
    case 'never':
      return () => [];
    case 'same':
      return sameJoin(rule.fields, rule.other ?? false);
    case 'home':
      return homeJoin(rule.radiusM ?? DEFAULT_RADIUS_M, rule.gapDays ?? DEFAULT_GAP_DAYS);
    case 'workplace':
      return workplaceJoin(rule.radiusM ?? DEFAULT_RADIUS_M);
    case 'near':
      return nearJoin(rule.radiusM ?? DEFAULT_RADIUS_M);
    case 'trip':
      return tripJoin;
    case 'custom':
      return rule.candidates;
  }
}

/** Address or pin 3, town 2, country 1. */
export function placePrecision(f: Record<string, unknown>): number {
  if (isPrecise(f)) return 3;
  if (normalizeText(f.town) !== undefined) return 2;
  if (typeof f.country === 'string') return 1;
  return 0;
}

// ---- The kinds of Memex.User (user-records.md v2) ----

export const userKinds: KindRule[] = [
  {
    kind: 'person',
    plural: 'persons',
    fields: ['name', 'role', 'contact'],
    required: ['name', 'role'],
    join: { rule: 'same', fields: ['contact'] },
  },
  {
    kind: 'home',
    plural: 'homes',
    fields: ['type', 'label', 'location', 'address', 'town', 'country', 'from', 'to', 'members'],
    required: ['type'],
    lists: ['members'],
    spans: [{ from: 'from', to: 'to', type: 'date' }],
    precision: placePrecision,
    join: { rule: 'home' },
    suggestEnd: true,
    pinAddressDuplicates: true,
  },
  {
    kind: 'workplace',
    plural: 'workplaces',
    fields: ['name', 'type', 'sites', 'stints'],
    required: ['name', 'type'],
    lists: ['sites', 'stints'],
    join: { rule: 'workplace' },
  },
  {
    kind: 'place',
    plural: 'places',
    fields: ['name', 'type', 'location', 'address', 'town', 'country'],
    required: ['name', 'type', 'location'],
    join: { rule: 'near' },
  },
  {
    kind: 'stay',
    plural: 'stays',
    fields: ['arrival', 'departure', 'location', 'name', 'place', 'timeZone'],
    required: ['arrival', 'departure', 'location'],
    spans: [{ from: 'arrival', to: 'departure', type: 'time' }],
    join: { rule: 'near' },
  },
  {
    kind: 'trip',
    plural: 'trips',
    fields: ['title', 'firstDay', 'lastDay', 'destinations', 'countries', 'participants', 'home'],
    required: ['title', 'firstDay', 'lastDay'],
    lists: ['destinations', 'countries', 'participants'],
    spans: [{ from: 'firstDay', to: 'lastDay', type: 'day' }],
    join: { rule: 'trip' },
  },
  {
    kind: 'chapter',
    plural: 'chapters',
    fields: ['title', 'type', 'from', 'to', 'trip'],
    required: ['title', 'type', 'from'],
    spans: [{ from: 'from', to: 'to', type: 'date' }],
    join: { rule: 'never' },
  },
  {
    kind: 'milestone',
    plural: 'milestones',
    fields: ['title', 'date', 'persons'],
    required: ['title', 'date'],
    lists: ['persons'],
    refine: ['date'],
    join: { rule: 'never' },
  },
];

// ---- The kinds of Memex.Contacts (contacts-records.md) ----

export const contactsKinds: KindRule[] = [
  {
    kind: 'person',
    plural: 'persons',
    fields: ['name', 'otherNames', 'type'],
    required: ['name'],
    lists: ['otherNames'],
    join: { rule: 'never' },
    merge: 'redirect',
  },
  {
    kind: 'home',
    plural: 'homes',
    fields: ['type', 'label', 'location', 'address', 'town', 'country', 'from', 'to', 'residents'],
    required: [],
    requireOneOf: ['address', 'town', 'location'],
    lists: ['residents'],
    spans: [{ from: 'from', to: 'to', type: 'date' }],
    precision: placePrecision,
    join: { rule: 'home' },
    suggestEnd: true,
    pinAddressDuplicates: true,
  },
  {
    kind: 'workplace',
    plural: 'workplaces',
    fields: ['name', 'type', 'sites', 'stints'],
    required: ['name'],
    lists: ['sites', 'stints'],
    join: { rule: 'workplace' },
  },
  {
    kind: 'circle',
    plural: 'circles',
    fields: ['name', 'from', 'to'],
    required: ['name'],
    spans: [{ from: 'from', to: 'to', type: 'date' }],
    join: { rule: 'same', fields: ['name'] },
  },
  {
    kind: 'relation',
    plural: 'relations',
    fields: ['type', 'label', 'from', 'to'],
    required: ['type'],
    spans: [{ from: 'from', to: 'to', type: 'date' }],
    join: { rule: 'same', fields: ['type'], other: true },
    other: 'required',
  },
  {
    kind: 'date',
    plural: 'dates',
    fields: ['type', 'date', 'label'],
    required: ['type', 'date'],
    refine: ['date'],
    join: { rule: 'same', fields: ['type'], other: true },
    other: 'optional',
  },
  {
    kind: 'identity',
    plural: 'identities',
    fields: ['type', 'value', 'service', 'label', 'from', 'to', 'shared'],
    required: ['type', 'value'],
    spans: [{ from: 'from', to: 'to', type: 'date' }],
    join: { rule: 'same', fields: ['value'] },
  },
];

/** Memex.User: facts about the owner. */
export const userHub: HubDefinition = { name: 'user', subjects: 'owner', kinds: userKinds, fieldErrors: contractFields('user') };

/** Memex.Contacts: facts about other people, with subjects, person merges, and pins. */
export const contactsHub: HubDefinition = {
  name: 'contacts',
  subjects: 'contacts',
  kinds: contactsKinds,
  extraOps: ['unmerge', 'pin', 'unpin'],
  fieldErrors: contractFields('contacts'),
};
