// Generated from openapi/contacts.v1.yaml by scripts/generate.mjs. Do not edit.
// The sha256 of the contract file (LF line ends): 3bfc5031226b251c8e904fdc5c8824738d92057105f6a4685ab7824ee4d40b83

export const CONTACTS_CONTRACT_SHA256 = "3bfc5031226b251c8e904fdc5c8824738d92057105f6a4685ab7824ee4d40b83";

/** The one error body of every Memex HTTP API, MCP tool error, and CLI --json failure. See contracts/surfaces.md. */
export interface ContactsErrorBody {
  error: ContactsErrorDetail;
}

export interface ContactsErrorDetail {
  code: string;
  message: string;
  field?: string;
  hint?: string;
}

/** One fact about a person, made from claims and corrections, with provenance per field and the values that lost. See contracts/contacts-records.md and contracts/facts.md. */
export interface ContactsRecord {
  id: string;
  kind: "person" | "home" | "workplace" | "circle" | "relation" | "date" | "identity";
  version: number;
  state: "active" | "rejected";
  origin: "inferred" | "user";
  /** The person that the record is about. Not on a person record. */
  person?: string;
  /** The other person of a relation, or of a date that links two persons. */
  other?: string;
  /** Only on a person record: the person that this one was merged into. The record stays as a redirect, so that an unmerge works. */
  mergedInto?: string;
  confidence: number;
  review: boolean;
  reviewReasons?: Array<"low-confidence" | "conflict" | "suggested-end" | "gap" | "possible-duplicate">;
  fields: Record<string, unknown>;
  /** For each field, and each element of a list field, the claims or the correction that gave it. */
  provenance: Record<string, ContactsOrigin[]>;
  /** For each field, the values that lost. They stay, so that a reader or the person can choose one. */
  alternatives: Record<string, ContactsAlternative[]>;
  corrected: string[];
  claims: ContactsRecordClaimsItem[];
  sources: ContactsRef[];
  createdAt: string;
  updatedAt: string;
}

/** What gave a value: a claim, or a correction. */
export interface ContactsOrigin {
  /** <app>.<kinds>. Each hub limits the kinds. */
  scope?: string;
  partition?: string;
  key?: string;
  correction?: string;
}

export interface ContactsAlternative {
  /** The value that the record does not show. */
  value: unknown;
  from: ContactsOrigin[];
  /** weaker: a stronger claim or a correction won. coarser: the bound of a claim at a coarser precision. conflict: partial dates that do not refine each other. suggested-end: an end that a later record in another town suggests; the engine never sets it. */
  reason: "weaker" | "coarser" | "conflict" | "suggested-end";
}

export interface ContactsRecordClaimsItem {
  /** <app>.<kinds>, for example contacts.homes or photos.circles. contacts.persons is for Contacts itself. */
  scope: string;
  partition?: string;
  key: string;
  confidence: number;
  /** When the evidence was observed: the first and the last time. It says nothing about when the fact was true. */
  seen?: ContactsSeen;
}

/** When the evidence was observed: the first and the last time. It says nothing about when the fact was true. */
export interface ContactsSeen {
  first: string;
  last: string;
}

/** A record in an app. */
export interface ContactsRef {
  app: string;
  kind: string;
  id: string;
}

/** A fact about a person as one app infers it, with its subject. See contracts/contacts-records.md and contracts/facts.md. */
export interface ContactsClaim {
  key: string;
  /** The kinds that claims can have. Only Contacts itself writes person claims (scope contacts.persons, one per source card). */
  kind: "person" | "home" | "workplace" | "circle" | "relation" | "date" | "identity";
  /** The identity that the producer knows. Contacts resolves it to a person at fusion, and again after each merge, unmerge, or handle correction. A shared or unparsed handle never resolves. */
  subject: ContactsSubject;
  /** The second identity: required for a relation, allowed for a date that links two persons. */
  other?: ContactsSubject;
  confidence: number;
  /** The rule or model and its version, for example rule:trip-nearness/2 or card:vcard/1. */
  method: string;
  /** Goes up with each run of the producer. A hub refuses a write with a lower generation than the last one of the scope or partition. */
  generation: number;
  /** When the evidence was observed: the first and the last time. It says nothing about when the fact was true. */
  seen?: ContactsSeen;
  fields: Record<string, unknown>;
  sources: ContactsRef[];
}

