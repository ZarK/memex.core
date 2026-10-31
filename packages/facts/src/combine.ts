// Combining: how the claims of one record and the person's corrections give its
// fields, its provenance per field and per list element, its alternatives, and
// the review reasons that come from its own values (contracts/facts.md#combining).
import { applyListEdits, isListEdit, type ListEdit } from '@tjalve/memex-schema';
import type { KindRule, SpanRule } from './kinds.js';
import type { Alternatives, ClaimRef, Provenance, ReviewReason, Seen } from './types.js';
import {
  datePrecision,
  gapDays,
  periodEnd,
  periodStart,
  refines,
  spanInterval,
  valueKey,
  type Interval,
} from './values.js';

/** A claim as combining sees it. */
export interface CombineClaim {
  seq: number;
  scope: string;
  partition: string | null;
  key: string;
  confidence: number;
  method: string;
  seen?: Seen;
  fields: Record<string, unknown>;
}

/** The person's decisions for one record, folded in createdAt order. */
export interface Fold {
  /** Fields that the person set, with the correction that set each last. */
  user: Map<string, { value: unknown; correction: string }>;
  /** List edits after the last whole value of the field, in order. */
  edits: Map<string, { edit: ListEdit; correction: string }[]>;
  rejected: boolean;
  /** Any correction applied to the record. */
  touched: boolean;
}

export function emptyFold(): Fold {
  return { user: new Map(), edits: new Map(), rejected: false, touched: false };
}

export interface Combined {
  fields: Record<string, unknown>;
  provenance: Provenance;
  alternatives: Alternatives;
  corrected: string[];
  reasons: Set<ReviewReason>;
}

type Origin = ClaimRef | { correction: string };

export function claimOrigin(c: { scope: string; partition: string | null; key: string }): ClaimRef {
  return c.partition === null ? { scope: c.scope, key: c.key } : { scope: c.scope, partition: c.partition, key: c.key };
}

/** From an address book: the method of a card reader. */
const fromAddressBook = (c: CombineClaim) => c.method.startsWith('card:');

/**
 * Strongest first: the higher confidence; on a tie a value from the address book
 * over an inferred one, then the newer seen.last, then the claim stored first.
 */
export function strongerFirst(a: CombineClaim, b: CombineClaim): number {
  if (a.confidence !== b.confidence) return b.confidence - a.confidence;
  const ab = fromAddressBook(a) ? 0 : 1;
  const bb = fromAddressBook(b) ? 0 : 1;
  if (ab !== bb) return ab - bb;
  const al = a.seen ? Date.parse(a.seen.last) : -Infinity;
  const bl = b.seen ? Date.parse(b.seen.last) : -Infinity;
  if (al !== bl) return bl - al;
  return a.seq - b.seq;
}

const originKey = (o: Origin) => valueKey(o);

/** The origins of claims in the order the claims were first stored. */
const bySeq = (claims: readonly CombineClaim[]): Origin[] => [...claims].sort((a, b) => a.seq - b.seq).map(claimOrigin);

function pushOrigin(list: Origin[], o: Origin): void {
  const k = originKey(o);
  if (!list.some((x) => originKey(x) === k)) list.push(o);
}

class Builder {
  readonly fields: Record<string, unknown> = {};
  readonly provenance: Provenance = {};
  readonly alternatives: Alternatives = {};

  set(name: string, value: unknown, origins: Origin[]): void {
    this.fields[name] = value;
    if (origins.length > 0) this.provenance[name] = origins;
  }

  /** Adds a losing value; the same value with the same reason lists all its origins once. */
  alt(name: string, value: unknown, origin: Origin, reason: 'weaker' | 'coarser' | 'conflict' | 'suggested-end'): void {
    const list = (this.alternatives[name] ??= []);
    const k = valueKey(value);
    const found = list.find((a) => a.reason === reason && valueKey(a.value) === k);
    if (found) pushOrigin(found.from, origin);
    else list.push({ value, from: [origin], reason });
  }
}

/** Groups the claims that give a field by value, strongest claim first. */
function groups(claims: readonly CombineClaim[], name: string): { value: unknown; claims: CombineClaim[] }[] {
  const out: { key: string; value: unknown; claims: CombineClaim[] }[] = [];
  for (const c of claims) {
    const v = c.fields[name];
    if (v === undefined) continue;
    const k = valueKey(v);
    const g = out.find((x) => x.key === k);
    if (g) g.claims.push(c);
    else out.push({ key: k, value: v, claims: [c] });
  }
  return out;
}

