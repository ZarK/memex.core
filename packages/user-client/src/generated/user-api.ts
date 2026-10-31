// Generated from openapi/user.v1.yaml by scripts/generate.mjs. Do not edit.
// The sha256 of the contract file (LF line ends): 369ab82facca6edd1fb7d85237b1e5fed3987ba4aeca7f272437988c28a24d66

export const USER_CONTRACT_SHA256 = "369ab82facca6edd1fb7d85237b1e5fed3987ba4aeca7f272437988c28a24d66";

/** The one error body of every Memex HTTP API, MCP tool error, and CLI --json failure. See contracts/surfaces.md. */
export interface UserErrorBody {
  error: UserErrorDetail;
}

export interface UserErrorDetail {
  code: string;
  message: string;
  field?: string;
  hint?: string;
}

export interface UserHealth {
  /** draining after POST /v1/drain: a newer copy takes over. A client reads the app record again. */
  status: "ok" | "draining";
  app: "user";
  version: string;
}

export interface UserDrain {
  draining: true;
  /** The process that drains. It exits when held is 0, or after the drain time. */
  pid: number;
  version: string;
  /** The calls that User still serves. */
  held: number;
}

export interface UserCapabilityList {
  app: "user";
  version: string;
  openapi: "/api/v1/openapi.json";
  capabilities: UserCapabilityListCapabilitiesItem[];
}

export interface UserCapabilityListCapabilitiesItem {
  id: string;
  title: string;
  kind: "read" | "write";
  description: string;
}

/** One fact, made from claims and corrections, with provenance per field and the values that lost. See contracts/user-records.md and contracts/facts.md. */
export interface UserRecord {
  id: string;
  kind: "person" | "home" | "workplace" | "place" | "stay" | "trip" | "chapter" | "milestone";
  version: number;
  state: "active" | "rejected";
  origin: "inferred" | "user";
  confidence: number;
  review: boolean;
  reviewReasons?: Array<"low-confidence" | "conflict" | "suggested-end" | "gap" | "possible-duplicate">;
  fields: Record<string, unknown>;
  /** For each field, and each element of a list field, the claims or the correction that gave it. */
  provenance: Record<string, UserOrigin[]>;
  /** For each field, the values that lost. They stay, so that a reader or the person can choose one. */
  alternatives: Record<string, UserAlternative[]>;
  corrected: string[];
  claims: UserRecordClaimsItem[];
  sources: UserRef[];
  createdAt: string;
  updatedAt: string;
}

/** What gave a value: a claim, or a correction. */
export interface UserOrigin {
  /** <app>.<kinds>. Each hub limits the kinds. */
  scope?: string;
  partition?: string;
  key?: string;
  correction?: string;
}

export interface UserAlternative {
  /** The value that the record does not show. */
  value: unknown;
  from: UserOrigin[];
  /** weaker: a stronger claim or a correction won. coarser: the bound of a claim at a coarser precision. conflict: partial dates that do not refine each other. suggested-end: an end that a later record in another town suggests; the engine never sets it. */
  reason: "weaker" | "coarser" | "conflict" | "suggested-end";
}

export interface UserRecordClaimsItem {
  /** <app>.<kinds>, for example photos.trips. */
  scope: string;
  partition?: string;
  key: string;
  confidence: number;
  /** When the evidence was observed: the first and the last time. It says nothing about when the fact was true. */
  seen?: UserSeen;
}

/** When the evidence was observed: the first and the last time. It says nothing about when the fact was true. */
export interface UserSeen {
  first: string;
  last: string;
}

/** A record in an app. */
export interface UserRef {
  app: string;
  kind: string;
  id: string;
}

