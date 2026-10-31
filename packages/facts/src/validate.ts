// Request checks. A request that fails them is refused whole (400) and stores nothing.
import { isListEdit } from '@tjalve/memex-schema';
import type { HubDefinition, KindRule } from './kinds.js';
import { FactsError, type ClaimInput, type ClaimsWriteInput, type Correction, type CorrectionOp } from './types.js';
import { isObject } from './values.js';

const SCOPE = /^[a-z][a-z0-9]*\.([a-z]+)$/;
const METHOD = /^[a-z][a-z0-9-]*:\S+$/;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
const CORRECTION_ID = /^cor_[0-9a-f]{32}$/;
const RECORD_ID = /^([a-z][a-z0-9.-]*)_[0-9a-f]{32}$/;
const APP = /^[a-z][a-z0-9]*$/;
const REF_KIND = /^[a-z][a-z0-9-]*$/;

const fail = (message: string): never => {
  throw new FactsError('invalid', message);
};

export const MAX_CLAIMS = 5000;
export const MAX_CORRECTIONS = 500;

export function isUtc(value: unknown): value is string {
  return typeof value === 'string' && UTC.test(value) && !Number.isNaN(Date.parse(value));
}

/** The kind of a record id: trip for trip_…, or undefined. */
export function idKind(id: string): string | undefined {
  return RECORD_ID.exec(id)?.[1];
}

export function kindOfScope(hub: HubDefinition, scope: string): KindRule {
  const m = SCOPE.exec(scope);
  if (!m) fail(`The scope '${scope}' is not <app>.<kinds>.`);
  const rule = hub.kinds.find((k) => k.plural === m![1]);
  if (!rule) fail(`Memex.${hubTitle(hub)} has no kind for the scope '${scope}'.`);
  return rule!;
}

export function hubTitle(hub: HubDefinition): string {
  return hub.name.charAt(0).toUpperCase() + hub.name.slice(1);
}

function checkRef(value: unknown, where: string): void {
  if (
    !isObject(value) ||
    typeof value.app !== 'string' ||
    !APP.test(value.app) ||
    typeof value.kind !== 'string' ||
    !REF_KIND.test(value.kind) ||
    typeof value.id !== 'string' ||
    value.id.length < 1 ||
    value.id.length > 200 ||
    Object.keys(value).length !== 3
  ) {
    fail(`${where}: a source is { app, kind, id }.`);
  }
}

function checkSubject(value: unknown, where: string): void {
  if (!isObject(value)) fail(`${where} must be an object.`);
  const v = value as Record<string, unknown>;
  const keys = Object.keys(v).sort().join(',');
  if (keys === 'person' && typeof v.person === 'string' && idKind(v.person) === 'person') return;
  if (keys === 'card' && typeof v.card === 'string' && v.card.length > 0) return;
  if (keys === 'at,handle' && typeof v.handle === 'string' && v.handle.length > 0 && isUtc(v.at)) return;
  fail(`${where} must be exactly one of { person }, { card }, or { handle, at }.`);
}

/** Checks the fields that a kind requires. */
export function missingRequired(rule: KindRule, fields: Record<string, unknown>): string | undefined {
  for (const f of rule.required) if (fields[f] === undefined || fields[f] === null) return f;
  if (rule.requireOneOf && !rule.requireOneOf.some((f) => fields[f] !== undefined)) return rule.requireOneOf.join(' or ');
  return undefined;
}

