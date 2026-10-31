// The facts engine: claims per producer scope, joins by kind, combining, corrections,
// and the change feed, on a hub's own SQLite database (contracts/facts.md).
//
// Every write stores its input, then makes the records of the kinds that it touched
// again from all their claims and corrections, in one transaction. A record keeps
// its id: a claim joins the record it was in before when the join rule still allows
// it, and a new record takes the id of the claim that started it. The records are
// compared with the stored ones; only a record whose content changed gets a new
// version and a change in the feed. So a write that repeats the last one changes
// nothing.
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { factId } from '@tjalve/memex-schema';
import { migrate, type SqliteDatabase } from '@tjalve/memex-sqlite';
import { claimOrigin, combine, emptyFold, foldCorrection, strongerFirst, type CombineClaim, type Fold } from './combine.js';
import { joinFunction, type HubDefinition, type JoinCluster, type JoinItem, type KindRule } from './kinds.js';
import {
  FactsError,
  type Change,
  type ChangesListInput,
  type ClaimRef,
  type ClaimsWriteInput,
  type ClaimsWriteOutput,
  type Correction,
  type CorrectionResult,
  type CorrectionsWriteInput,
  type CorrectionsWriteOutput,
  type FactsRecordOut,
  type ListInput,
  type Page,
  type Ref,
  type ReviewReason,
  type Seen,
  type Subject,
} from './types.js';
import { checkClaimsWrite, checkCorrection, hubTitle, idKind, MAX_CORRECTIONS } from './validate.js';
import {
  gapDays,
  instant,
  isLocation,
  normalizeText,
  periodBefore,
  periodStart,
  spanInterval,
  valueKey,
  type Interval,
} from './values.js';

/** The folder of the engine's migrations (scope 'memex-facts'). */
export const FACTS_MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
export const FACTS_SCOPE = 'memex-facts';

const REVIEW_ORDER: ReviewReason[] = ['low-confidence', 'conflict', 'suggested-end', 'gap', 'possible-duplicate'];
const OWNER = 'owner';

export interface FactsOptions {
  hub: HubDefinition;
  /** The clock, for tests. Default: the system time. */
  now?: () => string;
  /** 32 lowercase hex digits for new record and change ids, for tests. Default: random. */
  randomHex?: () => string;
}

interface ClaimRow {
  seq: number;
  scope: string;
  key: string;
  partition: string | null;
  kind: string;
  subject: string | null;
  other: string | null;
  confidence: number;
  method: string;
  generation: number;
  seen_first: string | null;
  seen_last: string | null;
  fields: string;
  sources: string;
  state: 'active' | 'withdrawn';
  person: string | null;
  cluster_id: string | null;
  record_id: string | null;
}

interface Claim extends CombineClaim {
  kind: string;
  subject?: Subject;
  other?: Subject;
  generation: number;
  sources: Ref[];
  clusterId: string | null;
  recordId: string | null;
  person: string | null;
}

interface Extra {
  /** merge: the claim keys of each record when it was stored. */
  anchorsBy?: Record<string, ClaimRef[]>;
  /** create in Memex.Contacts: the person (and other) after redirects when it was stored. */
  person?: string;
  other?: string;
  /** Stored and not applied. */
  held?: { code: 'required-field' | 'not-merged'; message: string };
}

interface StoredCorrection {
  seq: number;
  c: Correction;
  sortAt: number;
  extra: Extra;
}

interface RecordRow {
  id: string;
  kind: string;
  person: string | null;
  version: number;
  removed: number;
  merged_into: string | null;
  body: string;
  created_at: string;
  updated_at: string;
}

interface Cluster extends JoinCluster {
  person: string;
  other: string | null;
  claims: Claim[];
  /** The create corrections of the records that the person made in this cluster. */
  creates: StoredCorrection[];
  /** For a redirect-mode merge: the claims of this cluster alone. */
  ownClaims?: Claim[];
}

/** What one recompute did, for the counts of a write. */
interface Outcome {
  created: Set<string>;
  updated: Set<string>;
  removed: Set<string>;
  touched: Set<string>;
}

interface IdentityFact {
  person: string;
  value: string;
  from?: string;
  to?: string;
  shared: boolean;
}

class Rollback extends Error {
  constructor(readonly value: unknown) {
    super('dry run');
  }
}

/** Opens the facts engine on a hub's database: applies its migrations (outside a transaction) and checks the hub. */
export function openFacts(db: SqliteDatabase, options: FactsOptions): FactsEngine {
  migrate(db, FACTS_SCOPE, FACTS_MIGRATIONS_DIR);
  return new FactsEngine(db, options);
}

export class FactsEngine {
  readonly hub: HubDefinition;
  private readonly rules: Map<string, KindRule>;
  private readonly now: () => string;
  private readonly randomHex: () => string;

  constructor(
    readonly db: SqliteDatabase,
    options: FactsOptions,
  ) {
    this.hub = options.hub;
    this.rules = new Map(options.hub.kinds.map((k) => [k.kind, k]));
    this.now = options.now ?? (() => new Date().toISOString());
    this.randomHex = options.randomHex ?? (() => randomBytes(16).toString('hex'));
    const stored = db.get<{ value: string }>("SELECT value FROM facts_meta WHERE key = 'hub'");
    if (!stored) db.run("INSERT INTO facts_meta (key, value) VALUES ('hub', ?)", this.hub.name);
    else if (stored.value !== this.hub.name) {
      throw new FactsError('wrong-hub', `This database belongs to Memex.${stored.value}, not Memex.${hubTitle(this.hub)}.`);
    }
  }

  // ---------------------------------------------------------------- claims

  /**
   * Replaces the claims of a scope (or of one partition of it). Refuses a lower
   * generation than the last one stored for the scope or partition (409,
   * stale-generation) and a request that is wrong (400); both store nothing.
   */
  writeClaims(input: ClaimsWriteInput): ClaimsWriteOutput {
    const rule = checkClaimsWrite(this.hub, input);
    if (input.idempotencyKey !== undefined && !input.dryRun) {
      const done = this.db.get<{ result: string }>('SELECT result FROM facts_write WHERE idempotency_key = ?', input.idempotencyKey);
      if (done) return JSON.parse(done.result) as ClaimsWriteOutput;
    }
    return this.maybeDry(input.dryRun, () => this.writeClaimsNow(input, rule));
  }

