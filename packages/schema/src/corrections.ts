import { randomBytes } from 'node:crypto';
import type { SqliteDatabase } from '@tjalve/memex-sqlite';
import type { CorrectionOp, CorrectionRow } from './types.js';

const CORRECTION_ID = /^cor_[0-9a-f]{32}$/;
const FACT_ID = /^[a-z][a-z0-9.-]*_[0-9a-f]{32}$/;
const KIND = /^[a-z][a-z0-9.-]*$/;
const APP = /^[a-z][a-z0-9]*$/;
const UTC_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const OPS: readonly CorrectionOp[] = ['set', 'clear', 'reject', 'restore', 'merge', 'create'];
const PROPERTIES = new Set(['id', 'op', 'app', 'record', 'records', 'kind', 'fields', 'names', 'createdAt']);

/**
 * A correction as the API and the JSON Lines export carry it. The property
 * names follow schemas/user/correction.json: record is the fact id.
 */
export interface Correction {
  id: string;
  op: CorrectionOp;
  /** The app in which the user acted. */
  app: string;
  /** The fact that the correction changes. For create: the new fact. Not set for merge. */
  record?: string;
  /** merge: the facts to join; the first one stays. */
  records?: string[];
  /** create: the kind of the new fact. */
  kind?: string;
  /** set: the fields to set. create: all fields of the new fact. */
  fields?: Record<string, unknown>;
  /** clear: the fields to give back to inference. */
  names?: string[];
  createdAt: string;
}

/**
 * What an app passes to addCorrection. The app makes id and createdAt when the
 * person acts, so a correction that waited in an outbox keeps
 * the time of the edit, and a send that is repeated stores nothing new.
 */
export type CorrectionInput = { id: string; createdAt: string; app: string } & (
  | { op: 'set'; record: string; fields: Record<string, unknown> }
  | { op: 'clear'; record: string; names: string[] }
  | { op: 'reject' | 'restore'; record: string }
  | { op: 'merge'; records: string[] }
  | { op: 'create'; kind: string; fields: Record<string, unknown>; record?: string }
);

/** A new correction id: 'cor_' and 32 random lowercase hex digits. */
export function newCorrectionId(): string {
  return `cor_${randomBytes(16).toString('hex')}`;
}

export class CorrectionError extends Error {
  constructor(
    message: string,
    /** The line of the JSON Lines text, for importCorrections. */
    readonly line?: number,
  ) {
    super(line === undefined ? message : `Line ${line}: ${message}`);
    this.name = 'CorrectionError';
  }
}

export interface ImportResult {
  added: number;
  /** Corrections that the database already had, with the same content. */
  unchanged: number;
}

/**
 * Store a correction of the user, with the id and createdAt that the app made.
 * A correction with an id that is already stored is a repeat: nothing new is
 * stored, and the stored correction comes back. The same id with other content
 * is refused. Corrections are ordered by createdAt, then by the order in which
 * they were stored.
 */
export function addCorrection(db: SqliteDatabase, input: CorrectionInput): Correction {
  const draft: Record<string, unknown> = { ...input };
  if (input.op === 'create' && input.record === undefined) {
    draft.record = `${input.kind}_${randomBytes(16).toString('hex')}`;
  }
  const correction = checkCorrection(draft);
  const row = db.get<CorrectionRow>('SELECT * FROM correction WHERE id = ?', correction.id);
  if (row) {
    const stored = fromRow(row);
    const same = (c: Correction) => correctionLine(input.op === 'create' && input.record === undefined ? { ...c, record: undefined } : c);
    if (same(stored) === same(correction)) return stored;
    throw new CorrectionError(`the correction ${correction.id} is already stored with other content`);
  }
  insertCorrection(db, correction);
  return correction;
}

/** Corrections in the order they were made: all of them, or those of one fact (fact_id). */
export function listCorrections(db: SqliteDatabase, factId?: string): Correction[] {
  const rows =
    factId === undefined
      ? db.all<CorrectionRow>('SELECT * FROM correction ORDER BY created_at, rowid')
      : db.all<CorrectionRow>(
          'SELECT * FROM correction WHERE fact_id = ? ORDER BY created_at, rowid',
          factId,
        );
  return rows.map(fromRow);
}

/** All corrections as JSON Lines, one correction per line, in the order they were made. */
export function exportCorrections(db: SqliteDatabase): string {
  return listCorrections(db)
    .map((c) => correctionLine(c) + '\n')
    .join('');
}

/**
 * Read corrections from JSON Lines, for example an export from another
 * database. Every line is checked before anything is written, and the import
 * runs in one transaction. A correction that the database has already is
 * skipped; one with the same id and other content is refused.
 */
export function importCorrections(db: SqliteDatabase, text: string): ImportResult {
  const corrections: { correction: Correction; line: number }[] = [];
  text.split('\n').forEach((raw, index) => {
    const line = raw.replace(/\r$/, '');
    if (line.trim() === '') return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new CorrectionError('not valid JSON', index + 1);
    }
    corrections.push({ correction: checkCorrection(value, index + 1), line: index + 1 });
  });
  return db.transaction(() => {
    const result: ImportResult = { added: 0, unchanged: 0 };
    for (const { correction, line } of corrections) {
      const row = db.get<CorrectionRow>('SELECT * FROM correction WHERE id = ?', correction.id);
      if (!row) {
        insertCorrection(db, correction, line);
        result.added += 1;
      } else if (correctionLine(fromRow(row)) === correctionLine(correction)) {
        result.unchanged += 1;
      } else {
        throw new CorrectionError(`the correction ${correction.id} is already stored with other content`, line);
      }
    }
    return result;
  });
}