export function checkClaimsWrite(hub: HubDefinition, input: ClaimsWriteInput): KindRule {
  if (!isObject(input)) fail('A claims write is an object.');
  for (const k of Object.keys(input)) {
    if (!['scope', 'partition', 'claims', 'generation', 'dryRun', 'idempotencyKey'].includes(k)) fail(`Unknown property '${k}'.`);
  }
  const rule = kindOfScope(hub, input.scope);
  if (input.partition !== undefined && (typeof input.partition !== 'string' || input.partition.length < 1 || input.partition.length > 64)) {
    fail('partition must have 1 to 64 characters.');
  }
  if (!Array.isArray(input.claims)) fail('claims must be a list.');
  if (input.claims.length > MAX_CLAIMS) fail(`One request has at most ${MAX_CLAIMS} claims.`);
  const keys = new Set<string>();
  let generation: number | undefined;
  input.claims.forEach((c, i) => {
    checkClaim(hub, rule, c, `claims[${i}]`);
    if (keys.has(c.key)) fail(`The key '${c.key}' is in the request twice.`);
    keys.add(c.key);
    if (generation !== undefined && c.generation !== generation) fail('Every claim of a request has the same generation.');
    generation = c.generation;
  });
  if (input.generation !== undefined) {
    if (!Number.isInteger(input.generation) || input.generation < 1) fail('generation must be an integer from 1.');
    if (generation !== undefined && input.generation !== generation) fail('generation must be the generation of the claims.');
  }
  return rule;
}

function checkClaim(hub: HubDefinition, rule: KindRule, c: ClaimInput, at: string): void {
  if (!isObject(c)) fail(`${at} must be an object.`);
  const allowed = ['key', 'kind', 'confidence', 'method', 'generation', 'seen', 'fields', 'sources'];
  if (hub.subjects === 'contacts') allowed.push('subject', 'other');
  for (const k of Object.keys(c)) if (!allowed.includes(k)) fail(`${at}: unknown property '${k}'.`);
  if (typeof c.key !== 'string' || c.key.length < 1 || c.key.length > 200) fail(`${at}: key must have 1 to 200 characters.`);
  if (c.kind !== rule.kind) fail(`${at}: the kind must be '${rule.kind}' in this scope.`);
  if (typeof c.confidence !== 'number' || !(c.confidence >= 0 && c.confidence <= 1)) fail(`${at}: confidence must be from 0 to 1.`);
  if (typeof c.method !== 'string' || c.method.length > 200 || !METHOD.test(c.method)) fail(`${at}: method must be like rule:name/1.`);
  if (!Number.isInteger(c.generation) || c.generation < 1) fail(`${at}: generation must be an integer from 1.`);
  if (c.seen !== undefined) {
    if (!isObject(c.seen) || !isUtc(c.seen.first) || !isUtc(c.seen.last) || Object.keys(c.seen).length !== 2) {
      fail(`${at}: seen is { first, last } in UTC.`);
    }
    if (Date.parse(c.seen.first) > Date.parse(c.seen.last)) fail(`${at}: seen.first is after seen.last.`);
  }
  if (!isObject(c.fields)) fail(`${at}: fields must be an object.`);
  for (const k of Object.keys(c.fields)) if (!rule.fields.includes(k)) fail(`${at}: a ${rule.kind} has no field '${k}'.`);
  const missing = missingRequired(rule, c.fields);
  if (missing) fail(`${at}: a ${rule.kind} needs ${missing}.`);
  for (const l of rule.lists ?? []) if (c.fields[l] !== undefined && !Array.isArray(c.fields[l])) fail(`${at}: ${l} must be a list.`);
  const errors = hub.fieldErrors?.(rule.kind, c.fields) ?? [];
  if (errors.length > 0) fail(`${at}: fields do not match the ${rule.kind} schema: ${errors.slice(0, 3).join('; ')}.`);
  if (c.sources !== undefined) {
    if (!Array.isArray(c.sources) || c.sources.length > 100) fail(`${at}: at most 100 sources.`);
    c.sources.forEach((s) => checkRef(s, at));
  }
  if (hub.subjects === 'contacts') {
    checkSubject(c.subject, `${at}.subject`);
    if (c.other !== undefined) {
      if (!rule.other) fail(`${at}: a ${rule.kind} has no other.`);
      checkSubject(c.other, `${at}.other`);
    } else if (rule.other === 'required') {
      fail(`${at}: a ${rule.kind} needs other.`);
    }
  }
}

const BASE_OPS: CorrectionOp[] = ['set', 'clear', 'reject', 'restore', 'merge', 'create'];