  private writeClaimsNow(input: ClaimsWriteInput, rule: KindRule): ClaimsWriteOutput {
    const partition = input.partition ?? null;
    const generation = input.generation ?? input.claims[0]?.generation;
    const partitioned = this.db.get<{ n: number }>(
      "SELECT count(*) AS n FROM facts_scope WHERE scope = ? AND partition <> ''",
      input.scope,
    )!.n;
    const whole = this.db.get<{ n: number }>("SELECT count(*) AS n FROM facts_scope WHERE scope = ? AND partition = ''", input.scope)!.n;
    if ((partition === null && partitioned > 0) || (partition !== null && whole > 0)) {
      throw new FactsError('invalid', `The scope '${input.scope}' uses partitions always or never.`);
    }
    const last = this.db.get<{ generation: number }>(
      'SELECT generation FROM facts_scope WHERE scope = ? AND partition = ?',
      input.scope,
      partition ?? '',
    );
    if (generation === undefined && last) {
      // Without a generation a late retry of an empty run would withdraw newer claims.
      throw new FactsError(
        'invalid',
        `The scope '${input.scope}'${partition ? ` (partition ${partition})` : ''} has generation ${last.generation}; an empty claims write needs generation.`,
      );
    }
    if (generation !== undefined && last && generation < last.generation) {
      throw new FactsError(
        'stale-generation',
        `The scope '${input.scope}'${partition ? ` (partition ${partition})` : ''} has generation ${last.generation}; this write has ${generation}.`,
      );
    }
    const now = this.now();
    let claimChanges = 0;
    const kinds = new Set<string>([rule.kind]);
    for (const c of input.claims) {
      const row = this.db.get<ClaimRow>('SELECT * FROM facts_claim WHERE scope = ? AND key = ?', input.scope, c.key);
      const values = [
        partition,
        c.kind,
        c.subject === undefined ? null : JSON.stringify(c.subject),
        c.other === undefined ? null : JSON.stringify(c.other),
        c.confidence,
        c.method,
        c.generation,
        c.seen?.first ?? null,
        c.seen?.last ?? null,
        JSON.stringify(c.fields),
        JSON.stringify(c.sources ?? []),
      ] as const;
      if (!row) {
        this.db.run(
          `INSERT INTO facts_claim (scope, key, partition, kind, subject, other, confidence, method, generation,
             seen_first, seen_last, fields, sources, state, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
          input.scope,
          c.key,
          ...values,
          now,
        );
        claimChanges += 1;
        continue;
      }
      const same =
        row.state === 'active' &&
        row.partition === values[0] &&
        row.kind === values[1] &&
        row.subject === values[2] &&
        row.other === values[3] &&
        row.confidence === values[4] &&
        row.method === values[5] &&
        row.seen_first === values[7] &&
        row.seen_last === values[8] &&
        row.fields === values[9] &&
        row.sources === values[10];
      if (same && row.generation === c.generation) continue;
      this.db.run(
        `UPDATE facts_claim SET partition = ?, kind = ?, subject = ?, other = ?, confidence = ?, method = ?, generation = ?,
           seen_first = ?, seen_last = ?, fields = ?, sources = ?, state = 'active', updated_at = ?
         WHERE seq = ?`,
        ...values,
        now,
        row.seq,
      );
      if (!same) {
        claimChanges += 1;
        kinds.add(row.kind);
      }
    }
    // Claims of the scope (or partition) that are not in the request are withdrawn.
    const keys = new Set(input.claims.map((c) => c.key));
    const active = this.db.all<{ seq: number; key: string; kind: string }>(
      "SELECT seq, key, kind FROM facts_claim WHERE scope = ? AND partition IS ? AND state = 'active'",
      input.scope,
      partition,
    );
    let withdrawn = 0;
    for (const a of active) {
      if (keys.has(a.key)) continue;
      this.db.run("UPDATE facts_claim SET state = 'withdrawn', updated_at = ? WHERE seq = ?", now, a.seq);
      withdrawn += 1;
      kinds.add(a.kind);
    }
    if (generation !== undefined) {
      this.db.run(
        `INSERT INTO facts_scope (scope, partition, generation, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (scope, partition) DO UPDATE SET generation = excluded.generation, updated_at = excluded.updated_at`,
        input.scope,
        partition ?? '',
        generation,
        now,
      );
    }
    const outcome = this.recompute(kinds);

    const records: { key: string; id: string | null }[] = [];
    let unresolved = 0;
    const mine = new Set<string>();
    for (const c of input.claims) {
      const row = this.db.get<{ record_id: string | null }>('SELECT record_id FROM facts_claim WHERE scope = ? AND key = ?', input.scope, c.key)!;
      records.push({ key: c.key, id: row.record_id });
      if (row.record_id === null) unresolved += 1;
      else mine.add(row.record_id);
    }
    const created = [...outcome.created].length;
    const updated = [...outcome.updated].length;
    const removed = [...outcome.removed].length;
    const unchanged = [...mine].filter((id) => !outcome.created.has(id) && !outcome.updated.has(id)).length;
    const changed = claimChanges + withdrawn + created + updated + removed > 0;
    const counts: ClaimsWriteOutput['counts'] = { created, updated, unchanged, withdrawn, removed };
    if (this.hub.subjects === 'contacts') counts.unresolved = unresolved;
    const result: ClaimsWriteOutput = {
      changeId: changed ? this.newChangeId() : null,
      summary: claimsSummary(rule, counts),
      counts,
      records,
    };
    if (result.changeId !== null || input.idempotencyKey !== undefined) {
      this.db.run(
        'INSERT INTO facts_write (change_id, kind, idempotency_key, result, at) VALUES (?, ?, ?, ?, ?)',
        result.changeId ?? this.newChangeId(),
        'claims',
        input.idempotencyKey ?? null,
        JSON.stringify(result),
        now,
      );
    }
    return result;
  }

  /** The claims of a scope (and partition), with the record of each. */
  listClaims(scope: string, partition?: string): ClaimListItem[] {
    const rows =
      partition === undefined
        ? this.db.all<ClaimRow>("SELECT * FROM facts_claim WHERE scope = ? AND state = 'active' ORDER BY seq", scope)
        : this.db.all<ClaimRow>("SELECT * FROM facts_claim WHERE scope = ? AND partition = ? AND state = 'active' ORDER BY seq", scope, partition);
    return rows.map((r) => this.claimOut(r));
  }

  private claimOut(r: ClaimRow): ClaimListItem {
    const c = toClaim(r);
    return {
      scope: c.scope,
      ...(c.partition !== null ? { partition: c.partition } : {}),
      claim: {
        key: c.key,
        kind: c.kind,
        ...(c.subject ? { subject: c.subject } : {}),
        ...(c.other ? { other: c.other } : {}),
        confidence: c.confidence,
        method: c.method,
        generation: c.generation,
        ...(c.seen ? { seen: c.seen } : {}),
        fields: c.fields,
        sources: c.sources,
      },
      record: c.recordId,
    };
  }

  // ---------------------------------------------------------------- corrections

  /**
   * Stores corrections, each once by its id, and applies them in createdAt order.
   * Refuses the whole call only when the request is wrong (400); it never drops a
   * correction.
   */
  writeCorrections(input: CorrectionsWriteInput): CorrectionsWriteOutput {
    if (typeof input !== 'object' || input === null || !Array.isArray(input.corrections)) {
      throw new FactsError('invalid', 'corrections must be a list.');
    }
    for (const k of Object.keys(input)) {
      if (!['corrections', 'dryRun', 'idempotencyKey'].includes(k)) throw new FactsError('invalid', `Unknown property '${k}'.`);
    }
    if (input.corrections.length < 1 || input.corrections.length > MAX_CORRECTIONS) {
      throw new FactsError('invalid', `One call stores 1 to ${MAX_CORRECTIONS} corrections.`);
    }
    const checked = input.corrections.map((c, i) => checkCorrection(this.hub, c, `corrections[${i}]`));
    return this.maybeDry(input.dryRun, () => this.writeCorrectionsNow(checked));
  }

  private writeCorrectionsNow(corrections: Correction[]): CorrectionsWriteOutput {
    const now = this.now();
    const items: { stored: StoredCorrection; requestId: string; repeat: boolean; repeatOf?: string }[] = [];
    const kinds = new Set<string>();
    let stored = 0;
    for (const input of corrections) {
      const existing = this.correctionById(input.id);
      if (existing) {
        items.push({ stored: existing.stored, requestId: input.id, repeat: true, ...(existing.aliasOf ? { repeatOf: existing.aliasOf } : {}) });
        continue;
      }
      if (input.op === 'create' && input.sources) {
        const earlier = this.findCreateRepeat(input);
        if (earlier) {
          this.db.run('INSERT INTO facts_correction_alias (id, of) VALUES (?, ?)', input.id, earlier.c.id);
          items.push({ stored: earlier, requestId: input.id, repeat: true, repeatOf: earlier.c.id });
          continue;
        }
      }
      const s = this.storeCorrection(input, now);
      stored += 1;
      items.push({ stored: s, requestId: input.id, repeat: false });
      for (const id of [s.c.record, ...(s.c.records ?? [])]) {
        const k = id ? idKind(id) : undefined;
        if (k) kinds.add(k);
      }
      if (s.c.kind) kinds.add(s.c.kind);
    }
    if (stored > 0) this.recompute(kinds);

    this.targetIndex = undefined;
    const results = items.map((item) => this.resultFor(item.stored, item.requestId, item.repeat, item.repeatOf));
    this.targetIndex = undefined;
    const result: CorrectionsWriteOutput = {
      changeId: stored > 0 ? this.newChangeId() : null,
      summary: correctionsSummary(stored, results),
      corrections: items.map((i) => i.stored.c),
      results,
    };
    if (result.changeId) {
      this.db.run(
        'INSERT INTO facts_write (change_id, kind, idempotency_key, result, at) VALUES (?, ?, NULL, ?, ?)',
        result.changeId,
        'corrections',
        JSON.stringify(result),
        now,
      );
    }
    return result;
  }

  private storeCorrection(input: Correction, now: string): StoredCorrection {
    const c: Correction = { ...input };
    delete c.anchors;
    const extra: Extra = {};
    // A create never takes over an id that a record, a claim, or another create holds: it gets a new one,
    // which its result gives.
    if (c.op === 'create' && (c.record === undefined || this.recordIdInUse(c.record))) c.record = `${c.kind}_${this.randomHex()}`;
    if (c.op === 'create' && this.hub.subjects === 'contacts') {
      // Records made after a merge stay with the person that stayed.
      if (c.person) extra.person = this.followPerson(c.person);
      if (c.other) extra.other = this.followPerson(c.other);
    }
    if (c.record && c.op !== 'create') {
      const target = this.resolveStored(c.record, []);
      // Anchors come from the record now. A correction that comes back from the archive into a
      // new database keeps the anchors it had, so it finds its record when the claims arrive.
      const anchors = target.id ? this.claimKeysOf(target.id) : (input.anchors ?? []);
      if (anchors.length > 0) c.anchors = anchors.slice(0, 100);
      if (c.op === 'clear' && target.id && !target.held) {
        const rule = this.rules.get(idKind(target.id)!)!;
        const holders = this.claimsOfRecord(target.id);
        const empty = c.names!.filter(
          (n) => (rule.required.includes(n) || (rule.requireOneOf ?? []).includes(n)) && !holders.some((h) => h.fields[n] !== undefined),
        );
        const oneOfLeft = rule.requireOneOf
          ? rule.requireOneOf.some((f) => !c.names!.includes(f) && this.recordHasField(target.id!, f))
          : true;
        const blocking = empty.filter((n) => rule.required.includes(n) || !oneOfLeft);
        if (blocking.length > 0) {
          extra.held = {
            code: 'required-field',
            message: `The ${rule.kind} needs ${blocking.join(' and ')}, and no app gives a value, so the person's value stays.`,
          };
        }
      }
      if (c.op === 'unmerge' && this.personRedirects().get(c.record) === undefined) {
        extra.held = { code: 'not-merged', message: `${this.nameOf(c.record)} is not merged into another person.` };
      }
    }
    if (c.op === 'merge') {
      const by: Record<string, ClaimRef[]> = {};
      const flat: ClaimRef[] = [];
      for (const id of c.records!) {
        const t = this.resolveStored(id, []);
        const keys = t.id ? this.claimKeysOf(t.id) : [];
        if (keys.length > 0) by[id] = keys;
        flat.push(...keys);
      }
      if (flat.length > 0) {
        c.anchors = flat.slice(0, 100);
        extra.anchorsBy = by;
      }
    }
    const ordered = orderCorrection(c);
    const res = this.db.run(
      'INSERT INTO facts_correction (id, op, record, sort_at, body, extra, stored_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      c.id,
      c.op,
      c.record ?? c.records?.[0] ?? null,
      sortKey(c.createdAt),
      JSON.stringify(ordered),
      JSON.stringify(extra),
      now,
    );
    return { seq: Number(res.lastInsertRowid), c: ordered, sortAt: Date.parse(c.createdAt), extra };
  }