/**
 * Combines the claims of a record (strongest first) with the person's fold.
 * `claims` are the claims of the record; `kind` gives the fields, lists, spans,
 * and partial dates.
 */
export function combine(kind: KindRule, claimsIn: readonly CombineClaim[], fold: Fold): Combined {
  const claims = [...claimsIn].sort(strongerFirst);
  const b = new Builder();
  const reasons = new Set<ReviewReason>();
  const spanFields = new Map<string, SpanRule>();
  for (const s of kind.spans ?? []) {
    spanFields.set(s.from, s);
    spanFields.set(s.to, s);
  }
  const lists = new Set(kind.lists ?? []);
  const refine = new Set(kind.refine ?? []);

  // Every field that a claim or the person gives, in the kind's order, then the others by name.
  const present = new Set<string>([...fold.user.keys(), ...fold.edits.keys()]);
  for (const c of claims) for (const k of Object.keys(c.fields)) present.add(k);
  const names = [
    ...kind.fields.filter((f) => present.has(f)),
    ...[...present].filter((f) => !kind.fields.includes(f)).sort(),
  ];

  const precision = (f: Record<string, unknown>) => (kind.precision ? kind.precision(f) : 0);
  const userFields = Object.fromEntries([...fold.user].map(([k, v]) => [k, v.value]));
  const recordPrecision = Math.max(precision(userFields), ...claims.map((c) => precision(c.fields)), 0);

  const doneSpans = new Set<SpanRule>();
  const elementProvenance: [string, Origin[]][] = [];

  for (const name of names) {
    const span = spanFields.get(name);
    if (span) {
      if (!doneSpans.has(span)) {
        doneSpans.add(span);
        combineSpan(span, claims, fold, b, reasons, precision, recordPrecision);
      }
      continue;
    }
    if (lists.has(name)) {
      combineList(name, claims, fold, b, elementProvenance);
      continue;
    }
    if (refine.has(name)) {
      combineRefine(name, claims, fold, b, reasons);
      continue;
    }
    combineSingle(name, claims, fold, b);
  }

  // Fields in the kind's order; list elements after the fields, as the fixtures show them.
  const fields: Record<string, unknown> = {};
  const provenance: Provenance = {};
  for (const name of names) {
    if (b.fields[name] !== undefined) fields[name] = b.fields[name];
    if (b.provenance[name] !== undefined) provenance[name] = b.provenance[name]!;
  }
  for (const [k, v] of elementProvenance) provenance[k] = v;
  const alternatives: Alternatives = {};
  for (const name of names) if (b.alternatives[name]) alternatives[name] = b.alternatives[name]!;

  const corrected = names.filter((n) => fold.user.has(n) || fold.edits.has(n));
  return { fields, provenance, alternatives, corrected, reasons };
}

function combineSingle(name: string, claims: readonly CombineClaim[], fold: Fold, b: Builder): void {
  const gs = groups(claims, name);
  const user = fold.user.get(name);
  if (user) {
    const origins: Origin[] = [{ correction: user.correction }];
    const k = valueKey(user.value);
    for (const g of gs) {
      if (valueKey(g.value) === k) for (const o of bySeq(g.claims)) pushOrigin(origins, o);
      else for (const c of g.claims) b.alt(name, g.value, claimOrigin(c), 'weaker');
    }
    b.set(name, user.value, origins);
    return;
  }
  const [winner, ...losers] = gs;
  if (!winner) return;
  b.set(name, winner.value, bySeq(winner.claims));
  for (const g of losers) for (const c of g.claims) b.alt(name, g.value, claimOrigin(c), 'weaker');
}