/** The JSON Lines form of a correction: fixed property order, no spaces. */
export function correctionLine(c: Correction): string {
  return JSON.stringify({
    id: c.id,
    op: c.op,
    app: c.app,
    record: c.record,
    records: c.records,
    kind: c.kind,
    fields: c.fields,
    names: c.names,
    createdAt: c.createdAt,
  });
}

/** Check a correction (an object from JSON) and return it in its normal form. */
export function checkCorrection(value: unknown, line?: number): Correction {
  const fail = (message: string): never => {
    throw new CorrectionError(message, line);
  };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail('a correction must be an object');
  const v = value as Record<string, unknown>;
  for (const name of Object.keys(v)) if (!PROPERTIES.has(name)) fail(`unknown property '${name}'`);
  if (typeof v.id !== 'string' || !CORRECTION_ID.test(v.id)) fail(`invalid id '${String(v.id)}'`);
  if (!OPS.includes(v.op as CorrectionOp)) fail(`invalid op '${String(v.op)}'`);
  if (typeof v.app !== 'string' || !APP.test(v.app)) fail(`invalid app '${String(v.app)}'`);
  if (typeof v.createdAt !== 'string' || !UTC_TIME.test(v.createdAt)) {
    fail(`createdAt must be a UTC time: '${String(v.createdAt)}'`);
  }
  const createdAt = new Date(v.createdAt as string);
  if (Number.isNaN(createdAt.getTime())) fail(`createdAt is not a valid time: '${String(v.createdAt)}'`);
  const op = v.op as CorrectionOp;
  // Millisecond precision, so that the times sort as text.
  const c: Correction = { id: v.id as string, op, app: v.app as string, createdAt: createdAt.toISOString() };
  const allowed: Record<CorrectionOp, string[]> = {
    set: ['record', 'fields'],
    clear: ['record', 'names'],
    reject: ['record'],
    restore: ['record'],
    merge: ['records'],
    create: ['record', 'kind', 'fields'],
  };
  for (const name of ['record', 'records', 'kind', 'fields', 'names']) {
    if (v[name] !== undefined && !allowed[op].includes(name)) fail(`${op} has no '${name}'`);
  }
  if (op === 'merge') {
    const records = v.records;
    if (
      !Array.isArray(records) ||
      records.length < 2 ||
      !records.every((r) => typeof r === 'string' && FACT_ID.test(r)) ||
      new Set(records).size !== records.length
    ) {
      fail('merge needs two or more different fact ids in records');
    }
    c.records = [...(records as string[])];
    return c;
  }
  if (typeof v.record !== 'string' || !FACT_ID.test(v.record)) fail(`invalid record '${String(v.record)}'`);
  c.record = v.record as string;
  if (op === 'set' || op === 'create') {
    // Check the JSON form: a field with the value undefined is not stored or exported.
    const fields: unknown =
      typeof v.fields === 'object' && v.fields !== null ? JSON.parse(JSON.stringify(v.fields)) : v.fields;
    if (typeof fields !== 'object' || fields === null || Array.isArray(fields) || Object.keys(fields).length === 0) {
      fail(`${op} needs fields with at least one field`);
    }
    c.fields = fields as Record<string, unknown>;
  }
  if (op === 'create') {
    if (typeof v.kind !== 'string' || !KIND.test(v.kind)) fail(`invalid kind '${String(v.kind)}'`);
    if (!c.record.startsWith(`${v.kind as string}_`)) fail(`the record of a create must start with '${v.kind as string}_'`);
    c.kind = v.kind as string;
  }
  if (op === 'clear') {
    const names = v.names;
    if (
      !Array.isArray(names) ||
      names.length === 0 ||
      !names.every((n) => typeof n === 'string' && n.length > 0) ||
      new Set(names).size !== names.length
    ) {
      fail('clear needs names: one or more different field names');
    }
    c.names = [...(names as string[])];
  }
  return c;
}

function insertCorrection(db: SqliteDatabase, c: Correction, line?: number): void {
  // A record that the user made is created once. A second create, for example
  // when an app sends the same entries again, would reset fields that the user
  // set later. An inferred fact cannot become a record that the user made.
  if (c.op === 'create') {
    if (db.get('SELECT 1 FROM correction WHERE fact_id = ? AND op = ?', c.record!, 'create')) {
      throw new CorrectionError(`the record ${c.record!} is already created`, line);
    }
    if (db.get('SELECT 1 FROM fact WHERE id = ?', c.record!)) {
      throw new CorrectionError(`the record ${c.record!} is an inferred fact`, line);
    }
  }
  const body = { records: c.records, kind: c.kind, fields: c.fields, names: c.names };
  db.run(
    'INSERT INTO correction (id, fact_id, op, app, body, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    c.id,
    c.record ?? c.records![0]!,
    c.op,
    c.app,
    JSON.stringify(body),
    c.createdAt,
  );
}

function fromRow(row: CorrectionRow): Correction {
  const body = JSON.parse(row.body) as Pick<Correction, 'records' | 'kind' | 'fields' | 'names'>;
  return {
    id: row.id,
    op: row.op,
    app: row.app,
    ...(row.op === 'merge' ? {} : { record: row.fact_id }),
    ...body,
    createdAt: row.created_at,
  };
}