  private correctionById(id: string): { stored: StoredCorrection; aliasOf?: string } | undefined {
    const row = this.db.get<CorrectionRowDb>('SELECT * FROM facts_correction WHERE id = ?', id);
    if (row) return { stored: fromCorrectionRow(row) };
    const alias = this.db.get<{ of: string }>('SELECT of FROM facts_correction_alias WHERE id = ?', id);
    if (!alias) return undefined;
    const of = this.db.get<CorrectionRowDb>('SELECT * FROM facts_correction WHERE id = ?', alias.of)!;
    return { stored: fromCorrectionRow(of), aliasOf: alias.of };
  }

  /** An earlier create with the same kind, sources, and fields. */
  private findCreateRepeat(c: Correction): StoredCorrection | undefined {
    const sources = valueKey([...(c.sources ?? [])].map(valueKey).sort());
    const fields = valueKey(c.fields);
    for (const row of this.db.all<CorrectionRowDb>("SELECT * FROM facts_correction WHERE op = 'create' ORDER BY seq")) {
      const s = fromCorrectionRow(row);
      if (s.c.kind !== c.kind || !s.c.sources) continue;
      if (valueKey([...s.c.sources].map(valueKey).sort()) === sources && valueKey(s.c.fields) === fields) return s;
    }
    return undefined;
  }

  private resultFor(s: StoredCorrection, requestId: string, repeat: boolean, repeatOf?: string): CorrectionResult {
    const base: CorrectionResult = { id: requestId, status: 'applied', repeat, ...(repeatOf ? { repeatOf } : {}) };
    const c = s.c;
    const withRecord = (id: string | undefined): CorrectionResult => {
      if (!id) return base;
      const row = this.db.get<RecordRow>('SELECT * FROM facts_record WHERE id = ?', id);
      if (!row) return { ...base, record: id };
      const body = JSON.parse(row.body) as FactsRecordOut;
      return { ...base, record: id, version: row.version, state: body.state };
    };
    if (c.op === 'pin' || c.op === 'unpin') return base;
    if (s.extra.held) {
      const target = c.record ? this.resolveStored(c.record, c.anchors ?? []) : { id: undefined };
      return { ...withRecord(target.id ?? c.record), status: 'held', reason: { ...s.extra.held } };
    }
    if (c.op === 'merge') return withRecord(this.resolveStored(c.records![0]!, []).id ?? c.records![0]);
    if (c.op === 'unmerge') return withRecord(c.record);
    if (c.op === 'create') {
      const r = withRecord(this.resolveStored(c.record!, []).id ?? c.record);
      if (repeatOf && r.state === 'rejected') {
        return { ...r, status: 'held', reason: { code: 'record-rejected', message: 'The person removed this record. It can be restored.' } };
      }
      return r;
    }
    const target = this.resolveFor(s);
    if (target.held) {
      return {
        ...withRecord(target.id),
        status: 'held',
        reason:
          target.held === 'record-removed'
            ? { code: 'record-removed', message: 'The record lost all its claims. The correction applies when it comes back.' }
            : { code: 'unknown-record', message: 'Memex does not know this record.' },
      };
    }
    const r = withRecord(target.id);
    // Corrections with a later createdAt win.
    const later = this.correctionsFor(target.id!).filter(
      (o) => (o.sortAt > s.sortAt || (o.sortAt === s.sortAt && o.seq > s.seq)) && !o.extra.held,
    );
    if (c.op === 'reject' || c.op === 'restore') {
      return later.some((o) => o.c.op === 'reject' || o.c.op === 'restore') ? { ...r, status: 'superseded' } : r;
    }
    const names = c.op === 'set' ? Object.keys(c.fields!) : c.names!;
    const overridden = names.filter((n) =>
      later.some((o) => (o.c.op === 'clear' && o.c.names!.includes(n)) || (o.c.op === 'set' && o.c.fields![n] !== undefined && !isEdit(o.c.fields![n]))),
    );
    if (overridden.length === names.length) return { ...r, status: 'superseded' };
    return overridden.length > 0 ? { ...r, overridden } : r;
  }

  private targetIndex: Map<string, StoredCorrection[]> | undefined;

  /** Corrections whose record resolves to this record now (for overridden and superseded). */
  private correctionsFor(recordId: string): StoredCorrection[] {
    if (!this.targetIndex) {
      const index = new Map<string, StoredCorrection[]>();
      for (const s of this.allCorrections()) {
        if (!s.c.record || s.c.op === 'create' || s.c.op === 'unmerge') continue;
        const t = this.resolveFor(s).id;
        if (t) index.set(t, [...(index.get(t) ?? []), s]);
      }
      this.targetIndex = index;
    }
    return this.targetIndex.get(recordId) ?? [];
  }

  /** Corrections in the order in which they apply: createdAt, then arrival. */
  listCorrections(input: { record?: string; limit?: number; cursor?: string } = {}): Page<Correction> {
    const limit = Math.min(Math.max(input.limit ?? 500, 1), 5000);
    const offset = input.cursor !== undefined ? pageOffset(input.cursor) : 0;
    this.targetIndex = undefined;
    const all = input.record ? this.correctionsFor(this.resolveStored(input.record, []).id ?? input.record) : this.allCorrections();
    const page = all.slice(offset, offset + limit).map((s) => s.c);
    return { items: page, next: offset + limit < all.length ? String(offset + limit) : null };
  }

  /** Memex.Contacts: the pairs of persons that the person keeps apart. */
  pins(): [string, string][] {
    const pins = new Map<string, [string, string]>();
    for (const s of this.allCorrections()) {
      if (s.c.op === 'pin' || s.c.op === 'unpin') {
        const pair = [...s.c.records!].sort() as [string, string];
        if (s.c.op === 'pin') pins.set(pair.join(' '), pair);
        else pins.delete(pair.join(' '));
      } else if (s.c.op === 'merge') {
        for (const [k, pair] of pins) if (s.c.records!.includes(pair[0]) && s.c.records!.includes(pair[1])) pins.delete(k);
      }
    }
    return [...pins.values()];
  }