/** A fact as one app infers it, with when its evidence was seen, the method, and the producer's generation. See contracts/user-records.md and contracts/facts.md. */
export interface UserClaim {
  key: string;
  kind: "person" | "home" | "workplace" | "place" | "stay" | "trip" | "chapter" | "milestone";
  confidence: number;
  /** The rule or model and its version, for example rule:trip-nearness/2 or card:vcard/1. */
  method: string;
  /** Goes up with each run of the producer. A hub refuses a write with a lower generation than the last one of the scope or partition. */
  generation: number;
  /** When the evidence was observed: the first and the last time. It says nothing about when the fact was true. */
  seen?: UserSeen;
  fields: Record<string, unknown>;
  sources: UserRef[];
}

/** A decision of the user. Inference never changes it. The app makes id and createdAt when the person acts, and sends both in user.corrections.write. The input has no record for create. See contracts/user-records.md. */
export interface UserCorrection {
  /** The app makes it when the person acts, for example cor_ and a UUID v7 without dashes. User stores each id once: a write with an id that User has stored returns the earlier correction. */
  id: string;
  op: "set" | "clear" | "reject" | "restore" | "merge" | "create";
  /** The app in which the user acted. */
  app: string;
  /** The time at which the person acted, not the time of the send. User orders corrections by createdAt, then by arrival; for the same field of the same record, the later createdAt wins. */
  createdAt: string;
  /** The record that the correction changes. For create: the new record. */
  record?: string;
  /** merge: the first id stays. */
  records?: string[];
  kind?: "person" | "home" | "workplace" | "place" | "stay" | "trip" | "chapter" | "milestone";
  /** set: the fields to set; a list field can instead take {add, remove} (contracts/facts.md). create: all fields of the kind. */
  fields?: Record<string, unknown>;
  /** clear: the fields to give back to inference. A clear that leaves a required field of the kind without a value (no claim gives one), for example any required field of a record with origin user, is stored and not applied: its result is held with the reason required-field. */
  names?: string[];
  /** create only: the app's own records that the new record comes from, for example the Photos home. A create with sources is a repeat when an earlier create has the same kind, sources, and fields: User returns the earlier correction (record: the record that holds the fact now), makes no new record, and stores the new id as an alias of the earlier correction; the result has the new id and repeatOf; when that record is rejected, the result is held with the reason record-rejected. A create without sources is a repeat only by its id. */
  sources?: UserRef[];
  /** Set by User when it stores the correction: the claim keys of its record then. An app does not send it. After a rebuild, a correction whose record id is unknown attaches to the record that holds one of these keys. */
  anchors?: UserClaimRef[];
}

/** One claim of a producer. */
export interface UserClaimRef {
  /** <app>.<kinds>. Each hub limits the kinds. */
  scope: string;
  partition?: string;
  key: string;
}

/** One entry of the change feed (user.changes.list). See contracts/user-records.md. */
export interface UserChange {
  cursor: string;
  op: "upsert" | "remove";
  id: string;
  kind: "person" | "home" | "workplace" | "place" | "stay" | "trip" | "chapter" | "milestone";
  version: number;
  at: string;
  /** One fact, made from claims and corrections, with provenance per field and the values that lost. See contracts/user-records.md and contracts/facts.md. */
  record?: UserRecord;
  mergedInto?: string;
}

export interface UserClaimsWriteInput {
  /** <app>.<kinds>, for example photos.trips. */
  scope: string;
  partition?: string;
  /** Every claim of the scope or partition. An empty list withdraws all of them. */
  claims: UserClaim[];
  /** The producer's run. Equal to the generation of the claims. Required with an empty claims list when the hub has a generation for the scope or partition. */
  generation?: number;
  /** Check and report; change nothing. */
  dryRun?: boolean;
  /** A repeat with the same key returns the first result. */
  idempotencyKey?: string;
}

export interface UserClaimsWriteOutput {
  /** null for dryRun, or when nothing changed. */
  changeId: string | null;
  summary: string;
  /** created, updated, unchanged, and removed count records; withdrawn counts claims. */
  counts: UserClaimsWriteOutputCounts;
  /** The record id of each claim key. */
  records: UserClaimsWriteOutputRecordsItem[];
}

/** created, updated, unchanged, and removed count records; withdrawn counts claims. */
export interface UserClaimsWriteOutputCounts {
  created: number;
  updated: number;
  unchanged: number;
  withdrawn: number;
  removed: number;
}