/** The identity that the producer knows. Contacts resolves it to a person at fusion, and again after each merge, unmerge, or handle correction. A shared or unparsed handle never resolves. */
export interface ContactsSubject {
  /** A Contacts person. A merged person keeps its id as a redirect (mergedInto). */
  person?: string;
  /** A source card in Contacts: one card of one address book, over all its revisions. */
  card?: string;
  /** A normalized handle: E.164 for a phone, a lowercase address for e-mail, or <service>:<name>, as contracts/message.md normalizes them. */
  handle?: string;
  /** The time of the evidence, so that a reused number resolves by its date. */
  at?: string;
}

/** A decision of the person about a Contacts record. Inference never changes it. The app makes id and createdAt when the person acts. See contracts/contacts-records.md and contracts/facts.md. */
export interface ContactsCorrection {
  id: string;
  op: "set" | "clear" | "reject" | "restore" | "merge" | "create" | "unmerge" | "pin" | "unpin";
  /** The app in which the person acted. */
  app: string;
  /** The time at which the person acted, not the time of the send. */
  createdAt: string;
  /** The record that the correction changes. unmerge: the merged person. create: the new record, in the stored form. */
  record?: string;
  /** merge: records of one kind; the first id stays, and merged persons keep a redirect. pin and unpin: exactly two persons. */
  records?: string[];
  kind?: "person" | "home" | "workplace" | "circle" | "relation" | "date" | "identity";
  /** create of a kind other than person: the person that the new record is about. */
  person?: string;
  /** create of a relation (required) or a date: the other person. */
  other?: string;
  /** set: the fields to set; a list field can instead take {add, remove}. create: all fields of the kind. */
  fields?: Record<string, unknown>;
  names?: string[];
  /** create only: the app's own records that the new record comes from. */
  sources?: ContactsRef[];
  /** Set by Contacts when it stores the correction: the claim keys of its record then. An app does not send it. */
  anchors?: ContactsClaimRef[];
}

/** One claim of a producer. */
export interface ContactsClaimRef {
  /** <app>.<kinds>. Each hub limits the kinds. */
  scope: string;
  partition?: string;
  key: string;
}

/** One entry of the change feed (contacts.changes.list). See contracts/contacts-records.md. */
export interface ContactsChange {
  cursor: string;
  op: "upsert" | "remove";
  id: string;
  kind: "person" | "home" | "workplace" | "circle" | "relation" | "date" | "identity";
  /** The person that the record is about; for a person record, its own id. A reader filters by it. */
  person?: string;
  version: number;
  at: string;
  /** One fact about a person, made from claims and corrections, with provenance per field and the values that lost. See contracts/contacts-records.md and contracts/facts.md. */
  record?: ContactsRecord;
  /** remove: the record that this one was merged into. */
  mergedInto?: string;
}

export interface ContactsClaimsWriteInput {
  /** <app>.<kinds>, for example contacts.homes or photos.circles. contacts.persons is for Contacts itself. */
  scope: string;
  partition?: string;
  /** Every claim of the scope or partition. An empty list withdraws all of them. */
  claims: ContactsClaim[];
  /** The producer's run. Equal to the generation of the claims. Required with an empty claims list when the hub has a generation for the scope or partition. */
  generation?: number;
  /** Check and report; change nothing. */
  dryRun?: boolean;
  /** A repeat with the same key returns the first result. */
  idempotencyKey?: string;
}

export interface ContactsClaimsWriteOutput {
  /** null for dryRun, or when nothing changed. */
  changeId: string | null;
  summary: string;
  /** created, updated, unchanged, and removed count records; withdrawn and unresolved count claims. An unresolved claim is stored and joins a record when its subject resolves. */
  counts: ContactsClaimsWriteOutputCounts;
  /** The record id of each claim key whose subject resolves; null while it does not. */
  records: ContactsClaimsWriteOutputRecordsItem[];
}

/** created, updated, unchanged, and removed count records; withdrawn and unresolved count claims. An unresolved claim is stored and joins a record when its subject resolves. */
export interface ContactsClaimsWriteOutputCounts {
  created: number;
  updated: number;
  unchanged: number;
  withdrawn: number;
  removed: number;
  unresolved: number;
}