  // ---------------------------------------------------------------- reads

  getRecord(id: string): FactsRecordOut | undefined {
    const row = this.db.get<RecordRow>('SELECT * FROM facts_record WHERE id = ? AND removed = 0', id);
    return row ? (JSON.parse(row.body) as FactsRecordOut) : undefined;
  }

  /** The id that a record id leads to now, following merges. undefined when the record is removed or unknown. */
  followRecord(id: string): string | undefined {
    const t = this.resolveStored(id, []);
    return t.held ? undefined : t.id;
  }

  listRecords(kind: string, input: ListInput = {}): Page<FactsRecordOut> {
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 1000);
    const offset = input.cursor !== undefined ? pageOffset(input.cursor) : 0;
    const person = input.person && this.hub.subjects === 'contacts' ? this.followPerson(input.person) : undefined;
    const rows = this.db.all<RecordRow & { start_key: string | null; sort_name: string | null }>(
      `SELECT * FROM facts_record WHERE kind = ? AND removed = 0
       ORDER BY start_key IS NULL, start_key DESC, sort_name, id`,
      kind,
    );
    const from = input.from ? instant(periodStart(input.from)) : -Infinity;
    const to = input.to ? spanInterval(input.to, input.to)!.end : Infinity;
    const items = rows
      .map((r) => JSON.parse(r.body) as FactsRecordOut)
      .filter((r) => input.includeRejected || r.state !== 'rejected')
      .filter((r) => input.includeMerged || r.mergedInto === undefined)
      .filter((r) => input.review === undefined || r.review === input.review)
      .filter((r) => !person || r.person === person || (r.kind === 'person' && r.id === person))
      .filter((r) => {
        if (!input.from && !input.to) return true;
        const span = this.recordSpan(r);
        return !span || (span.end >= from && span.start <= to);
      });
    return { items: items.slice(offset, offset + limit), next: offset + limit < items.length ? String(offset + limit) : null };
  }

  /** The change feed: changes after `since`, oldest first. */
  listChanges(input: ChangesListInput = {}): Page<Change> {
    const limit = Math.min(Math.max(input.limit ?? 500, 1), 5000);
    const since = input.since ? cursorSeq(input.since) : 0;
    const kinds = input.kinds && input.kinds.length > 0 ? input.kinds : undefined;
    const person = input.person ? this.followPerson(input.person) : undefined;
    const rows = this.db.all<{
      seq: number;
      op: 'upsert' | 'remove';
      id: string;
      kind: string;
      person: string | null;
      version: number;
      at: string;
      record: string | null;
      merged_into: string | null;
    }>(
      `SELECT * FROM facts_change WHERE seq > ?
         ${kinds ? `AND kind IN (${kinds.map(() => '?').join(', ')})` : ''}
         ${person ? 'AND person = ?' : ''}
       ORDER BY seq LIMIT ?`,
      since,
      ...(kinds ?? []),
      ...(person ? [person] : []),
      limit + 1,
    );
    const items = rows.slice(0, limit).map((r): Change => ({
      cursor: cursorOf(r.seq),
      op: r.op,
      id: r.id,
      kind: r.kind,
      ...(r.person !== null ? { person: r.person } : {}),
      version: r.version,
      at: r.at,
      ...(r.record !== null ? { record: JSON.parse(r.record) as FactsRecordOut } : {}),
      ...(r.merged_into !== null ? { mergedInto: r.merged_into } : {}),
    }));
    return { items, next: rows.length > limit ? items[items.length - 1]!.cursor : null };
  }

  /** Makes every record again from the stored claims and corrections, for example after an import of corrections. */
  rebuild(): { created: number; updated: number; removed: number } {
    const o = this.db.transaction(() => this.recompute(new Set(this.hub.kinds.map((k) => k.kind))));
    return { created: o.created.size, updated: o.updated.size, removed: o.removed.size };
  }

  // ---------------------------------------------------------------- recompute

  private recompute(dirty: Set<string>): Outcome {
    const outcome: Outcome = { created: new Set(), updated: new Set(), removed: new Set(), touched: new Set() };
    let kinds = [...dirty].filter((k) => this.rules.has(k));
    // In Memex.Contacts every subject resolves through persons and identities.
    if (this.hub.subjects === 'contacts' && (dirty.has('person') || dirty.has('identity'))) kinds = this.hub.kinds.map((k) => k.kind);
    const order = (k: string) => (k === 'person' ? 0 : k === 'identity' ? 1 : 2);
    kinds.sort((a, b) => order(a) - order(b) || this.hub.kinds.findIndex((r) => r.kind === a) - this.hub.kinds.findIndex((r) => r.kind === b));
    const corrections = this.allCorrections();
    for (const kind of kinds) this.computeKind(this.rules.get(kind)!, corrections, outcome);
    return outcome;
  }

  private computeKind(rule: KindRule, corrections: StoredCorrection[], outcome: Outcome): void {
    const kind = rule.kind;
    const claims = this.db
      .all<ClaimRow>("SELECT * FROM facts_claim WHERE kind = ? AND state = 'active' ORDER BY seq", kind)
      .map(toClaim);
    const join = joinFunction(rule.join);
    const ofKind = (id: string | undefined) => id !== undefined && idKind(id) === kind;
    const redirects = this.mergeRedirects(corrections, kind, rule.merge === 'redirect');
    const follow = (id: string) => followChain(redirects, id);
    const personFollow = this.hub.subjects === 'contacts' ? this.personRedirectsFrom(corrections) : new Map<string, string>();
    const followP = (id: string) => followChain(personFollow, id);
    const livePersons = new Set(
      this.db.all<{ id: string }>("SELECT id FROM facts_record WHERE kind = 'person' AND removed = 0").map((r) => r.id),
    );
    const cardPerson = new Map<string, string>();
    if (this.hub.subjects === 'contacts' && kind !== 'person') {
      for (const r of this.db.all<{ subject: string; cluster_id: string | null }>(
        "SELECT subject, cluster_id FROM facts_claim WHERE kind = 'person' AND state = 'active'",
      )) {
        const s = JSON.parse(r.subject) as Subject;
        if ('card' in s && r.cluster_id) cardPerson.set(s.card, r.cluster_id);
      }
    }
    let identities: IdentityFact[] = kind === 'identity' ? [] : this.storedIdentities();

    const resolve = (s: Subject | undefined): string | null => {
      if (this.hub.subjects === 'owner') return OWNER;
      if (!s) return null;
      if ('person' in s) {
        const p = followP(s.person);
        return livePersons.has(p) ? p : null;
      }
      if ('card' in s) {
        const p = cardPerson.get(s.card);
        return p ? followP(p) : null;
      }
      return resolveHandle(identities, s.handle, s.at, followP);
    };

    // The records that the person rejected now, by their own id. Their claims stay in them and other
    // claims do not join them, so a reject never hides a record that the person did not reject.
    const rejectedIds = new Set<string>();
    {
      const last = new Map<string, string>();
      for (const s of corrections) {
        if (!s.extra.held && (s.c.op === 'reject' || s.c.op === 'restore') && ofKind(s.c.record)) last.set(s.c.record!, s.c.op);
      }
      for (const [id, op] of last) if (op === 'reject') rejectedIds.add(id);
    }

    // Records that the person made start their clusters, in the order they were made.
    const clusters: Cluster[] = [];
    const used = new Set<string>();
    const creates = corrections.filter((s) => s.c.op === 'create' && ofKind(s.c.record));
    for (const s of creates) {
      const person = this.hub.subjects === 'owner' ? OWNER : kind === 'person' ? s.c.record! : followP(s.extra.person ?? s.c.person!);
      const other = s.extra.other ?? s.c.other;
      const fields = { ...s.c.fields };
      for (const o of corrections) {
        if (o.c.op === 'set' && o.c.record === s.c.record) Object.assign(fields, plainFields(o.c.fields!));
      }
      clusters.push({
        id: s.c.record!,
        person,
        other: other ? followP(other) : null,
        claims: [],
        creates: [s],
        items: [{ fields, span: itemSpan(rule, fields), other: other ? followP(other) : null }],
      });
      used.add(s.c.record!);
    }

    const assign = new Map<number, Cluster>();
    const place = (c: Claim) => {
      if (kind === 'person' && this.hub.subjects === 'contacts') {
        c.person = null; // set to its cluster below
      } else {
        c.person = resolve(c.subject);
        if (c.person === null) return;
      }
      let other: string | null = null;
      if (rule.other) {
        other = c.other ? resolve(c.other) : null;
        if (c.other && other === null) return;
      }
      const item: JoinItem = { fields: c.fields, span: itemSpan(rule, c.fields, c.seen), other };
      const own = c.clusterId !== null && rejectedIds.has(c.clusterId) ? c.clusterId : undefined;
      let target: Cluster | undefined;
      if (own !== undefined) {
        target = clusters.find((k) => k.id === own);
        if (!target && !used.has(own)) {
          used.add(own);
          target = { id: own, person: c.person ?? own, other, claims: [], creates: [], items: [] };
          clusters.push(target);
        }
      }
      if (!target) {
        const bucket = clusters.filter(
          (k) => ((kind === 'person' && this.hub.subjects === 'contacts') || k.person === c.person) && !rejectedIds.has(k.id),
        );
        const candidates = join(item, bucket) as Cluster[];
        target = candidates.find((k) => k.id === c.clusterId) ?? candidates[0];
      }
      if (!target) {
        const id = this.pickId(rule, c, used);
        used.add(id);
        target = { id, person: c.person ?? id, other, claims: [], creates: [], items: [] };
        clusters.push(target);
      }
      if (kind === 'person' && this.hub.subjects === 'contacts') c.person = target.id;
      target.claims.push(c);
      target.items.push(item);
      assign.set(c.seq, target);
    };

    if (kind === 'identity' && this.hub.subjects === 'contacts') {
      // Handles resolve against the identities of cards and persons, so those come first.
      const byHandle = (c: Claim) => c.subject !== undefined && 'handle' in c.subject;
      for (const c of claims) if (!byHandle(c)) place(c);
      identities = clusters.flatMap((k) => identityFacts(k));
      for (const c of claims) if (byHandle(c)) place(c);
    } else {
      for (const c of claims) place(c);
    }

    // Merges: a merged cluster joins the cluster it was merged into.
    const byId = new Map(clusters.map((k) => [k.id, k]));
    const finalOf = (k: Cluster): Cluster => {
      const t = byId.get(follow(k.id));
      return t ?? k;
    };
    const redirected: Cluster[] = [];
    for (const k of clusters) {
      const t = finalOf(k);
      if (t === k) continue;
      if (rule.merge === 'redirect') {
        k.ownClaims = [...k.claims];
        t.claims.push(...k.claims);
        t.creates.push(...k.creates);
        k.claims = [];
        redirected.push(k);
      } else {
        t.claims.push(...k.claims);
        t.creates.push(...k.creates);
        k.claims = [];
        k.creates = [];
      }
    }
    const live = clusters.filter((k) => finalOf(k) === k);

    // Corrections: each applies to the record its record id (or one of its anchors) leads to.
    const anchorOwner = new Map<string, string>();
    for (const k of live) for (const c of k.claims) anchorOwner.set(`${c.scope}\n${c.key}`, k.id);
    const removedKnown = new Set(
      this.db.all<{ id: string }>('SELECT id FROM facts_record WHERE kind = ? AND removed = 1 AND merged_into IS NULL', kind).map((r) => r.id),
    );
    // A key that comes back after a withdrawal and joins another record: its earlier record leads there,
    // so the corrections on the earlier id apply again.
    const returned = new Map<string, string>();
    for (const c of claims) {
      const k = assign.get(c.seq);
      if (!k || c.recordId !== null || c.clusterId === null || byId.has(c.clusterId) || !removedKnown.has(c.clusterId)) continue;
      returned.set(c.clusterId, finalOf(k).id);
    }
    const knownIds = new Set(this.db.all<{ id: string }>('SELECT id FROM facts_record WHERE kind = ?', kind).map((r) => r.id));
    const claimKeys = (k: Cluster) => k.claims.map((c) => `${c.scope}\n${c.key}`);
    // reject and restore apply only to the record that they name, never through a merge.
    const rejectTargetOf = (id: string, anchors: ClaimRef[]): string | undefined => {
      const k = byId.get(id);
      if (k) return finalOf(k) === k ? k.id : undefined;
      if (knownIds.has(id)) return undefined;
      // After a rebuild: the record that holds the anchors and no other claims.
      const keys = new Set(anchors.map((a) => `${a.scope}\n${a.key}`));
      for (const a of anchors) {
        const owner = anchorOwner.get(`${a.scope}\n${a.key}`);
        if (owner && claimKeys(byId.get(owner)!).every((x) => keys.has(x))) return owner;
      }
      return undefined;
    };
    const targetOf = (id: string, anchors: ClaimRef[]): string | undefined => {
      const k = byId.get(id);
      if (k) return finalOf(k).id;
      const f = follow(id);
      if (f !== id && byId.has(f)) return finalOf(byId.get(f)!).id;
      const r = returned.get(id);
      if (r !== undefined) return r;
      if (removedKnown.has(id)) return undefined;
      for (const a of anchors) {
        const owner = anchorOwner.get(`${a.scope}\n${a.key}`);
        if (owner) return owner;
      }
      return undefined;
    };
    const folds = new Map<string, Fold>(live.map((k) => [k.id, emptyFold()]));
    for (const s of corrections) {
      const c = s.c;
      if (s.extra.held) continue;
      if (c.op === 'create') {
        if (!ofKind(c.record)) continue;
        const k = byId.get(c.record!);
        if (k) foldCorrection(folds.get(finalOf(k).id)!, c);
        continue;
      }
      if (c.op === 'merge') {
        if (!ofKind(c.records![0])) continue;
        const t = targetOf(c.records![0]!, s.extra.anchorsBy?.[c.records![0]!] ?? []);
        if (t) folds.get(t)!.touched = true;
        continue;
      }
      if (!['set', 'clear', 'reject', 'restore'].includes(c.op) || !ofKind(c.record)) continue;
      const t = c.op === 'reject' || c.op === 'restore' ? rejectTargetOf(c.record!, c.anchors ?? []) : targetOf(c.record!, c.anchors ?? []);
      if (t) foldCorrection(folds.get(t)!, c);
    }

    // Combine, then the rules that look at several records of a subject.
    const now = this.now();
    const made = new Map<string, FactsRecordOut>();
    for (const k of live) {
      if (k.claims.length === 0 && k.creates.length === 0) continue;
      made.set(k.id, this.makeRecord(rule, k, k.claims, folds.get(k.id)!, now));
    }
    for (const k of redirected) {
      const target = finalOf(k).id;
      const r = this.makeRecord(rule, k, k.ownClaims ?? [], emptyFold(), now);
      r.claims = [];
      made.set(k.id, { ...withMergedInto(r, target) });
    }
    this.subjectRules(rule, made);

    // Store the records and the claims' records, and write the feed.
    // A record whose claims all joined one other record leads there, like a merge.
    const movedTo = new Map<string, Set<string>>();
    for (const c of claims) {
      const k = assign.get(c.seq);
      if (!c.recordId || !k) continue;
      movedTo.set(c.recordId, (movedTo.get(c.recordId) ?? new Set()).add(finalOf(k).id));
    }
    const moved = new Map<string, string>();
    for (const [from, to] of movedTo) if (to.size === 1 && !to.has(from)) moved.set(from, [...to][0]!);
    for (const [from, to] of returned) if (!made.has(from)) moved.set(from, to);
    this.persist(rule, made, redirects, outcome, now, moved);
    for (const c of claims) {
      const k = assign.get(c.seq);
      const recordId = k ? finalOf(k).id : null;
      const person = k ? (kind === 'person' && this.hub.subjects === 'contacts' ? k.id : c.person) : null;
      if (c.clusterId !== (k?.id ?? c.clusterId) || c.recordId !== recordId || c.person !== person) {
        this.db.run(
          'UPDATE facts_claim SET cluster_id = ?, record_id = ?, person = ? WHERE seq = ?',
          k?.id ?? c.clusterId,
          recordId,
          person,
          c.seq,
        );
      }
    }
    // Withdrawn claims keep their cluster id for when they come back, but hold no record.
    this.db.run("UPDATE facts_claim SET record_id = NULL WHERE kind = ? AND state = 'withdrawn' AND record_id IS NOT NULL", kind);
  }

  private pickId(rule: KindRule, c: Claim, used: Set<string>): string {
    if (c.clusterId && idKind(c.clusterId) === rule.kind && !used.has(c.clusterId)) return c.clusterId;
    let id = factId(rule.kind, c.scope, c.key);
    for (let n = 2; used.has(id); n += 1) id = factId(rule.kind, c.scope, `${c.key}\n${n}`);
    return id;
  }

  private makeRecord(rule: KindRule, k: Cluster, claims: Claim[], fold: Fold, now: string): FactsRecordOut {
    const combined = combine(rule, claims, fold);
    const origin: 'inferred' | 'user' = k.creates.some((s) => s.c.record === k.id) ? 'user' : 'inferred';
    const confidence = origin === 'user' ? 1 : Math.max(0, ...claims.map((c) => c.confidence));
    const reasons = combined.reasons;
    if (confidence < 0.5 && !fold.touched) reasons.add('low-confidence');
    for (const r of [...reasons]) {
      if (r === 'conflict' && rule.refine?.some((f) => combined.corrected.includes(f))) reasons.delete(r);
    }
    const sources: Ref[] = [];
    const seenRefs = new Set<string>();
    const addRef = (r: Ref) => {
      const key = valueKey(r);
      if (!seenRefs.has(key) && sources.length < 100) {
        seenRefs.add(key);
        sources.push(r);
      }
    };
    for (const s of k.creates) for (const r of s.c.sources ?? []) addRef(r);
    const ordered = [...claims].sort((a, b) => a.seq - b.seq);
    for (const c of ordered) for (const r of c.sources) addRef(r);
    const record: FactsRecordOut = {
      id: k.id,
      kind: rule.kind,
      version: 1,
      state: fold.rejected ? 'rejected' : 'active',
      origin,
      ...(this.hub.subjects === 'contacts' && rule.kind !== 'person' ? { person: k.person } : {}),
      ...(this.hub.subjects === 'contacts' && rule.other && k.other ? { other: k.other } : {}),
      confidence,
      review: false,
      fields: combined.fields,
      provenance: combined.provenance,
      alternatives: combined.alternatives,
      corrected: combined.corrected,
      claims: ordered.map((c) => ({ ...claimOrigin(c), confidence: c.confidence, ...(c.seen ? { seen: c.seen } : {}) })),
      sources,
      createdAt: now,
      updatedAt: now,
    };
    setReview(record, reasons);
    return record;
  }

  /** Suggested ends and possible duplicates: rules over the records of one subject. */
  private subjectRules(rule: KindRule, made: Map<string, FactsRecordOut>): void {
    if (!rule.suggestEnd && !rule.pinAddressDuplicates) return;
    const bySubject = new Map<string, FactsRecordOut[]>();
    for (const r of made.values()) {
      if (r.state !== 'active' || r.mergedInto) continue;
      const s = r.person ?? OWNER;
      bySubject.set(s, [...(bySubject.get(s) ?? []), r]);
    }
    for (const records of bySubject.values()) {
      for (const r of records) {
        const reasons = new Set(r.reviewReasons ?? []);
        const from = r.fields.from;
        if (rule.suggestEnd && typeof from === 'string' && r.fields.to === undefined && !r.corrected.includes('to')) {
          const town = normalizeText(r.fields.town);
          const later = records
            .filter((o) => o !== r && typeof o.fields.from === 'string' && periodStart(o.fields.from as string) > periodStart(from))
            .filter((o) => town !== undefined && normalizeText(o.fields.town) !== undefined && normalizeText(o.fields.town) !== town)
            .sort((a, b) => (periodStart(a.fields.from as string) < periodStart(b.fields.from as string) ? -1 : 1))[0];
          if (later) {
            reasons.add('suggested-end');
            const alts = r.alternatives.to ?? [];
            const coarse = alts.filter((a) => a.reason === 'coarser' || a.reason === 'weaker');
            if (coarse.length > 0) {
              for (const a of coarse) a.reason = 'suggested-end';
            } else {
              const value = periodBefore(later.fields.from as string);
              alts.push({ value, from: later.provenance.from ?? [{ scope: 'unknown.unknown', key: later.id }], reason: 'suggested-end' });
            }
            r.alternatives.to = alts;
            r.alternatives = reorder(r.alternatives, rule.fields);
          }
        }
        if (rule.pinAddressDuplicates) {
          const isPin = (x: FactsRecordOut) => isLocation(x.fields.location) && normalizeText(x.fields.address) === undefined;
          const isText = (x: FactsRecordOut) => !isLocation(x.fields.location) && normalizeText(x.fields.address) !== undefined;
          const dup = records.some((o) => {
            if (o === r || !((isPin(r) && isText(o)) || (isText(r) && isPin(o)))) return false;
            const a = this.recordSpan(r);
            const b = this.recordSpan(o);
            return !a || !b || gapDays(a, b) < 90;
          });
          if (dup) reasons.add('possible-duplicate');
        }
        setReview(r, reasons);
      }
    }
  }

  private persist(
    rule: KindRule,
    made: Map<string, FactsRecordOut>,
    redirects: Map<string, string>,
    outcome: Outcome,
    now: string,
    moved: Map<string, string> = new Map(),
  ): void {
    const stored = new Map(
      this.db.all<RecordRow>('SELECT * FROM facts_record WHERE kind = ?', rule.kind).map((r) => [r.id, r]),
    );
    for (const [id, r] of made) {
      const row = stored.get(id);
      const spanStart = startKey(rule, r);
      const name = sortName(r);
      if (row && row.removed === 0) {
        const old = JSON.parse(row.body) as FactsRecordOut;
        r.createdAt = old.createdAt;
        if (contentKey(old) === contentKey(r)) {
          outcome.touched.add(id);
          continue;
        }
        r.version = row.version + 1;
        r.updatedAt = now;
        this.db.run(
          `UPDATE facts_record SET person = ?, version = ?, merged_into = ?, start_key = ?, sort_name = ?, body = ?, updated_at = ? WHERE id = ?`,
          r.person ?? null,
          r.version,
          r.mergedInto ?? null,
          spanStart,
          name,
          JSON.stringify(r),
          now,
          id,
        );
        outcome.updated.add(id);
      } else if (row) {
        // A record that comes back keeps its id and its creation time.
        r.version = row.version + 1;
        r.createdAt = (JSON.parse(row.body) as FactsRecordOut).createdAt;
        this.db.run(
          `UPDATE facts_record SET person = ?, version = ?, removed = 0, merged_into = ?, start_key = ?, sort_name = ?, body = ?, updated_at = ? WHERE id = ?`,
          r.person ?? null,
          r.version,
          r.mergedInto ?? null,
          spanStart,
          name,
          JSON.stringify(r),
          now,
          id,
        );
        outcome.created.add(id);
      } else {
        this.db.run(
          `INSERT INTO facts_record (id, kind, person, version, removed, merged_into, start_key, sort_name, body, created_at, updated_at)
           VALUES (?, ?, ?, 1, 0, ?, ?, ?, ?, ?, ?)`,
          id,
          rule.kind,
          r.person ?? null,
          r.mergedInto ?? null,
          spanStart,
          name,
          JSON.stringify(r),
          now,
          now,
        );
        outcome.created.add(id);
      }
      this.addChange('upsert', r, now);
    }
    // A record that was made and merged before any reader saw it keeps a redirect row, so its id still leads somewhere.
    if (rule.merge !== 'redirect') {
      for (const [from] of redirects) {
        if (idKind(from) !== rule.kind || stored.has(from) || made.has(from)) continue;
        this.db.run(
          `INSERT INTO facts_record (id, kind, person, version, removed, merged_into, body, created_at, updated_at)
           VALUES (?, ?, NULL, 1, 1, ?, '{}', ?, ?)`,
          from,
          rule.kind,
          followChain(redirects, from),
          now,
          now,
        );
        const target = made.get(followChain(redirects, from));
        this.db.run(
          'INSERT INTO facts_change (op, id, kind, person, version, at, record, merged_into) VALUES (?, ?, ?, ?, 1, ?, NULL, ?)',
          'remove',
          from,
          rule.kind,
          this.hub.subjects === 'contacts' ? (target?.person ?? null) : null,
          now,
          followChain(redirects, from),
        );
      }
    }
    for (const [id, row] of stored) {
      if (made.has(id)) continue;
      if (row.removed === 1) {
        // A removed record whose key came back into another record leads there from now on.
        const to = moved.get(id);
        if (to === undefined || row.merged_into !== null || rule.merge === 'redirect') continue;
        const version = row.version + 1;
        this.db.run('UPDATE facts_record SET version = ?, merged_into = ?, updated_at = ? WHERE id = ?', version, to, now, id);
        this.db.run(
          'INSERT INTO facts_change (op, id, kind, person, version, at, record, merged_into) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)',
          'remove',
          id,
          rule.kind,
          this.hub.subjects === 'contacts' ? (rule.kind === 'person' ? id : row.person) : null,
          version,
          now,
          to,
        );
        continue;
      }
      const target =
        rule.merge === 'redirect' ? undefined : redirects.get(id) !== undefined ? followChain(redirects, id) : moved.get(id);
      const version = row.version + 1;
      this.db.run('UPDATE facts_record SET removed = 1, version = ?, merged_into = ?, updated_at = ? WHERE id = ?', version, target ?? null, now, id);
      this.db.run(
        'INSERT INTO facts_change (op, id, kind, person, version, at, record, merged_into) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)',
        'remove',
        id,
        rule.kind,
        this.hub.subjects === 'contacts' ? (rule.kind === 'person' ? id : row.person) : null,
        version,
        now,
        target ?? null,
      );
      outcome.removed.add(id);
    }
  }

  private addChange(op: 'upsert', r: FactsRecordOut, now: string): void {
    const person = this.hub.subjects === 'contacts' ? (r.kind === 'person' ? r.id : r.person ?? null) : null;
    this.db.run(
      'INSERT INTO facts_change (op, id, kind, person, version, at, record, merged_into) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)',
      op,
      r.id,
      r.kind,
      person,
      r.version,
      now,
      JSON.stringify(r),
    );
  }

  // ---------------------------------------------------------------- helpers over stored state

  private allCorrections(): StoredCorrection[] {
    return this.db.all<CorrectionRowDb>('SELECT * FROM facts_correction ORDER BY sort_at, seq').map(fromCorrectionRow);
  }

  /** The redirects of merges of one kind, in createdAt order; unmerge undoes one (redirect mode). */
  private mergeRedirects(corrections: StoredCorrection[], kind: string, unmerge: boolean): Map<string, string> {
    const map = new Map<string, string>();
    for (const s of corrections) {
      if (s.extra.held) continue;
      if (s.c.op === 'merge' && idKind(s.c.records![0]!) === kind) {
        const [first, ...rest] = s.c.records!;
        for (const r of rest) if (followChain(map, first!) !== r) map.set(r, first!);
      } else if (unmerge && s.c.op === 'unmerge' && idKind(s.c.record!) === kind) {
        map.delete(s.c.record!);
      }
    }
    return map;
  }

  private personRedirectsFrom(corrections: StoredCorrection[]): Map<string, string> {
    return this.mergeRedirects(corrections, 'person', this.rules.get('person')?.merge === 'redirect');
  }

  private personRedirects(): Map<string, string> {
    return this.personRedirectsFrom(this.allCorrections());
  }

  private followPerson(id: string): string {
    return followChain(this.personRedirects(), id);
  }

  /**
   * Where a record id leads in the stored records: through merges to a record,
   * or held as removed or unknown. Anchors find the record after a rebuild.
   */
  private resolveStored(id: string, anchors: ClaimRef[]): { id?: string; held?: 'record-removed' | 'unknown-record' } {
    let current = id;
    for (let i = 0; i < 100; i += 1) {
      const row = this.db.get<RecordRow>('SELECT * FROM facts_record WHERE id = ?', current);
      if (!row) break;
      if (row.merged_into) {
        current = row.merged_into;
        continue;
      }
      if (row.removed === 1) return { id: current, held: 'record-removed' };
      return { id: current };
    }
    for (const a of anchors) {
      const row = this.db.get<{ record_id: string | null }>('SELECT record_id FROM facts_claim WHERE scope = ? AND key = ?', a.scope, a.key);
      if (row?.record_id) return { id: row.record_id };
    }
    return { held: 'unknown-record' };
  }

  /** Where a stored correction applies: reject and restore only to the record that they name. */
  private resolveFor(s: StoredCorrection): { id?: string; held?: 'record-removed' | 'unknown-record' } {
    const c = s.c;
    if (c.op !== 'reject' && c.op !== 'restore') return this.resolveStored(c.record!, c.anchors ?? []);
    const row = this.db.get<RecordRow>('SELECT * FROM facts_record WHERE id = ?', c.record!);
    if (row) return row.removed === 1 || row.merged_into !== null ? { id: row.id, held: 'record-removed' } : { id: row.id };
    // After a rebuild: the record that holds the anchors and no other claims.
    const keys = new Set((c.anchors ?? []).map((a) => `${a.scope}\n${a.key}`));
    for (const a of c.anchors ?? []) {
      const r = this.db.get<{ record_id: string | null }>('SELECT record_id FROM facts_claim WHERE scope = ? AND key = ?', a.scope, a.key);
      if (!r?.record_id) continue;
      if (this.claimKeysOf(r.record_id).every((k) => keys.has(`${k.scope}\n${k.key}`))) return { id: r.record_id };
    }
    return { held: 'unknown-record' };
  }

  /** True when a record, a claim, or a create already holds this record id. */
  private recordIdInUse(id: string): boolean {
    return (
      this.db.get('SELECT 1 AS x FROM facts_record WHERE id = ?', id) !== undefined ||
      this.db.get('SELECT 1 AS x FROM facts_claim WHERE cluster_id = ? OR record_id = ?', id, id) !== undefined ||
      this.db.get("SELECT 1 AS x FROM facts_correction WHERE op = 'create' AND record = ?", id) !== undefined
    );
  }

  private claimKeysOf(recordId: string): ClaimRef[] {
    return this.db
      .all<{ scope: string; partition: string | null; key: string }>(
        "SELECT scope, partition, key FROM facts_claim WHERE record_id = ? AND state = 'active' ORDER BY seq",
        recordId,
      )
      .map((r) => claimOrigin(r));
  }

  private claimsOfRecord(recordId: string): Claim[] {
    return this.db.all<ClaimRow>("SELECT * FROM facts_claim WHERE record_id = ? AND state = 'active' ORDER BY seq", recordId).map(toClaim);
  }

  private recordHasField(recordId: string, field: string): boolean {
    const r = this.getRecord(recordId);
    return r !== undefined && r.fields[field] !== undefined;
  }

  private nameOf(id: string): string {
    const r = this.getRecord(id);
    const name = r?.fields.name ?? r?.fields.title;
    return typeof name === 'string' ? name : id;
  }

  private storedIdentities(): IdentityFact[] {
    if (this.hub.subjects !== 'contacts') return [];
    return this.db
      .all<{ body: string }>("SELECT body FROM facts_record WHERE kind = 'identity' AND removed = 0")
      .map((r) => JSON.parse(r.body) as FactsRecordOut)
      .filter((r) => r.state === 'active' && r.person && typeof r.fields.value === 'string')
      .map((r) => ({
        person: r.person!,
        value: normalizeHandle(r.fields.value as string),
        ...(typeof r.fields.from === 'string' ? { from: r.fields.from } : {}),
        ...(typeof r.fields.to === 'string' ? { to: r.fields.to } : {}),
        shared: r.fields.shared === true,
      }));
  }

  private recordSpan(r: FactsRecordOut): Interval | undefined {
    const rule = this.rules.get(r.kind);
    const span = rule?.spans?.[0];
    if (span) {
      const i = spanInterval(r.fields[span.from], r.fields[span.to]);
      if (i) return i;
    }
    const seen = r.claims.map((c) => c.seen).filter((s): s is Seen => s !== undefined);
    if (seen.length === 0) return undefined;
    return {
      start: Math.min(...seen.map((s) => Date.parse(s.first))),
      end: Math.max(...seen.map((s) => Date.parse(s.last))),
    };
  }

  private newChangeId(): string {
    return `chg_${this.randomHex()}`;
  }

  private maybeDry<T>(dryRun: boolean | undefined, fn: () => T): T {
    if (!dryRun) return this.db.transaction(fn);
    try {
      this.db.transaction(() => {
        const value = fn();
        throw new Rollback(value);
      });
    } catch (error) {
      if (error instanceof Rollback) {
        const value = error.value as Record<string, unknown>;
        return { ...value, changeId: null } as T;
      }
      throw error;
    }
    throw new Error('unreachable');
  }
}