export interface UserClaimsWriteOutputRecordsItem {
  key: string;
  id: string;
}

export interface UserClaimsListInput {
  /** <app>.<kinds>, for example photos.trips. */
  scope: string;
  partition?: string;
  limit?: number;
  /** next of the previous page. */
  cursor?: string;
}

export interface UserClaimsListOutput {
  items: UserClaimsListOutputItemsItem[];
  /** null on the last page. */
  next: string | null;
}

export interface UserClaimsListOutputItemsItem {
  scope: string;
  partition?: string;
  claim: UserClaim;
  record: string;
  writtenAt: string;
}

export interface UserCorrectionsWriteInput {
  /** With the id and createdAt that the app made; without record for create. The background sync sends them in createdAt order. */
  corrections: UserCorrection[];
  /** Check and report; change nothing. */
  dryRun?: boolean;
  /** A repeat with the same key returns the first result. Not needed for corrections, because User stores each correction id once. */
  idempotencyKey?: string;
}

export interface UserCorrectionsWriteOutput {
  /** null for dryRun, or when nothing new was stored. */
  changeId: string | null;
  summary: string;
  /** As stored, in request order. For a repeat, the correction that User stored earlier, with its own id. */
  corrections: UserCorrection[];
  /** One result for each correction of the request, in request order. results[i].id is the id of the i-th correction of the request, also for a repeat. */
  results: UserCorrectionResult[];
}

export interface UserCorrectionResult {
  /** The id of the i-th correction of the request, also for a repeat. The app finds its outbox item by it. */
  id: string;
  /** applied: the correction applies (see overridden). superseded: corrections with a later createdAt win completely; it stays in the history. held: stored and not applied; see reason. */
  status: "applied" | "superseded" | "held";
  /** true when User had stored this id, or this create, before. Nothing new is stored, except the new id of a repeated create as an alias. */
  repeat: boolean;
  /** Only for a create that repeats an earlier create with another id. The id of the earlier correction. User stores the new id as its alias, so a later send of the new id is a repeat by id. */
  repeatOf?: string;
  /** The record that holds the fact now (the new record of a create, the merge target of a merged record, the first id of a merge). A held result has it whenever User knows the record. */
  record?: string;
  /** The version of record after the write. */
  version?: number;
  /** The state of record after the write. */
  state?: "active" | "rejected";
  /** set or clear only. The fields for which a correction with a later createdAt wins. */
  overridden?: string[];
  reason?: UserCorrectionResultReason;
}

export interface UserCorrectionResultReason {
  /** required-field: a clear would leave a required field without a value. record-rejected: a create repeats a create whose record the person rejected. record-removed: the record lost all its claims; User applies the correction again when it comes back. unknown-record: User does not know the record id. */
  code: "required-field" | "record-rejected" | "record-removed" | "unknown-record";
  /** A sentence for the app. */
  message: string;
}

export interface UserCorrectionsListInput {
  record?: string;
  limit?: number;
  /** next of the previous page. */
  cursor?: string;
}

export interface UserCorrectionsListOutput {
  items: UserCorrection[];
  /** null on the last page. */
  next: string | null;
}

export interface UserChangesListInput {
  /** The cursor of the last change that the app applied. Without it: every record. */
  since?: string;
  kinds?: Array<"person" | "home" | "workplace" | "place" | "stay" | "trip" | "chapter" | "milestone">;
  limit?: number;
}

export interface UserChangesListOutput {
  items: UserChange[];
  /** null on the last page. */
  next: string | null;
}

export interface UserListInput {
  /** YYYY, YYYY-MM, or YYYY-MM-DD. */
  from?: string;
  /** YYYY, YYYY-MM, or YYYY-MM-DD. */
  to?: string;
  /** The owner's id or a Contacts reference. User follows Contacts redirects, so a reference to a merged person finds the records of the person it was merged into. */
  person?: string | UserContactRef;
  /** true: only records for the review list. */
  review?: boolean;
  includeRejected?: boolean;
  limit?: number;
  /** next of the previous page. */
  cursor?: string;
}