/** Checks one correction and returns it in its stored form (without anchors, which the hub sets). */
export function checkCorrection(hub: HubDefinition, value: unknown, at: string): Correction {
  if (!isObject(value)) fail(`${at} must be an object.`);
  const v = value as Record<string, unknown>;
  const ops = [...BASE_OPS, ...(hub.extraOps ?? [])];
  const props = ['id', 'op', 'app', 'createdAt', 'record', 'records', 'kind', 'fields', 'names', 'sources', 'anchors'];
  if (hub.subjects === 'contacts') props.push('person', 'other');
  for (const k of Object.keys(v)) if (!props.includes(k)) fail(`${at}: unknown property '${k}'.`);
  if (typeof v.id !== 'string' || !CORRECTION_ID.test(v.id)) fail(`${at}: id must be cor_ and 32 lowercase hex digits.`);
  if (!ops.includes(v.op as CorrectionOp)) fail(`${at}: Memex.${hubTitle(hub)} has no op '${String(v.op)}'.`);
  if (typeof v.app !== 'string' || !APP.test(v.app)) fail(`${at}: invalid app '${String(v.app)}'.`);
  if (!isUtc(v.createdAt)) fail(`${at}: createdAt must be a UTC time with Z.`);
  const op = v.op as CorrectionOp;
  const allowed: Record<CorrectionOp, string[]> = {
    set: ['record', 'fields'],
    clear: ['record', 'names'],
    reject: ['record'],
    restore: ['record'],
    unmerge: ['record'],
    merge: ['records'],
    pin: ['records'],
    unpin: ['records'],
    create: ['record', 'kind', 'fields', 'sources', 'person', 'other'],
  };
  for (const k of ['record', 'records', 'kind', 'fields', 'names', 'sources', 'person', 'other']) {
    if (v[k] !== undefined && !allowed[op].includes(k)) fail(`${at}: ${op} has no '${k}'.`);
  }
  const c: Correction = { id: v.id as string, op, app: v.app as string, createdAt: v.createdAt as string };
  if (v.anchors !== undefined) {
    // Apps do not send anchors; a correction read back from an export keeps the ones the hub stored.
    const ok =
      Array.isArray(v.anchors) &&
      v.anchors.length <= 100 &&
      v.anchors.every(
        (a) =>
          isObject(a) &&
          typeof a.scope === 'string' &&
          SCOPE.test(a.scope) &&
          typeof a.key === 'string' &&
          a.key.length >= 1 &&
          a.key.length <= 200 &&
          (a.partition === undefined || typeof a.partition === 'string') &&
          Object.keys(a).every((k) => ['scope', 'partition', 'key'].includes(k)),
      );
    if (!ok) fail(`${at}: anchors are { scope, partition?, key }.`);
    c.anchors = v.anchors as Correction['anchors'];
  }
  const kindOf = (id: unknown, where: string): KindRule => {
    const k = typeof id === 'string' ? idKind(id) : undefined;
    const rule = hub.kinds.find((r) => r.kind === k);
    if (!rule) fail(`${at}: ${where} is not a record id of Memex.${hubTitle(hub)}.`);
    return rule!;
  };

  if (op === 'merge' || op === 'pin' || op === 'unpin') {
    const records = v.records;
    if (!Array.isArray(records) || records.length < 2 || new Set(records).size !== records.length) {
      fail(`${at}: ${op} needs two or more different record ids.`);
    }
    const kinds = new Set((records as unknown[]).map((r, i) => kindOf(r, `records[${i}]`).kind));
    if (kinds.size !== 1) fail(`${at}: ${op} joins records of one kind.`);
    if (op !== 'merge' && ((records as unknown[]).length !== 2 || !kinds.has('person'))) fail(`${at}: ${op} takes two persons.`);
    c.records = [...(records as string[])];
    return c;
  }
  if (op === 'create') {
    const rule = hub.kinds.find((r) => r.kind === v.kind);
    if (!rule) fail(`${at}: Memex.${hubTitle(hub)} has no kind '${String(v.kind)}'.`);
    c.kind = rule!.kind;
    if (v.record !== undefined) {
      if (kindOf(v.record, 'record') !== rule) fail(`${at}: the record of a create starts with '${rule!.kind}_'.`);
      c.record = v.record as string;
    }
    const fields = checkFields(hub, rule!, v.fields, at, false);
    const missing = missingRequired(rule!, fields);
    if (missing) fail(`${at}: a ${rule!.kind} needs ${missing}.`);
    c.fields = fields;
    if (v.sources !== undefined) {
      if (!Array.isArray(v.sources) || v.sources.length < 1 || v.sources.length > 100) fail(`${at}: sources has 1 to 100 entries.`);
      (v.sources as unknown[]).forEach((s) => checkRef(s, at));
      c.sources = v.sources as Correction['sources'];
    }
    if (hub.subjects === 'contacts' && rule!.kind !== 'person') {
      if (typeof v.person !== 'string' || idKind(v.person) !== 'person') fail(`${at}: a create of a ${rule!.kind} needs person.`);
      c.person = v.person as string;
      if (v.other !== undefined) {
        if (!rule!.other || typeof v.other !== 'string' || idKind(v.other) !== 'person') fail(`${at}: invalid other.`);
        c.other = v.other as string;
      } else if (rule!.other === 'required') {
        fail(`${at}: a create of a ${rule!.kind} needs other.`);
      }
    } else if (v.person !== undefined || v.other !== undefined) {
      fail(`${at}: a create of a ${rule!.kind} has no person or other.`);
    }
    return c;
  }
  const rule = kindOf(v.record, 'record');
  c.record = v.record as string;
  if (op === 'unmerge' && rule.kind !== 'person') fail(`${at}: unmerge takes a person.`);
  if (op === 'set') c.fields = checkFields(hub, rule, v.fields, at, true);
  if (op === 'clear') {
    const names = v.names;
    if (!Array.isArray(names) || names.length === 0 || new Set(names).size !== names.length) fail(`${at}: clear needs names.`);
    for (const n of names as unknown[]) if (typeof n !== 'string' || !rule.fields.includes(n)) fail(`${at}: a ${rule.kind} has no field '${String(n)}'.`);
    c.names = [...(names as string[])];
  }
  return c;
}