// ---------------------------------------------------------------- free helpers

/** A claim as listClaims returns it. */
export interface ClaimListItem {
  scope: string;
  partition?: string;
  claim: {
    key: string;
    kind: string;
    subject?: Subject;
    other?: Subject;
    confidence: number;
    method: string;
    generation: number;
    seen?: Seen;
    fields: Record<string, unknown>;
    sources: Ref[];
  };
  /** The record that holds the claim now; null while its subject does not resolve. */
  record: string | null;
}

interface CorrectionRowDb {
  seq: number;
  id: string;
  op: string;
  record: string | null;
  sort_at: string;
  body: string;
  extra: string;
}

function fromCorrectionRow(row: CorrectionRowDb): StoredCorrection {
  const c = JSON.parse(row.body) as Correction;
  return { seq: row.seq, c, sortAt: Date.parse(c.createdAt), extra: JSON.parse(row.extra) as Extra };
}

/** A sortable form of a UTC time: milliseconds, zero-padded. */
function sortKey(createdAt: string): string {
  return String(Date.parse(createdAt)).padStart(16, '0');
}

/** The property order of a stored correction, as the fixtures show it. */
function orderCorrection(c: Correction): Correction {
  const out: Record<string, unknown> = {};
  for (const k of ['id', 'op', 'kind', 'record', 'records', 'person', 'other', 'fields', 'names', 'sources', 'app', 'createdAt', 'anchors'] as const) {
    if (c[k] !== undefined) out[k] = c[k];
  }
  return out as unknown as Correction;
}