export interface UserContactRef {
  app: "contacts";
  kind: "person";
  id: string;
}

export interface UserRecordPage {
  items: UserRecord[];
  /** null on the last page. */
  next: string | null;
}

export interface UserGetInput {
  id: string;
}

export interface UserRecordEnvelope {
  record: UserRecord;
}

/** The owner. Memex.User keeps one person record; other people are Contacts references. */
export interface UserPersonFields {
  name: string;
  role: "owner";
  contact?: UserContactRef;
}

/** Where the owner lives or lived, over time, and who lived there with the owner. */
export interface UserHomeFields {
  type: "home" | "cabin";
  label?: string;
  location?: UserLocation;
  address?: string;
  town?: string;
  /** ISO 3166-1 alpha-2. */
  country?: string;
  /** YYYY, YYYY-MM, or YYYY-MM-DD. */
  from?: string;
  /** YYYY, YYYY-MM, or YYYY-MM-DD. */
  to?: string;
  /** The people who lived there with the owner: the owner's person id or a Contacts reference. */
  members?: UserHomeFieldsMembersItem[];
}

export interface UserLocation {
  lat: number;
  lon: number;
  radiusM?: number;
}

export interface UserHomeFieldsMembersItem {
  /** The owner's User person id, or a Contacts person. User follows Contacts redirects (mergedInto) when it reads a reference. */
  person: string | UserContactRef;
  /** YYYY, YYYY-MM, or YYYY-MM-DD. */
  from?: string;
  /** YYYY, YYYY-MM, or YYYY-MM-DD. */
  to?: string;
  child?: boolean;
}

/** Where the owner works or studies: its sites, and the owner's stints there. */
export interface UserWorkplaceFields {
  name: string;
  type: "employer" | "client" | "own" | "school";
  sites?: UserWorkplaceFieldsSitesItem[];
  /** The owner's periods at the workplace. Other people's stints are in Memex.Contacts. */
  stints?: UserWorkplaceFieldsStintsItem[];
}

export interface UserWorkplaceFieldsSitesItem {
  location: UserLocation;
  label?: string;
  type?: "office" | "cabin" | "other";
}

export interface UserWorkplaceFieldsStintsItem {
  /** YYYY, YYYY-MM, or YYYY-MM-DD. */
  from?: string;
  /** YYYY, YYYY-MM, or YYYY-MM-DD. */
  to?: string;
}

/** A named place that the owner goes back to. */
export interface UserPlaceFields {
  name: string;
  type: "bar" | "restaurant" | "cafe" | "shop" | "sport" | "culture" | "hotel" | "area" | "spot" | "other";
  location: UserLocation;
  address?: string;
  town?: string;
  /** ISO 3166-1 alpha-2. */
  country?: string;
}

/** Time at one place, from arrival to departure. */
export interface UserStayFields {
  arrival: string;
  departure: string;
  location: UserLocation;
  name?: string;
  place?: string;
  /** IANA time zone name. */
  timeZone?: string;
}

/** Time away from home: the days, the destinations, and who was there. */
export interface UserTripFields {
  title: string;
  firstDay: string;
  lastDay: string;
  destinations?: UserTripFieldsDestinationsItem[];
  countries?: string[];
  participants?: Array<string | UserContactRef>;
  home?: string;
}

export interface UserTripFieldsDestinationsItem {
  name: string;
  town?: string;
  /** ISO 3166-1 alpha-2. */
  country?: string;
  location?: UserLocation;
}

/** A named period: a trip, a move, a project, a payoff. */
export interface UserChapterFields {
  title: string;
  type: "trip" | "move" | "project" | "payoff" | "period" | "other";
  /** YYYY, YYYY-MM, or YYYY-MM-DD. */
  from: string;
  /** YYYY, YYYY-MM, or YYYY-MM-DD. */
  to?: string;
  trip?: string;
}

