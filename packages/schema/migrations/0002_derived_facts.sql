-- Memex schema 0.3: provenance v2, derived facts, and corrections.
-- See contracts/derived-facts.md. Applied after 0001_entity_spine.sql in the
-- scope 'core'.

-- Provenance v2. batch_id groups the rows of one import run, so that the run
-- can be listed and undone. file_hash is the SHA-256 (hex) of the whole source
-- file. reader names the parser and its version, for example
-- 'finance.csv.sparebank1/2'.
ALTER TABLE provenance ADD COLUMN batch_id TEXT;
ALTER TABLE provenance ADD COLUMN file_hash TEXT;
ALTER TABLE provenance ADD COLUMN reader TEXT;

-- (source, content_hash) is the import dedupe key; now the database enforces
-- it. Rows without a content_hash do not take part. A database that already has
-- two rows with the same key refuses this migration and stays on 0001.
DROP INDEX idx_provenance_source_hash;
CREATE UNIQUE INDEX uq_provenance_source_hash ON provenance(source, content_hash);
CREATE INDEX idx_provenance_batch ON provenance(batch_id) WHERE batch_id IS NOT NULL;

-- A derived fact: what a rule or a model inferred from records.
--  * id is '<kind>_<32 hex>': the first 32 hex digits of the SHA-256 of
--    '<scope>\n<key>'. The same (kind, scope, key) always gives the same id, also
--    in a new database, so corrections find their fact again after re-inference.
--  * scope is the producer: '<app>.<kinds>', for example 'photos.trips'.
--  * key is the producer's own stable id for the fact, at most 200 characters.
--  * partition limits a replace to a part of the scope, for example a year.
--  * fields is a JSON object. method names the rule or model and its version.
--  * A fact that its producer no longer infers is 'withdrawn', never deleted.
CREATE TABLE fact (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  partition TEXT,
  entity_id TEXT REFERENCES entity(id),
  fields TEXT NOT NULL CHECK (json_valid(fields) AND json_type(fields) = 'object'),
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  method TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'withdrawn')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_fact_scope ON fact(scope, partition, state);
CREATE INDEX idx_fact_kind ON fact(kind, state);
CREATE INDEX idx_fact_entity ON fact(entity_id) WHERE entity_id IS NOT NULL;

-- The records a fact comes from: an entity in this database, or a record in
-- another app ({app, kind, id}).
CREATE TABLE fact_source (
  fact_id TEXT NOT NULL REFERENCES fact(id),
  entity_id TEXT REFERENCES entity(id),
  app TEXT,
  kind TEXT,
  ref_id TEXT,
  CHECK (
    (entity_id IS NOT NULL AND app IS NULL AND kind IS NULL AND ref_id IS NULL)
    OR (entity_id IS NULL AND app IS NOT NULL AND kind IS NOT NULL AND ref_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX uq_fact_source ON fact_source(
  fact_id, ifnull(entity_id, ''), ifnull(app, ''), ifnull(kind, ''), ifnull(ref_id, '')
);
CREATE INDEX idx_fact_source_entity ON fact_source(entity_id) WHERE entity_id IS NOT NULL;
CREATE INDEX idx_fact_source_ref ON fact_source(app, kind, ref_id) WHERE ref_id IS NOT NULL;

-- A correction: a decision of the user. Inference never changes or removes it.
--  * id is 'cor_<32 hex>'.
--  * fact_id is the fact that it changes (for merge: the fact that stays; for
--    create: the new fact). It has no foreign key: a correction stays when its
--    fact is withdrawn, and an import can bring it before re-inference makes
--    the fact again.
--  * body is a JSON object with the operands of op: fields, names, records, kind.
CREATE TABLE correction (
  id TEXT PRIMARY KEY,
  fact_id TEXT NOT NULL,
  op TEXT NOT NULL CHECK (op IN ('set', 'clear', 'reject', 'restore', 'merge', 'create')),
  app TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(body) AND json_type(body) = 'object'),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_correction_fact ON correction(fact_id, created_at);