function toClaim(r: ClaimRow): Claim {
  return {
    seq: r.seq,
    scope: r.scope,
    key: r.key,
    partition: r.partition,
    kind: r.kind,
    ...(r.subject ? { subject: JSON.parse(r.subject) as Subject } : {}),
    ...(r.other ? { other: JSON.parse(r.other) as Subject } : {}),
    confidence: r.confidence,
    method: r.method,
    generation: r.generation,
    ...(r.seen_first && r.seen_last ? { seen: { first: r.seen_first, last: r.seen_last } } : {}),
    fields: JSON.parse(r.fields) as Record<string, unknown>,
    sources: JSON.parse(r.sources) as Ref[],
    clusterId: r.cluster_id,
    recordId: r.record_id,
    person: r.person,
  };
}

function followChain(map: Map<string, string>, id: string): string {
  let current = id;
  for (let i = 0; i < 1000; i += 1) {
    const next = map.get(current);
    if (next === undefined || next === id) return current;
    current = next;
  }
  return current;
}

/** When a claim or a record that the person made was true, or else when its evidence was seen. */
function itemSpan(rule: KindRule, fields: Record<string, unknown>, seen?: Seen): Interval | undefined {
  const span = rule.spans?.[0];
  if (span) {
    const i = spanInterval(fields[span.from], fields[span.to]);
    if (i) return i;
  }
  if (seen) return { start: Date.parse(seen.first), end: Date.parse(seen.last) };
  return undefined;
}