/** A dated event, for example a loan paid off. */
export interface UserMilestoneFields {
  title: string;
  /** YYYY, YYYY-MM, or YYYY-MM-DD. */
  date: string;
  persons?: Array<string | UserContactRef>;
}

/** The type name of each component schema of the contract. */
export const USER_COMPONENT_TYPES = {
  Error: "UserErrorBody",
  Health: "UserHealth",
  Drain: "UserDrain",
  CapabilityList: "UserCapabilityList",
  Record: "UserRecord",
  Claim: "UserClaim",
  Correction: "UserCorrection",
  Change: "UserChange",
  ClaimsWriteInput: "UserClaimsWriteInput",
  ClaimsWriteOutput: "UserClaimsWriteOutput",
  ClaimsListInput: "UserClaimsListInput",
  ClaimsListOutput: "UserClaimsListOutput",
  CorrectionsWriteInput: "UserCorrectionsWriteInput",
  CorrectionsWriteOutput: "UserCorrectionsWriteOutput",
  CorrectionResult: "UserCorrectionResult",
  CorrectionsListInput: "UserCorrectionsListInput",
  CorrectionsListOutput: "UserCorrectionsListOutput",
  ChangesListInput: "UserChangesListInput",
  ChangesListOutput: "UserChangesListOutput",
  ListInput: "UserListInput",
  RecordPage: "UserRecordPage",
  GetInput: "UserGetInput",
  RecordEnvelope: "UserRecordEnvelope",
} as const;

/** The fields type of each record kind. */
export interface UserKindFields {
  person: UserPersonFields;
  home: UserHomeFields;
  workplace: UserWorkplaceFields;
  place: UserPlaceFields;
  stay: UserStayFields;
  trip: UserTripFields;
  chapter: UserChapterFields;
  milestone: UserMilestoneFields;
}

/** The record kinds of the hub. */
export type UserKind = keyof UserKindFields;

export const USER_KINDS: readonly UserKind[] = ["person", "home", "workplace", "place", "stay", "trip", "chapter", "milestone"];

/** One request of an operation, for UserApiBase.send. */
export interface UserOperationRequest {
  operation: string;
  method: "GET" | "POST";
  path: string;
  body?: unknown;
  /** false for /health, which takes no token. */
  auth: boolean;
}

/** Every operation of the contract: method and path. */
export const USER_OPERATIONS = {
  getHealth: { method: "GET", path: "/health" },
  listCapabilities: { method: "GET", path: "/api/v1" },
  getOpenApi: { method: "GET", path: "/api/v1/openapi.json" },
  claimsWrite: { method: "POST", path: "/api/v1/user.claims.write" },
  claimsList: { method: "POST", path: "/api/v1/user.claims.list" },
  correctionsWrite: { method: "POST", path: "/api/v1/user.corrections.write" },
  correctionsList: { method: "POST", path: "/api/v1/user.corrections.list" },
  changesList: { method: "POST", path: "/api/v1/user.changes.list" },
  personsList: { method: "POST", path: "/api/v1/user.persons.list" },
  personsGet: { method: "POST", path: "/api/v1/user.persons.get" },
  homesList: { method: "POST", path: "/api/v1/user.homes.list" },
  homesGet: { method: "POST", path: "/api/v1/user.homes.get" },
  workplacesList: { method: "POST", path: "/api/v1/user.workplaces.list" },
  workplacesGet: { method: "POST", path: "/api/v1/user.workplaces.get" },
  placesList: { method: "POST", path: "/api/v1/user.places.list" },
  placesGet: { method: "POST", path: "/api/v1/user.places.get" },
  staysList: { method: "POST", path: "/api/v1/user.stays.list" },
  staysGet: { method: "POST", path: "/api/v1/user.stays.get" },
  tripsList: { method: "POST", path: "/api/v1/user.trips.list" },
  tripsGet: { method: "POST", path: "/api/v1/user.trips.get" },
  chaptersList: { method: "POST", path: "/api/v1/user.chapters.list" },
  chaptersGet: { method: "POST", path: "/api/v1/user.chapters.get" },
  milestonesList: { method: "POST", path: "/api/v1/user.milestones.list" },
  milestonesGet: { method: "POST", path: "/api/v1/user.milestones.get" },
} as const;

