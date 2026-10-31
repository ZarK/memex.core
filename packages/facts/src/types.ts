// The shapes that the engine reads and returns. They follow contracts/facts.md and the
// ClaimsWrite, CorrectionsWrite, and ChangesList components of openapi/user.v1.yaml and
// openapi/contacts.v1.yaml. The JSON Schemas are canonical.
import type {
  Alternatives,
  ClaimRef,
  CorrectionResult,
  Provenance,
  Ref,
  ReviewReason,
  Seen,
} from '@tjalve/memex-schema';

export type { Alternatives, ClaimRef, CorrectionResult, Provenance, Ref, ReviewReason, Seen };

/** Memex.Contacts: the identity that a producer knows. */
export type Subject = { person: string } | { card: string } | { handle: string; at: string };

export interface ClaimInput {
  key: string;
  kind: string;
  confidence: number;
  method: string;
  generation: number;
  seen?: Seen;
  fields: Record<string, unknown>;
  sources?: Ref[];
  /** Memex.Contacts only. */
  subject?: Subject;
  /** Memex.Contacts only: the second subject of a relation or a date. */
  other?: Subject;
}

export interface ClaimsWriteInput {
  scope: string;
  partition?: string;
  claims: ClaimInput[];
  /** The producer's run. Needed for an empty list when the scope has a generation; else equal to the claims' generation. */
  generation?: number;
  dryRun?: boolean;
  idempotencyKey?: string;
}

export interface ClaimsWriteCounts {
  created: number;
  updated: number;
  unchanged: number;
  withdrawn: number;
  removed: number;
  /** Memex.Contacts only: claims whose subject does not resolve. */
  unresolved?: number;
}

export interface ClaimsWriteOutput {
  changeId: string | null;
  summary: string;
  counts: ClaimsWriteCounts;
  /** The record id of each claim key; null while its subject does not resolve. */
  records: { key: string; id: string | null }[];
}

export type CorrectionOp = 'set' | 'clear' | 'reject' | 'restore' | 'merge' | 'create' | 'unmerge' | 'pin' | 'unpin';

/** A correction as an app sends it, and as the hub stores and returns it. */
export interface Correction {
  id: string;
  op: CorrectionOp;
  kind?: string;
  record?: string;
  records?: string[];
  /** Memex.Contacts create: the person the new record is about. */
  person?: string;
  /** Memex.Contacts create of a relation or a date: the second person. */
  other?: string;
  fields?: Record<string, unknown>;
  names?: string[];
  sources?: Ref[];
  app: string;
  createdAt: string;
  /** Set by the hub: the claim keys of the record when the correction was stored. */
  anchors?: ClaimRef[];
}

export interface CorrectionsWriteInput {
  corrections: Correction[];
  dryRun?: boolean;
}

export interface CorrectionsWriteOutput {
  changeId: string | null;
  summary: string;
  corrections: Correction[];
  results: CorrectionResult[];
}

/** A record of either hub (contracts/facts.md#records). */
export interface FactsRecordOut {
  id: string;
  kind: string;
  version: number;
  state: 'active' | 'rejected';
  origin: 'inferred' | 'user';
  /** Memex.Contacts: a merged person, which stays as a redirect. */
  mergedInto?: string;
  /** Memex.Contacts: the person that the record is about. */
  person?: string;
  /** Memex.Contacts: the second person of a relation or a date. */
  other?: string;
  confidence: number;
  review: boolean;
  reviewReasons?: ReviewReason[];
  fields: Record<string, unknown>;
  provenance: Provenance;
  alternatives: Alternatives;
  corrected: string[];
  claims: { scope: string; partition?: string; key: string; confidence: number; seen?: Seen }[];
  sources: Ref[];
  createdAt: string;
  updatedAt: string;
}

export interface Change {
  cursor: string;
  op: 'upsert' | 'remove';
  id: string;
  kind: string;
  /** Memex.Contacts: the person that the record is about; for a person record, its own id. */
  person?: string;
  version: number;
  at: string;
  record?: FactsRecordOut;
  mergedInto?: string;
}

export interface ChangesListInput {
  since?: string;
  kinds?: string[];
  person?: string;
  limit?: number;
}

export interface Page<T> {
  items: T[];
  next: string | null;
}

export interface ListInput {
  from?: string;
  to?: string;
  person?: string;
  review?: boolean;
  includeRejected?: boolean;
  includeMerged?: boolean;
  limit?: number;
  cursor?: string;
}

export type FactsErrorCode = 'invalid' | 'stale-generation' | 'wrong-hub';

/** A refused call. Nothing was stored. `status` is the HTTP status that a hub returns. */
export class FactsError extends Error {
  readonly status: number;
  constructor(
    readonly code: FactsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'FactsError';
    this.status = code === 'stale-generation' ? 409 : 400;
  }
}