function plainFields(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => !isEdit(v)));
}

function isEdit(v: unknown): boolean {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).length > 0 && Object.keys(v).every((k) => k === 'add' || k === 'remove');
}

function identityFacts(k: Cluster): IdentityFact[] {
  const out: IdentityFact[] = [];
  const items = [...k.claims.map((c) => c.fields), ...k.creates.map((s) => s.c.fields ?? {})];
  for (const f of items) {
    if (typeof f.value !== 'string') continue;
    out.push({
      person: k.person,
      value: normalizeHandle(f.value),
      ...(typeof f.from === 'string' ? { from: f.from } : {}),
      ...(typeof f.to === 'string' ? { to: f.to } : {}),
      shared: f.shared === true,
    });
  }
  return out;
}

function normalizeHandle(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * A handle resolves only when exactly one person holds the identity, valid at
 * the time of the evidence. A shared identity never resolves.
 */
function resolveHandle(identities: IdentityFact[], handle: string, at: string, follow: (id: string) => string): string | null {
  const value = normalizeHandle(handle);
  const t = Date.parse(at);
  const matching = identities.filter((i) => i.value === value);
  if (matching.some((i) => i.shared)) return null;
  const holders = new Set(
    matching
      .filter((i) => {
        const span = spanInterval(i.from, i.to);
        return !span || (t >= span.start && t <= span.end);
      })
      .map((i) => follow(i.person)),
  );
  return holders.size === 1 ? [...holders][0]! : null;
}

function withMergedInto(r: FactsRecordOut, target: string): FactsRecordOut {
  // mergedInto sits after origin, as in the fixtures.
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) {
    out[k] = v;
    if (k === 'origin') out.mergedInto = target;
  }
  return out as unknown as FactsRecordOut;
}