export type UserOperation = keyof typeof USER_OPERATIONS;

/** The operations of the Memex.User API as methods. A subclass sends the requests. */
export abstract class UserApiBase {
  protected abstract send(request: UserOperationRequest): Promise<unknown>;

  /** Health without paths or user data (GET /health) */
  getHealth(): Promise<UserHealth> {
    return this.send({ operation: "getHealth", method: "GET", path: "/health", auth: false }) as Promise<UserHealth>;
  }

  /** The capabilities of User (GET /api/v1) */
  listCapabilities(): Promise<UserCapabilityList> {
    return this.send({ operation: "listCapabilities", method: "GET", path: "/api/v1", auth: true }) as Promise<UserCapabilityList>;
  }

  /** This API as OpenAPI 3.1 JSON (GET /api/v1/openapi.json) */
  getOpenApi(): Promise<Record<string, unknown>> {
    return this.send({ operation: "getOpenApi", method: "GET", path: "/api/v1/openapi.json", auth: true }) as Promise<Record<string, unknown>>;
  }

  /** user.claims.write (POST /api/v1/user.claims.write) */
  claimsWrite(body: UserClaimsWriteInput): Promise<UserClaimsWriteOutput> {
    return this.send({ operation: "claimsWrite", method: "POST", path: "/api/v1/user.claims.write", body, auth: true }) as Promise<UserClaimsWriteOutput>;
  }

  /** user.claims.list (POST /api/v1/user.claims.list) */
  claimsList(body: UserClaimsListInput): Promise<UserClaimsListOutput> {
    return this.send({ operation: "claimsList", method: "POST", path: "/api/v1/user.claims.list", body, auth: true }) as Promise<UserClaimsListOutput>;
  }

  /** user.corrections.write (POST /api/v1/user.corrections.write) */
  correctionsWrite(body: UserCorrectionsWriteInput): Promise<UserCorrectionsWriteOutput> {
    return this.send({ operation: "correctionsWrite", method: "POST", path: "/api/v1/user.corrections.write", body, auth: true }) as Promise<UserCorrectionsWriteOutput>;
  }

  /** user.corrections.list (POST /api/v1/user.corrections.list) */
  correctionsList(body: UserCorrectionsListInput): Promise<UserCorrectionsListOutput> {
    return this.send({ operation: "correctionsList", method: "POST", path: "/api/v1/user.corrections.list", body, auth: true }) as Promise<UserCorrectionsListOutput>;
  }

  /** user.changes.list (POST /api/v1/user.changes.list) */
  changesList(body: UserChangesListInput): Promise<UserChangesListOutput> {
    return this.send({ operation: "changesList", method: "POST", path: "/api/v1/user.changes.list", body, auth: true }) as Promise<UserChangesListOutput>;
  }

  /** user.persons.list (POST /api/v1/user.persons.list) */
  personsList(body: UserListInput): Promise<UserRecordPage> {
    return this.send({ operation: "personsList", method: "POST", path: "/api/v1/user.persons.list", body, auth: true }) as Promise<UserRecordPage>;
  }

  /** user.persons.get (POST /api/v1/user.persons.get) */
  personsGet(body: UserGetInput): Promise<UserRecordEnvelope> {
    return this.send({ operation: "personsGet", method: "POST", path: "/api/v1/user.persons.get", body, auth: true }) as Promise<UserRecordEnvelope>;
  }

  /** user.homes.list (POST /api/v1/user.homes.list) */
  homesList(body: UserListInput): Promise<UserRecordPage> {
    return this.send({ operation: "homesList", method: "POST", path: "/api/v1/user.homes.list", body, auth: true }) as Promise<UserRecordPage>;
  }

