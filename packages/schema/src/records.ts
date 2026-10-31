/**
 * Types for the records of Memex.User (contracts/user-records.md, version 2) and Memex.Contacts
 * (contracts/contacts-records.md), and for the shapes that both share (contracts/facts.md).
 * The JSON Schemas in schemas/user/, schemas/contacts/, and schemas/facts/ are canonical.
 */

/** A UTC time with Z, for example '2026-11-20T17:42:10Z'. */
export type UtcTime = string;
/** YYYY, YYYY-MM, or YYYY-MM-DD. */
export type PartialDate = string;
/** 'cor_' and 32 lowercase hex digits. */
export type CorrectionId = string;

/** A record in an app. */
export interface Ref {
  app: string;
  kind: string;
  id: string;
}

export interface Location {
  lat: number;
  lon: number;
  radiusM?: number;
}

// ---- Shared: contracts/facts.md ----

/** When the evidence was observed. It says nothing about when the fact was true. */
export interface Seen {
  first: UtcTime;
  last: UtcTime;
}

/** One claim of a producer. */
export interface ClaimRef {
  scope: string;
  partition?: string;
  key: string;
}

/** One correction of the person. */
export interface CorrectionRef {
  correction: CorrectionId;
}

/** What gave a value: a claim, or a correction. */
export type Origin = ClaimRef | CorrectionRef;

/** For each field, and each list element ('<field>/<index>'), what gave it. */
export type Provenance = Record<string, Origin[]>;

export type AlternativeReason = 'weaker' | 'coarser' | 'conflict' | 'suggested-end';

export interface Alternative {
  value: unknown;
  from: Origin[];
  reason: AlternativeReason;
}

/** For each field, the values that lost. */
export type Alternatives = Record<string, Alternative[]>;

export type ReviewReason = 'low-confidence' | 'conflict' | 'suggested-end' | 'gap' | 'possible-duplicate';

/** A set correction's value for a list field that edits the list instead of replacing it. */
export interface ListEdit<T = unknown> {
  add?: T[];
  remove?: T[];
}

export type HeldReason = 'required-field' | 'record-rejected' | 'record-removed' | 'unknown-record' | 'not-merged';

/** Is a value a list edit: an object with only add and remove, each a list? */
export function isListEdit(value: unknown): value is ListEdit {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return (
    keys.length > 0 &&
    keys.every((k) => (k === 'add' || k === 'remove') && Array.isArray((value as Record<string, unknown>)[k]))
  );
}

/** What a claim of either hub carries. */
export interface FactsClaim<K extends string = string, F = Record<string, unknown>> {
  key: string;
  kind: K;
  confidence: number;
  /** The rule or model and its version, for example 'rule:trip-nearness/2'. */
  method: string;
  /** Goes up with each run of the producer. */
  generation: number;
  seen?: Seen;
  fields: F;
  sources: Ref[];
}

/** A claim as a record lists it. */
export interface RecordClaim extends ClaimRef {
  confidence: number;
  seen?: Seen;
}

/** What a record of either hub carries. */
export interface FactsRecord<K extends string = string, F = Record<string, unknown>> {
  id: string;
  kind: K;
  version: number;
  state: 'active' | 'rejected';
  origin: 'inferred' | 'user';
  confidence: number;
  review: boolean;
  /** Only when review is true. */
  reviewReasons?: ReviewReason[];
  fields: F;
  provenance: Provenance;
  alternatives: Alternatives;
  corrected: string[];
  claims: RecordClaim[];
  sources: Ref[];
  createdAt: UtcTime;
  updatedAt: UtcTime;
}

export interface CorrectionResult {
  id: CorrectionId;
  status: 'applied' | 'superseded' | 'held';
  repeat: boolean;
  repeatOf?: CorrectionId;
  record?: string;
  version?: number;
  state?: 'active' | 'rejected';
  overridden?: string[];
  reason?: { code: HeldReason; message: string };
}

// ---- Memex.User: contracts/user-records.md ----

export type UserKind = 'person' | 'home' | 'workplace' | 'place' | 'stay' | 'trip' | 'chapter' | 'milestone';

/** A reference to a Contacts person. */
export interface ContactRef {
  app: 'contacts';
  kind: 'person';
  id: string;
}

/** The owner's person id, or a Contacts person. */
export type PersonRef = string | ContactRef;

export interface UserPersonFields {
  name: string;
  role: 'owner';
  contact?: ContactRef;
}

export interface UserHomeFields {
  type: 'home' | 'cabin';
  label?: string;
  location?: Location;
  address?: string;
  town?: string;
  country?: string;
  from?: PartialDate;
  to?: PartialDate;
  /** The people who lived there with the owner. */
  members?: { person: PersonRef; from?: PartialDate; to?: PartialDate; child?: boolean }[];
}

export interface Site {
  location: Location;
  label?: string;
  type?: 'office' | 'cabin' | 'other';
}

export interface UserWorkplaceFields {
  name: string;
  type: 'employer' | 'client' | 'own' | 'school';
  sites?: Site[];
  /** The owner's stints. */
  stints?: { from?: PartialDate; to?: PartialDate }[];
}