export interface ContactsClaimsWriteOutputRecordsItem {
  key: string;
  id: string | null;
}

export interface ContactsCorrectionsWriteInput {
  /** With the id and createdAt that the app made; without record for create. The outbox sends them in createdAt order. */
  corrections: ContactsCorrection[];
  /** Check and report; change nothing. */
  dryRun?: boolean;
}

export interface ContactsCorrectionsWriteOutput {
  /** null for dryRun, or when nothing new was stored. */
  changeId: string | null;
  summary: string;
  /** As stored, in request order. For a repeat, the correction that Contacts stored earlier, with its own id. */
  corrections: ContactsCorrection[];
  /** One result for each correction of the request, in request order. */
  results: ContactsCorrectionResult[];
}

export interface ContactsCorrectionResult {
  id: string;
  status: "applied" | "superseded" | "held";
  repeat: boolean;
  repeatOf?: string;
  /** The record that holds the fact now. For a merge, the first id; for an unmerge, the person that came back. */
  record?: string;
  version?: number;
  state?: "active" | "rejected";
  overridden?: string[];
  reason?: ContactsCorrectionResultReason;
}

export interface ContactsCorrectionResultReason {
  /** Why a hub stored a correction and did not apply it. not-merged is for Memex.Contacts only. */
  code: "required-field" | "record-rejected" | "record-removed" | "unknown-record" | "not-merged";
  /** A sentence for the app. */
  message: string;
}

export interface ContactsCorrectionsListInput {
  record?: string;
  limit?: number;
  /** next of the previous page. */
  cursor?: string;
}

export interface ContactsCorrectionsListOutput {
  items: ContactsCorrection[];
  /** null on the last page. */
  next: string | null;
}

export interface ContactsChangesListInput {
  /** The cursor of the last change that the app applied. Without it: every record. */
  since?: string;
  kinds?: Array<"person" | "home" | "workplace" | "circle" | "relation" | "date" | "identity">;
  /** A Contacts person. A merged person keeps its id as a redirect (mergedInto). */
  person?: string;
  limit?: number;
}

export interface ContactsChangesListOutput {
  items: ContactsChange[];
  /** null on the last page. */
  next: string | null;
}

export interface ContactsListInput {
  /** YYYY, YYYY-MM, or YYYY-MM-DD. */
  from?: string;
  /** YYYY, YYYY-MM, or YYYY-MM-DD. */
  to?: string;
  /** Records about this person. Contacts follows redirects, so a merged person's id finds the records of the person it was merged into. */
  person?: string;
  /** true: only records for the review list. */
  review?: boolean;
  includeRejected?: boolean;
  /** contacts.persons.list only: also list merged persons. */
  includeMerged?: boolean;
  limit?: number;
  /** next of the previous page. */
  cursor?: string;
}

export interface ContactsRecordPage {
  items: ContactsRecord[];
  /** null on the last page. */
  next: string | null;
}

export interface ContactsGetInput {
  id: string;
}

export interface ContactsRecordEnvelope {
  record: ContactsRecord;
}

/** A person in Contacts: who they are. Details over time are records of the other kinds. */
export interface ContactsPersonFields {
  name: string;
  otherNames?: string[];
  type?: "person" | "organization" | "unknown";
}

/** Where a person lives or lived, and who lived there with them. A card address gives seen, and no from or to. */
export interface ContactsHomeFields {
  type?: "home" | "cabin";
  label?: string;
  location?: ContactsLocation;
  address?: string;
  town?: string;
  /** ISO 3166-1 alpha-2. */
  country?: string;
  /** YYYY, YYYY-MM, or YYYY-MM-DD. */
  from?: string;
  /** YYYY, YYYY-MM, or YYYY-MM-DD. */
  to?: string;
  /** Other persons who lived there with the person. */
  residents?: ContactsResident[];
}

export interface ContactsLocation {
  lat: number;
  lon: number;
  radiusM?: number;
}

export interface ContactsResident {
  /** A Contacts person. A merged person keeps its id as a redirect (mergedInto). */
  person: string;
  /** YYYY, YYYY-MM, or YYYY-MM-DD. */
  from?: string;
  /** YYYY, YYYY-MM, or YYYY-MM-DD. */
  to?: string;
  child?: boolean;
}