function combineRefine(name: string, claims: readonly CombineClaim[], fold: Fold, b: Builder, reasons: Set<ReviewReason>): void {
  const gs = groups(claims, name);
  const user = fold.user.get(name);
  let winner: unknown;
  let origins: Origin[];
  let rest: typeof gs;
  if (user) {
    winner = user.value;
    origins = [{ correction: user.correction }];
    rest = gs;
  } else {
    if (gs.length === 0) return;
    // The most precise value wins; among equals, the strongest claim (gs is in that order).
    let best = gs[0]!;
    for (const g of gs) if (datePrecision(g.value) > datePrecision(best.value)) best = g;
    winner = best.value;
    origins = bySeq(best.claims);
    rest = gs.filter((g) => g !== best);
  }
  const k = valueKey(winner);
  for (const g of rest) {
    if (valueKey(g.value) === k) {
      for (const o of bySeq(g.claims)) pushOrigin(origins, o);
    } else if (refines(winner, g.value)) {
      // 1984 and 1984-03-12 give 1984-03-12 with both sources; the coarser value stays as an alternative.
      for (const c of g.claims) {
        pushOrigin(origins, claimOrigin(c));
        b.alt(name, g.value, claimOrigin(c), 'coarser');
      }
    } else if (user) {
      for (const c of g.claims) b.alt(name, g.value, claimOrigin(c), 'weaker');
    } else {
      for (const c of g.claims) b.alt(name, g.value, claimOrigin(c), 'conflict');
      reasons.add('conflict');
    }
  }
  b.set(name, winner, origins);
}

function combineList(
  name: string,
  claims: readonly CombineClaim[],
  fold: Fold,
  b: Builder,
  elementProvenance: [string, Origin[]][],
): void {
  // The union of the claims, strongest claim first, each element with the claims that give it.
  const union: { key: string; value: unknown; origins: Origin[] }[] = [];
  for (const c of claims) {
    const list = c.fields[name];
    if (!Array.isArray(list)) continue;
    for (const v of list) {
      const k = valueKey(v);
      const e = union.find((x) => x.key === k);
      if (e) pushOrigin(e.origins, claimOrigin(c));
      else union.push({ key: k, value: v, origins: [claimOrigin(c)] });
    }
  }
  // Each element lists the claims that give it in the order the claims were first stored.
  const ordered = [...claims].sort((a, b) => a.seq - b.seq);
  for (const e of union) {
    e.origins = ordered
      .filter((c) => Array.isArray(c.fields[name]) && (c.fields[name] as unknown[]).some((v) => valueKey(v) === e.key))
      .map(claimOrigin);
  }
  const user = fold.user.get(name);
  const edits = fold.edits.get(name) ?? [];
  const fieldOrigins: Origin[] = [];
  let elements: { key: string; value: unknown; origins: Origin[] }[];
  if (user && Array.isArray(user.value)) {
    pushOrigin(fieldOrigins, { correction: user.correction });
    elements = user.value.map((v) => {
      const k = valueKey(v);
      const origins: Origin[] = [{ correction: user.correction }];
      for (const o of union.find((x) => x.key === k)?.origins ?? []) pushOrigin(origins, o);
      return { key: k, value: v, origins };
    });
  } else {
    elements = union.map((e) => ({ ...e, origins: [...e.origins] }));
  }
  for (const { edit, correction } of edits) {
    pushOrigin(fieldOrigins, { correction });
    // applyListEdits gives the order; the origins follow each element.
    const next = applyListEdits(
      elements.map((e) => e.value),
      [edit],
    );
    const added = new Set((edit.add ?? []).map(valueKey));
    elements = next.map((v) => {
      const k = valueKey(v);
      const e = elements.find((x) => x.key === k);
      const origins = e ? e.origins : [];
      if (added.has(k)) origins.unshift({ correction });
      return { key: k, value: v, origins: dedupe(origins) };
    });
  }
  if (!user && edits.length === 0 && elements.length === 0) return;
  for (const e of elements) for (const o of e.origins) if (!('correction' in o)) pushOrigin(fieldOrigins, o);
  b.set(
    name,
    elements.map((e) => e.value),
    fieldOrigins,
  );
  elements.forEach((e, i) => {
    if (e.origins.length > 0) elementProvenance.push([`${name}/${i}`, e.origins]);
  });
}

function dedupe(origins: Origin[]): Origin[] {
  const out: Origin[] = [];
  for (const o of origins) pushOrigin(out, o);
  return out;
}