function setReview(r: FactsRecordOut, reasons: Set<ReviewReason>): void {
  if (r.state === 'rejected' || r.mergedInto) reasons.clear();
  const list = REVIEW_ORDER.filter((x) => reasons.has(x));
  r.review = list.length > 0;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) {
    if (k === 'reviewReasons') continue;
    out[k] = v;
    if (k === 'review' && list.length > 0) out.reviewReasons = list;
  }
  for (const k of Object.keys(r)) delete (r as unknown as Record<string, unknown>)[k];
  Object.assign(r, out);
}

function reorder<T>(obj: Record<string, T>, order: string[]): Record<string, T> {
  const out: Record<string, T> = {};
  for (const k of order) if (obj[k] !== undefined) out[k] = obj[k]!;
  for (const k of Object.keys(obj)) if (out[k] === undefined) out[k] = obj[k]!;
  return out;
}

/** The record without the fields that change on every write. */
function contentKey(r: FactsRecordOut): string {
  const { version: _v, createdAt: _c, updatedAt: _u, ...rest } = r;
  return JSON.stringify(rest);
}

function startKey(rule: KindRule, r: FactsRecordOut): string | null {
  const span = rule.spans?.[0];
  const v = span ? r.fields[span.from] : rule.refine?.[0] ? r.fields[rule.refine[0]] : undefined;
  return typeof v === 'string' && !v.startsWith('--') ? periodStart(v) : null;
}

function sortName(r: FactsRecordOut): string | null {
  const v = r.fields.name ?? r.fields.title ?? r.fields.value ?? r.fields.type;
  return typeof v === 'string' ? v.toLowerCase() : null;
}

function cursorOf(seq: number): string {
  return `c_${String(seq).padStart(12, '0')}`;
}

function pageOffset(cursor: string): number {
  if (!/^(0|[1-9]\d{0,8})$/.test(cursor)) throw new FactsError('invalid', `Invalid cursor '${cursor}'.`);
  return Number(cursor);
}

function cursorSeq(cursor: string): number {
  const m = /^c_(\d+)$/.exec(cursor);
  if (!m) throw new FactsError('invalid', `Invalid cursor '${cursor}'.`);
  return Number(m[1]);
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function claimsSummary(rule: KindRule, c: ClaimsWriteOutput['counts']): string {
  const parts: string[] = [];
  if (c.created) parts.push(`${plural(c.created, rule.kind, rule.plural)} added`);
  if (c.updated) parts.push(`${plural(c.updated, rule.kind, rule.plural)} updated`);
  if (c.removed) parts.push(`${plural(c.removed, rule.kind, rule.plural)} removed`);
  if (c.withdrawn) parts.push(`${plural(c.withdrawn, 'claim')} withdrawn`);
  if (c.unresolved) parts.push(`${plural(c.unresolved, 'claim')} waiting for its subject`);
  if (parts.length === 0) return `Nothing changed. ${plural(c.unchanged, rule.kind, rule.plural)} unchanged.`;
  return `${parts.join(', ')}.`.replace(/^./, (x) => x.toUpperCase());
}

function correctionsSummary(stored: number, results: CorrectionResult[]): string {
  const held = results.filter((r) => r.status === 'held').length;
  const repeats = results.filter((r) => r.repeat).length;
  const parts: string[] = [];
  parts.push(stored === 0 ? 'Nothing new stored.' : `${plural(stored, 'correction')} stored.`);
  if (repeats) parts.push(`${plural(repeats, 'correction')} ${repeats === 1 ? 'was' : 'were'} stored before.`);
  if (held) parts.push(`${plural(held, 'correction')} held.`);
  return parts.join(' ');
}