export interface UserPlaceFields {
  name: string;
  type: 'bar' | 'restaurant' | 'cafe' | 'shop' | 'sport' | 'culture' | 'hotel' | 'area' | 'spot' | 'other';
  location: Location;
  address?: string;
  town?: string;
  country?: string;
}

export interface UserStayFields {
  arrival: UtcTime;
  departure: UtcTime;
  location: Location;
  name?: string;
  place?: string;
  timeZone?: string;
}

export interface UserTripFields {
  title: string;
  firstDay: string;
  lastDay: string;
  destinations?: { name: string; town?: string; country?: string; location?: Location }[];
  countries?: string[];
  participants?: PersonRef[];
  home?: string;
}

export interface UserChapterFields {
  title: string;
  type: 'trip' | 'move' | 'project' | 'payoff' | 'period' | 'other';
  from: PartialDate;
  to?: PartialDate;
  trip?: string;
}

export interface UserMilestoneFields {
  title: string;
  date: PartialDate;
  persons?: PersonRef[];
}

export type UserRecord = FactsRecord<UserKind>;
export type UserClaim = FactsClaim<UserKind>;

export interface UserCorrection {
  id: CorrectionId;
  op: 'set' | 'clear' | 'reject' | 'restore' | 'merge' | 'create';
  app: string;
  createdAt: UtcTime;
  record?: string;
  records?: string[];
  kind?: UserKind;
  /** set: a list field can take a ListEdit. */
  fields?: Record<string, unknown>;
  names?: string[];
  sources?: Ref[];
  /** Set by the hub: the claim keys of the record when the correction was stored. */
  anchors?: ClaimRef[];
}

export interface UserChange {
  cursor: string;
  op: 'upsert' | 'remove';
  id: string;
  kind: UserKind;
  version: number;
  at: UtcTime;
  record?: UserRecord;
  mergedInto?: string;
}

// ---- Memex.Contacts: contracts/contacts-records.md ----

export type ContactsKind = 'person' | 'home' | 'workplace' | 'circle' | 'relation' | 'date' | 'identity';

/** The identity that a producer knows. Exactly one of person, card, or handle. */
export type Subject = { person: string } | { card: string } | { handle: string; at: UtcTime };

export interface ContactsPersonFields {
  name: string;
  otherNames?: string[];
  type?: 'person' | 'organization' | 'unknown';
}

export interface ContactsHomeFields {
  type?: 'home' | 'cabin';
  label?: string;
  location?: Location;
  address?: string;
  town?: string;
  country?: string;
  from?: PartialDate;
  to?: PartialDate;
  residents?: { person: string; from?: PartialDate; to?: PartialDate; child?: boolean }[];
}

export interface ContactsWorkplaceFields {
  name: string;
  type?: 'employer' | 'client' | 'own' | 'school';
  sites?: Site[];
  stints?: { from?: PartialDate; to?: PartialDate; title?: string }[];
}

export interface ContactsCircleFields {
  name: string;
  from?: PartialDate;
  to?: PartialDate;
}

export interface ContactsRelationFields {
  type: 'partner' | 'parent' | 'child' | 'sibling' | 'family' | 'friend' | 'colleague' | 'other';
  label?: string;
  from?: PartialDate;
  to?: PartialDate;
}

export interface ContactsDateFields {
  type: 'birthday' | 'anniversary' | 'memorial' | 'firstMet' | 'other';
  /** A partial date, or '--MM-DD' when the year is unknown. */
  date: string;
  label?: string;
}

export interface ContactsIdentityFields {
  type: 'email' | 'phone' | 'handle';
  value: string;
  service?: string;
  label?: string;
  from?: PartialDate;
  to?: PartialDate;
  shared?: boolean;
}

export interface ContactsClaim extends FactsClaim<ContactsKind> {
  subject: Subject;
  /** Required for a relation, allowed for a date. */
  other?: Subject;
}

export interface ContactsRecord extends FactsRecord<ContactsKind> {
  /** The person that the record is about. Not on a person record. */
  person?: string;
  /** The other person of a relation or a date. */
  other?: string;
  /** Only on a merged person record: the person it redirects to. */
  mergedInto?: string;
}

export interface ContactsCorrection {
  id: CorrectionId;
  op: 'set' | 'clear' | 'reject' | 'restore' | 'merge' | 'create' | 'unmerge' | 'pin' | 'unpin';
  app: string;
  createdAt: UtcTime;
  record?: string;
  records?: string[];
  kind?: ContactsKind;
  person?: string;
  other?: string;
  fields?: Record<string, unknown>;
  names?: string[];
  sources?: Ref[];
  anchors?: ClaimRef[];
}

export interface ContactsChange {
  cursor: string;
  op: 'upsert' | 'remove';
  id: string;
  kind: ContactsKind;
  /** The person that the record is about; for a person record, its own id. */
  person?: string;
  version: number;
  at: UtcTime;
  record?: ContactsRecord;
  mergedInto?: string;
}

/** Which hub an outbox item goes to. */
export type FactsHub = 'user' | 'contacts';