/** Where a person works or studied: its sites, and the person's stints there. */
export interface ContactsWorkplaceFields {
  name: string;
  type?: "employer" | "client" | "own" | "school";
  sites?: ContactsWorkplaceFieldsSitesItem[];
  stints?: ContactsWorkplaceFieldsStintsItem[];
}

export interface ContactsWorkplaceFieldsSitesItem {
  location: ContactsLocation;
  label?: string;
  type?: "office" | "cabin" | "other";
}

export interface ContactsWorkplaceFieldsStintsItem {
  /** YYYY, YYYY-MM, or YYYY-MM-DD. */
  from?: string;
  /** YYYY, YYYY-MM, or YYYY-MM-DD. */
  to?: string;
  title?: string;
}

/** The person belongs to a named circle, for example family or the climbing crew. Circles gate views, not permissions. */
export interface ContactsCircleFields {
  name: string;
  /** YYYY, YYYY-MM, or YYYY-MM-DD. */
  from?: string;
  /** YYYY, YYYY-MM, or YYYY-MM-DD. */
  to?: string;
}

/** A typed edge from the person to the other person of the record. A former partner is history, not deletion. */
export interface ContactsRelationFields {
  type: "partner" | "parent" | "child" | "sibling" | "family" | "friend" | "colleague" | "other";
  label?: string;
  /** YYYY, YYYY-MM, or YYYY-MM-DD. */
  from?: string;
  /** YYYY, YYYY-MM, or YYYY-MM-DD. */
  to?: string;
}

/** A date of the person, for example a birthday. An anniversary or a first meeting can name the other person of the record. */
export interface ContactsDateFields {
  type: "birthday" | "anniversary" | "memorial" | "firstMet" | "other";
  /** YYYY, YYYY-MM, YYYY-MM-DD, or --MM-DD when the year is unknown. */
  date: string;
  label?: string;
}

/** A handle of the person: how evidence finds them. from and to resolve a reused number by the date of the evidence. */
export interface ContactsIdentityFields {
  type: "email" | "phone" | "handle";
  /** A normalized handle: E.164 for a phone, a lowercase address for e-mail, or <service>:<name>, as contracts/message.md normalizes them. */
  value: string;
  /** For a handle: the service, for example signal. */
  service?: string;
  label?: string;
  /** YYYY, YYYY-MM, or YYYY-MM-DD. */
  from?: string;
  /** YYYY, YYYY-MM, or YYYY-MM-DD. */
  to?: string;
  /** true when evidence shows that more than one person uses it, for example a family address. A shared identity never resolves evidence to one person. */
  shared?: boolean;
}

/** The type name of each component schema of the contract. */
export const CONTACTS_COMPONENT_TYPES = {
  Error: "ContactsErrorBody",
  Record: "ContactsRecord",
  Claim: "ContactsClaim",
  Correction: "ContactsCorrection",
  Change: "ContactsChange",
  ClaimsWriteInput: "ContactsClaimsWriteInput",
  ClaimsWriteOutput: "ContactsClaimsWriteOutput",
  CorrectionsWriteInput: "ContactsCorrectionsWriteInput",
  CorrectionsWriteOutput: "ContactsCorrectionsWriteOutput",
  CorrectionResult: "ContactsCorrectionResult",
  CorrectionsListInput: "ContactsCorrectionsListInput",
  CorrectionsListOutput: "ContactsCorrectionsListOutput",
  ChangesListInput: "ContactsChangesListInput",
  ChangesListOutput: "ContactsChangesListOutput",
  ListInput: "ContactsListInput",
  RecordPage: "ContactsRecordPage",
  GetInput: "ContactsGetInput",
  RecordEnvelope: "ContactsRecordEnvelope",
} as const;

/** The fields type of each record kind. */
export interface ContactsKindFields {
  person: ContactsPersonFields;
  home: ContactsHomeFields;
  workplace: ContactsWorkplaceFields;
  circle: ContactsCircleFields;
  relation: ContactsRelationFields;
  date: ContactsDateFields;
  identity: ContactsIdentityFields;
}

/** The record kinds of the hub. */
export type ContactsKind = keyof ContactsKindFields;

export const CONTACTS_KINDS: readonly ContactsKind[] = ["person", "home", "workplace", "circle", "relation", "date", "identity"];