  /** user.homes.get (POST /api/v1/user.homes.get) */
  homesGet(body: UserGetInput): Promise<UserRecordEnvelope> {
    return this.send({ operation: "homesGet", method: "POST", path: "/api/v1/user.homes.get", body, auth: true }) as Promise<UserRecordEnvelope>;
  }

  /** user.workplaces.list (POST /api/v1/user.workplaces.list) */
  workplacesList(body: UserListInput): Promise<UserRecordPage> {
    return this.send({ operation: "workplacesList", method: "POST", path: "/api/v1/user.workplaces.list", body, auth: true }) as Promise<UserRecordPage>;
  }

  /** user.workplaces.get (POST /api/v1/user.workplaces.get) */
  workplacesGet(body: UserGetInput): Promise<UserRecordEnvelope> {
    return this.send({ operation: "workplacesGet", method: "POST", path: "/api/v1/user.workplaces.get", body, auth: true }) as Promise<UserRecordEnvelope>;
  }

  /** user.places.list (POST /api/v1/user.places.list) */
  placesList(body: UserListInput): Promise<UserRecordPage> {
    return this.send({ operation: "placesList", method: "POST", path: "/api/v1/user.places.list", body, auth: true }) as Promise<UserRecordPage>;
  }

  /** user.places.get (POST /api/v1/user.places.get) */
  placesGet(body: UserGetInput): Promise<UserRecordEnvelope> {
    return this.send({ operation: "placesGet", method: "POST", path: "/api/v1/user.places.get", body, auth: true }) as Promise<UserRecordEnvelope>;
  }

  /** user.stays.list (POST /api/v1/user.stays.list) */
  staysList(body: UserListInput): Promise<UserRecordPage> {
    return this.send({ operation: "staysList", method: "POST", path: "/api/v1/user.stays.list", body, auth: true }) as Promise<UserRecordPage>;
  }

  /** user.stays.get (POST /api/v1/user.stays.get) */
  staysGet(body: UserGetInput): Promise<UserRecordEnvelope> {
    return this.send({ operation: "staysGet", method: "POST", path: "/api/v1/user.stays.get", body, auth: true }) as Promise<UserRecordEnvelope>;
  }

  /** user.trips.list (POST /api/v1/user.trips.list) */
  tripsList(body: UserListInput): Promise<UserRecordPage> {
    return this.send({ operation: "tripsList", method: "POST", path: "/api/v1/user.trips.list", body, auth: true }) as Promise<UserRecordPage>;
  }

  /** user.trips.get (POST /api/v1/user.trips.get) */
  tripsGet(body: UserGetInput): Promise<UserRecordEnvelope> {
    return this.send({ operation: "tripsGet", method: "POST", path: "/api/v1/user.trips.get", body, auth: true }) as Promise<UserRecordEnvelope>;
  }

  /** user.chapters.list (POST /api/v1/user.chapters.list) */
  chaptersList(body: UserListInput): Promise<UserRecordPage> {
    return this.send({ operation: "chaptersList", method: "POST", path: "/api/v1/user.chapters.list", body, auth: true }) as Promise<UserRecordPage>;
  }

  /** user.chapters.get (POST /api/v1/user.chapters.get) */
  chaptersGet(body: UserGetInput): Promise<UserRecordEnvelope> {
    return this.send({ operation: "chaptersGet", method: "POST", path: "/api/v1/user.chapters.get", body, auth: true }) as Promise<UserRecordEnvelope>;
  }

  /** user.milestones.list (POST /api/v1/user.milestones.list) */
  milestonesList(body: UserListInput): Promise<UserRecordPage> {
    return this.send({ operation: "milestonesList", method: "POST", path: "/api/v1/user.milestones.list", body, auth: true }) as Promise<UserRecordPage>;
  }

  /** user.milestones.get (POST /api/v1/user.milestones.get) */
  milestonesGet(body: UserGetInput): Promise<UserRecordEnvelope> {
    return this.send({ operation: "milestonesGet", method: "POST", path: "/api/v1/user.milestones.get", body, auth: true }) as Promise<UserRecordEnvelope>;
  }
}
