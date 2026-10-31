-- Memex entity spine, schema v0.
-- Canonical DDL. The copy shipped as a migration in @memex/schema
-- (packages/schema/migrations/0001_entity_spine.sql) must stay byte-identical;
-- a test enforces this.
--
-- Conventions:
--  * ids are UUID strings.
--  * timestamps are ISO 8601 UTC with millisecond precision.
--  * entity.type is a namespaced string, e.g. 'finance.account'.
--  * Domain modules store their fields in their own tables, keyed by
--    entity_id referencing entity(id). The spine never learns domain fields.

CREATE TABLE entity (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_at TEXT
);

CREATE INDEX idx_entity_type ON entity(type);

CREATE TABLE relationship (
  id TEXT PRIMARY KEY,
  from_id TEXT NOT NULL REFERENCES entity(id),
  to_id TEXT NOT NULL REFERENCES entity(id),
  type TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (from_id, to_id, type)
);

CREATE INDEX idx_relationship_from ON relationship(from_id, type);
CREATE INDEX idx_relationship_to ON relationship(to_id, type);

CREATE TABLE provenance (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL REFERENCES entity(id),
  source TEXT NOT NULL,
  source_ref TEXT,
  content_hash TEXT,
  recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_provenance_entity ON provenance(entity_id);
CREATE INDEX idx_provenance_source_hash ON provenance(source, content_hash);
