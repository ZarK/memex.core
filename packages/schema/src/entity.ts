import { randomUUID } from 'node:crypto';
import type { SqliteDatabase } from '@tjalve/memex-sqlite';
import type { EntityRow, ProvenanceRow } from './types.js';

/** Create an entity row and return its id. */
export function createEntity(db: SqliteDatabase, type: string, id: string = randomUUID()): string {
  db.run('INSERT INTO entity (id, type) VALUES (?, ?)', id, type);
  return id;
}

export function getEntity(db: SqliteDatabase, id: string): EntityRow | undefined {
  return db.get<EntityRow>('SELECT * FROM entity WHERE id = ?', id);
}

/** Set updated_at to now. Call after modifying a domain-table row. */
export function touchEntity(db: SqliteDatabase, id: string): void {
  db.run("UPDATE entity SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?", id);
}

/** Soft-delete: sets deleted_at, keeps the row and its provenance. */
export function softDeleteEntity(db: SqliteDatabase, id: string): void {
  db.run("UPDATE entity SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?", id);
}

/**
 * Create a typed edge between two entities. Idempotent:
 * an existing (from, to, type) edge is left as is.
 */
export function link(db: SqliteDatabase, fromId: string, toId: string, type: string): void {
  db.run(
    'INSERT OR IGNORE INTO relationship (id, from_id, to_id, type) VALUES (?, ?, ?, ?)',
    randomUUID(),
    fromId,
    toId,
    type,
  );
}

export interface ProvenanceInput {
  entityId: string;
  source: string;
  sourceRef?: string;
  contentHash?: string;
  /** The import run that wrote the row. */
  batchId?: string;
  /** SHA-256 (hex) of the whole source file. */
  fileHash?: string;
  /** The parser and its version, for example 'finance.csv.sparebank1/2'. */
  reader?: string;
}

/**
 * Record where an entity came from. A second row with the same
 * (source, contentHash) is refused by the database: look it up first with
 * findEntityByProvenance.
 */
export function recordProvenance(db: SqliteDatabase, input: ProvenanceInput): string {
  const id = randomUUID();
  db.run(
    `INSERT INTO provenance (id, entity_id, source, source_ref, content_hash, batch_id, file_hash, reader)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.entityId,
    input.source,
    input.sourceRef ?? null,
    input.contentHash ?? null,
    input.batchId ?? null,
    input.fileHash ?? null,
    input.reader ?? null,
  );
  return id;
}

/**
 * Import dedupe primitive: return the entity already recorded for
 * (source, contentHash), if any. See contracts/connector.md.
 */
export function findEntityByProvenance(
  db: SqliteDatabase,
  source: string,
  contentHash: string,
): string | undefined {
  const row = db.get<Pick<ProvenanceRow, 'entity_id'>>(
    'SELECT entity_id FROM provenance WHERE source = ? AND content_hash = ?',
    source,
    contentHash,
  );
  return row?.entity_id;
}

/** The provenance rows of one import run, in the order they were recorded. */
export function listProvenanceByBatch(db: SqliteDatabase, batchId: string): ProvenanceRow[] {
  return db.all<ProvenanceRow>(
    'SELECT * FROM provenance WHERE batch_id = ? ORDER BY recorded_at, rowid',
    batchId,
  );
}