/** One request of an operation, for ContactsApiBase.send. */
export interface ContactsOperationRequest {
  operation: string;
  method: "GET" | "POST";
  path: string;
  body?: unknown;
  /** false for /health, which takes no token. */
  auth: boolean;
}

/** Every operation of the contract: method and path. */
export const CONTACTS_OPERATIONS = {
  claimsWrite: { method: "POST", path: "/api/v1/contacts.claims.write" },
  correctionsWrite: { method: "POST", path: "/api/v1/contacts.corrections.write" },
  correctionsList: { method: "POST", path: "/api/v1/contacts.corrections.list" },
  changesList: { method: "POST", path: "/api/v1/contacts.changes.list" },
  personsList: { method: "POST", path: "/api/v1/contacts.persons.list" },
  personsGet: { method: "POST", path: "/api/v1/contacts.persons.get" },
  homesList: { method: "POST", path: "/api/v1/contacts.homes.list" },
  homesGet: { method: "POST", path: "/api/v1/contacts.homes.get" },
  workplacesList: { method: "POST", path: "/api/v1/contacts.workplaces.list" },
  workplacesGet: { method: "POST", path: "/api/v1/contacts.workplaces.get" },
  circlesList: { method: "POST", path: "/api/v1/contacts.circles.list" },
  circlesGet: { method: "POST", path: "/api/v1/contacts.circles.get" },
  relationsList: { method: "POST", path: "/api/v1/contacts.relations.list" },
  relationsGet: { method: "POST", path: "/api/v1/contacts.relations.get" },
  datesList: { method: "POST", path: "/api/v1/contacts.dates.list" },
  datesGet: { method: "POST", path: "/api/v1/contacts.dates.get" },
  identitiesList: { method: "POST", path: "/api/v1/contacts.identities.list" },
  identitiesGet: { method: "POST", path: "/api/v1/contacts.identities.get" },
} as const;

export type ContactsOperation = keyof typeof CONTACTS_OPERATIONS;

/** The operations of the Memex.Contacts API as methods. A subclass sends the requests. */
export abstract class ContactsApiBase {
  protected abstract send(request: ContactsOperationRequest): Promise<unknown>;

  /** contacts.claims.write (POST /api/v1/contacts.claims.write) */
  claimsWrite(body: ContactsClaimsWriteInput): Promise<ContactsClaimsWriteOutput> {
    return this.send({ operation: "claimsWrite", method: "POST", path: "/api/v1/contacts.claims.write", body, auth: true }) as Promise<ContactsClaimsWriteOutput>;
  }

  /** contacts.corrections.write (POST /api/v1/contacts.corrections.write) */
  correctionsWrite(body: ContactsCorrectionsWriteInput): Promise<ContactsCorrectionsWriteOutput> {
    return this.send({ operation: "correctionsWrite", method: "POST", path: "/api/v1/contacts.corrections.write", body, auth: true }) as Promise<ContactsCorrectionsWriteOutput>;
  }

  /** contacts.corrections.list (POST /api/v1/contacts.corrections.list) */
  correctionsList(body: ContactsCorrectionsListInput): Promise<ContactsCorrectionsListOutput> {
    return this.send({ operation: "correctionsList", method: "POST", path: "/api/v1/contacts.corrections.list", body, auth: true }) as Promise<ContactsCorrectionsListOutput>;
  }

  /** contacts.changes.list (POST /api/v1/contacts.changes.list) */
  changesList(body: ContactsChangesListInput): Promise<ContactsChangesListOutput> {
    return this.send({ operation: "changesList", method: "POST", path: "/api/v1/contacts.changes.list", body, auth: true }) as Promise<ContactsChangesListOutput>;
  }

  /** contacts.persons.list (POST /api/v1/contacts.persons.list) */
  personsList(body: ContactsListInput): Promise<ContactsRecordPage> {
    return this.send({ operation: "personsList", method: "POST", path: "/api/v1/contacts.persons.list", body, auth: true }) as Promise<ContactsRecordPage>;
  }

  /** contacts.persons.get (POST /api/v1/contacts.persons.get) */
  personsGet(body: ContactsGetInput): Promise<ContactsRecordEnvelope> {
    return this.send({ operation: "personsGet", method: "POST", path: "/api/v1/contacts.persons.get", body, auth: true }) as Promise<ContactsRecordEnvelope>;
  }

