export interface EntityRow {
  id: string;
  type: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface RelationshipRow {
  id: string;
  from_id: string;
  to_id: string;
  type: string;
  created_at: string;
}

export interface ProvenanceRow {
  id: string;
  entity_id: string;
  source: string;
  source_ref: string | null;
  content_hash: string | null;
  recorded_at: string;
  batch_id: string | null;
  file_hash: string | null;
  reader: string | null;
}

export interface FactRow {
  id: string;
  kind: string;
  scope: string;
  key: string;
  partition: string | null;
  entity_id: string | null;
  /** A JSON object. */
  fields: string;
  confidence: number;
  method: string;
  state: 'active' | 'withdrawn';
  created_at: string;
  updated_at: string;
}

export interface FactSourceRow {
  fact_id: string;
  entity_id: string | null;
  app: string | null;
  kind: string | null;
  ref_id: string | null;
}

export type CorrectionOp = 'set' | 'clear' | 'reject' | 'restore' | 'merge' | 'create';

export interface CorrectionRow {
  id: string;
  fact_id: string;
  op: CorrectionOp;
  app: string;
  /** A JSON object with fields, names, records, or kind. */
  body: string;
  created_at: string;
}