function combineSpan(
  span: SpanRule,
  claims: readonly CombineClaim[],
  fold: Fold,
  b: Builder,
  reasons: Set<ReviewReason>,
  precision: (f: Record<string, unknown>) => number,
  recordPrecision: number,
): void {
  const has = (c: CombineClaim, f: string) => typeof c.fields[f] === 'string';
  // The claims that make the span: confidence 0.5 or higher, at the record's precision.
  const atPrecision = claims.filter((c) => precision(c.fields) === recordPrecision && (has(c, span.from) || has(c, span.to)));
  let contributing = atPrecision.filter((c) => c.confidence >= 0.5);
  // A record whose claims are all below 0.5 still has its span: from those claims (it is on review as low-confidence).
  if (contributing.length === 0) contributing = atPrecision;
  const others = claims.filter((c) => !contributing.includes(c));
  const startOf = (v: string) => (span.type === 'date' ? periodStart(v) : v);
  const endOf = (v: string) => (span.type === 'date' ? periodEnd(v) : v);
  const cmp = (a: string, b2: string) => (span.type === 'time' ? Date.parse(a) - Date.parse(b2) : a < b2 ? -1 : a > b2 ? 1 : 0);

  for (const side of ['from', 'to'] as const) {
    const name = side === 'from' ? span.from : span.to;
    const vals = contributing.filter((c) => has(c, name));
    const top = Math.max(0, ...vals.map((c) => datePrecision(c.fields[name])));
    const fine = vals.filter((c) => datePrecision(c.fields[name]) === top);
    const coarse = vals.filter((c) => datePrecision(c.fields[name]) < top);
    const user = fold.user.get(name);
    const userPrecision = user ? datePrecision(user.value) : 0;

    for (const c of coarse) b.alt(name, c.fields[name], claimOrigin(c), 'coarser');
    for (const c of others) {
      if (!has(c, name)) continue;
      const coarser =
        precision(c.fields) < recordPrecision || datePrecision(c.fields[name]) < Math.max(top, userPrecision);
      b.alt(name, c.fields[name], claimOrigin(c), coarser ? 'coarser' : 'weaker');
    }

    if (user) {
      const origins: Origin[] = [{ correction: user.correction }];
      const k = valueKey(user.value);
      for (const c of [...fine].sort((x, y) => x.seq - y.seq)) {
        if (valueKey(c.fields[name]) === k) pushOrigin(origins, claimOrigin(c));
        else b.alt(name, c.fields[name], claimOrigin(c), datePrecision(c.fields[name]) < userPrecision ? 'coarser' : 'weaker');
      }
      b.set(name, user.value, origins);
      continue;
    }
    if (side === 'to' && !fold.user.has(span.from)) {
      // An open end: a claim with a start and no end says the fact is still true.
      const open = contributing.some((c) => has(c, span.from) && !has(c, span.to));
      if (open) {
        for (const c of fine) b.alt(name, c.fields[name], claimOrigin(c), 'weaker');
        continue;
      }
    }
    if (fine.length === 0) continue;
    let best = fine[0]!.fields[name] as string;
    for (const c of fine) {
      const v = c.fields[name] as string;
      if (side === 'from' ? cmp(startOf(v), startOf(best)) < 0 : cmp(endOf(v), endOf(best)) > 0) best = v;
    }
    b.set(
      name,
      best,
      bySeq(fine.filter((c) => c.fields[name] === best)),
    );
  }

  // A gap of more than 90 days between the joined claims goes to review.
  if (!fold.user.has(span.from) && !fold.user.has(span.to)) {
    const intervals = contributing
      .map((c) => spanInterval(c.fields[span.from], c.fields[span.to]))
      .filter((i): i is Interval => i !== undefined)
      .sort((x, y) => x.start - y.start);
    let reach: Interval | undefined;
    for (const i of intervals) {
      if (reach && gapDays(reach, i) > 90) reasons.add('gap');
      reach = reach ? { start: reach.start, end: Math.max(reach.end, i.end) } : i;
    }
  }
}

/** Folds one correction into a record's state. Returns false when it changes nothing that folding tracks. */
export function foldCorrection(
  fold: Fold,
  c: { id: string; op: string; fields?: Record<string, unknown>; names?: string[] },
): void {
  fold.touched = true;
  if (c.op === 'set' || c.op === 'create') {
    for (const [name, value] of Object.entries(c.fields ?? {})) {
      if (c.op === 'set' && isListEdit(value)) {
        const list = fold.edits.get(name) ?? [];
        list.push({ edit: value, correction: c.id });
        fold.edits.set(name, list);
      } else {
        fold.user.set(name, { value, correction: c.id });
        fold.edits.delete(name);
      }
    }
  } else if (c.op === 'clear') {
    for (const name of c.names ?? []) {
      fold.user.delete(name);
      fold.edits.delete(name);
    }
  } else if (c.op === 'reject') {
    fold.rejected = true;
  } else if (c.op === 'restore') {
    fold.rejected = false;
  }
}