  /** contacts.homes.list (POST /api/v1/contacts.homes.list) */
  homesList(body: ContactsListInput): Promise<ContactsRecordPage> {
    return this.send({ operation: "homesList", method: "POST", path: "/api/v1/contacts.homes.list", body, auth: true }) as Promise<ContactsRecordPage>;
  }

  /** contacts.homes.get (POST /api/v1/contacts.homes.get) */
  homesGet(body: ContactsGetInput): Promise<ContactsRecordEnvelope> {
    return this.send({ operation: "homesGet", method: "POST", path: "/api/v1/contacts.homes.get", body, auth: true }) as Promise<ContactsRecordEnvelope>;
  }

  /** contacts.workplaces.list (POST /api/v1/contacts.workplaces.list) */
  workplacesList(body: ContactsListInput): Promise<ContactsRecordPage> {
    return this.send({ operation: "workplacesList", method: "POST", path: "/api/v1/contacts.workplaces.list", body, auth: true }) as Promise<ContactsRecordPage>;
  }

  /** contacts.workplaces.get (POST /api/v1/contacts.workplaces.get) */
  workplacesGet(body: ContactsGetInput): Promise<ContactsRecordEnvelope> {
    return this.send({ operation: "workplacesGet", method: "POST", path: "/api/v1/contacts.workplaces.get", body, auth: true }) as Promise<ContactsRecordEnvelope>;
  }

  /** contacts.circles.list (POST /api/v1/contacts.circles.list) */
  circlesList(body: ContactsListInput): Promise<ContactsRecordPage> {
    return this.send({ operation: "circlesList", method: "POST", path: "/api/v1/contacts.circles.list", body, auth: true }) as Promise<ContactsRecordPage>;
  }

  /** contacts.circles.get (POST /api/v1/contacts.circles.get) */
  circlesGet(body: ContactsGetInput): Promise<ContactsRecordEnvelope> {
    return this.send({ operation: "circlesGet", method: "POST", path: "/api/v1/contacts.circles.get", body, auth: true }) as Promise<ContactsRecordEnvelope>;
  }

  /** contacts.relations.list (POST /api/v1/contacts.relations.list) */
  relationsList(body: ContactsListInput): Promise<ContactsRecordPage> {
    return this.send({ operation: "relationsList", method: "POST", path: "/api/v1/contacts.relations.list", body, auth: true }) as Promise<ContactsRecordPage>;
  }

  /** contacts.relations.get (POST /api/v1/contacts.relations.get) */
  relationsGet(body: ContactsGetInput): Promise<ContactsRecordEnvelope> {
    return this.send({ operation: "relationsGet", method: "POST", path: "/api/v1/contacts.relations.get", body, auth: true }) as Promise<ContactsRecordEnvelope>;
  }

  /** contacts.dates.list (POST /api/v1/contacts.dates.list) */
  datesList(body: ContactsListInput): Promise<ContactsRecordPage> {
    return this.send({ operation: "datesList", method: "POST", path: "/api/v1/contacts.dates.list", body, auth: true }) as Promise<ContactsRecordPage>;
  }

  /** contacts.dates.get (POST /api/v1/contacts.dates.get) */
  datesGet(body: ContactsGetInput): Promise<ContactsRecordEnvelope> {
    return this.send({ operation: "datesGet", method: "POST", path: "/api/v1/contacts.dates.get", body, auth: true }) as Promise<ContactsRecordEnvelope>;
  }

  /** contacts.identities.list (POST /api/v1/contacts.identities.list) */
  identitiesList(body: ContactsListInput): Promise<ContactsRecordPage> {
    return this.send({ operation: "identitiesList", method: "POST", path: "/api/v1/contacts.identities.list", body, auth: true }) as Promise<ContactsRecordPage>;
  }

  /** contacts.identities.get (POST /api/v1/contacts.identities.get) */
  identitiesGet(body: ContactsGetInput): Promise<ContactsRecordEnvelope> {
    return this.send({ operation: "identitiesGet", method: "POST", path: "/api/v1/contacts.identities.get", body, auth: true }) as Promise<ContactsRecordEnvelope>;
  }
}