function checkFields(hub: HubDefinition, rule: KindRule, value: unknown, at: string, edits: boolean): Record<string, unknown> {
  if (!isObject(value)) fail(`${at}: fields must be an object.`);
  // The JSON form: a field with the value undefined is not stored.
  const fields = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  if (Object.keys(fields).length === 0) fail(`${at}: fields needs at least one field.`);
  for (const [k, f] of Object.entries(fields)) {
    if (!rule.fields.includes(k)) fail(`${at}: a ${rule.kind} has no field '${k}'.`);
    const isList = (rule.lists ?? []).includes(k);
    if (isList) {
      if (edits && isListEdit(f)) {
        const edit = f as { add?: unknown[]; remove?: unknown[] };
        for (const part of [edit.add ?? [], edit.remove ?? []]) {
          const errors = hub.fieldErrors?.(rule.kind, { [k]: part }, k) ?? [];
          if (errors.length > 0) fail(`${at}: ${k} does not match the ${rule.kind} schema: ${errors.slice(0, 3).join('; ')}.`);
        }
        continue;
      }
      if (!Array.isArray(f)) fail(`${at}: ${k} must be a list${edits ? ' or { add, remove }' : ''}.`);
    } else if (isListEdit(f)) {
      fail(`${at}: ${k} is not a list field.`);
    }
    // A set checks each value on its own; a create checks the whole fields object below.
    if (edits) {
      const errors = hub.fieldErrors?.(rule.kind, fields, k) ?? [];
      if (errors.length > 0) fail(`${at}: ${k} does not match the ${rule.kind} schema: ${errors.slice(0, 3).join('; ')}.`);
    }
  }
  if (!edits) {
    const errors = hub.fieldErrors?.(rule.kind, fields) ?? [];
    if (errors.length > 0) fail(`${at}: fields do not match the ${rule.kind} schema: ${errors.slice(0, 3).join('; ')}.`);
  }
  return fields;
}
