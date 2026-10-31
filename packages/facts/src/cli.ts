#!/usr/bin/env node
// memex-facts: replay claims and corrections into a facts database, and read it back.
//
//   memex-facts replay <file.jsonl> --db <file> [--hub user|contacts]
//   memex-facts records --db <file> [--kind <kind>] [--json]
//   memex-facts changes --db <file> [--since <cursor>]
//   memex-facts corrections --db <file>
//
// Each line of a replay file is one request: a claims write ({ scope, partition?,
// claims }) or a corrections write ({ corrections }), as the hubs take them over HTTP.
import { readFileSync } from 'node:fs';
import { openDatabase, type SqliteDatabase } from '@tjalve/memex-sqlite';
import { nodeSqlite } from '@tjalve/memex-sqlite/node-sqlite';
import { openFacts, type FactsEngine } from './engine.js';
import { contactsHub, userHub, type HubDefinition } from './kinds.js';
import { FactsError, type ClaimsWriteInput, type CorrectionsWriteInput, type FactsRecordOut } from './types.js';

const USAGE = `Usage:
  memex-facts replay <file.jsonl> --db <file> [--hub user|contacts]
  memex-facts records --db <file> [--kind <kind>] [--json]
  memex-facts changes --db <file> [--since <cursor>]
  memex-facts corrections --db <file>`;

interface Args {
  command: string;
  positional: string[];
  options: Map<string, string | true>;
}

function parseArgs(argv: string[]): Args {
  const [command = '', ...rest] = argv;
  const positional: string[] = [];
  const options = new Map<string, string | true>();
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i]!;
    if (a.startsWith('--')) {
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith('--') && a !== '--json') {
        options.set(a.slice(2), next);
        i += 1;
      } else {
        options.set(a.slice(2), true);
      }
    } else {
      positional.push(a);
    }
  }
  return { command, positional, options };
}

function hubOf(db: SqliteDatabase, requested: string | true | undefined): HubDefinition {
  let name = typeof requested === 'string' ? requested : undefined;
  if (!name) {
    try {
      name = db.get<{ value: string }>("SELECT value FROM facts_meta WHERE key = 'hub'")?.value;
    } catch {
      // A new database has no facts tables yet.
    }
  }
  if (!name || name === 'user') return userHub;
  if (name === 'contacts') return contactsHub;
  throw new FactsError('invalid', `Unknown hub '${name}': use user or contacts.`);
}

function open(args: Args): { db: SqliteDatabase; facts: FactsEngine } {
  const path = args.options.get('db');
  if (typeof path !== 'string') throw new FactsError('invalid', '--db <file> is required.');
  const db = openDatabase(path, { driver: nodeSqlite, idleCheckpointMs: 0 });
  return { db, facts: openFacts(db, { hub: hubOf(db, args.options.get('hub')) }) };
}

const out = (line = '') => process.stdout.write(`${line}\n`);

function lastCursor(facts: FactsEngine): string | null {
  let cursor: string | undefined;
  let next: string | null = null;
  do {
    const page = facts.listChanges({ ...(cursor ? { since: cursor } : {}), limit: 5000 });
    if (page.items.length > 0) cursor = page.items[page.items.length - 1]!.cursor;
    next = page.next;
  } while (next);
  return cursor ?? null;
}

function replay(args: Args): number {
  const file = args.positional[0];
  if (!file) throw new FactsError('invalid', 'replay needs a .jsonl file.');
  const { db, facts } = open(args);
  const before = lastCursor(facts);
  let refused = 0;
  let claims = 0;
  let corrections = 0;
  const lines = readFileSync(file, 'utf-8').split(/\r?\n/);
  lines.forEach((text, i) => {
    if (text.trim() === '') return;
    const n = i + 1;
    let request: Record<string, unknown>;
    try {
      request = JSON.parse(text) as Record<string, unknown>;
    } catch {
      out(`line ${n}: not valid JSON`);
      refused += 1;
      return;
    }
    try {
      if (Array.isArray(request.corrections)) {
        const r = facts.writeCorrections(request as unknown as CorrectionsWriteInput);
        corrections += r.corrections.length;
        out(`line ${n}  corrections  ${r.summary}${r.changeId ? `  ${r.changeId}` : ''}`);
        for (const x of r.results) {
          const extra = [
            x.repeat ? 'repeat' : '',
            x.repeatOf ? `of ${x.repeatOf}` : '',
            x.overridden ? `overridden ${x.overridden.join(',')}` : '',
            x.reason ? `${x.reason.code}: ${x.reason.message}` : '',
          ].filter(Boolean);
          out(`  ${x.id} ${x.status}${x.record ? ` ${x.record} v${x.version} ${x.state}` : ''}${extra.length ? ` (${extra.join('; ')})` : ''}`);
        }
      } else {
        const input = request as unknown as ClaimsWriteInput;
        const r = facts.writeClaims(input);
        claims += input.claims.length;
        const c = r.counts;
        const gen = input.claims[0]?.generation;
        out(
          `line ${n}  ${input.scope}${input.partition ? `/${input.partition}` : ''}${gen ? ` gen ${gen}` : ''}  ${input.claims.length} claims: ` +
            `created ${c.created}, updated ${c.updated}, unchanged ${c.unchanged}, withdrawn ${c.withdrawn}, removed ${c.removed}` +
            `${c.unresolved !== undefined ? `, unresolved ${c.unresolved}` : ''}  ${r.changeId ?? 'no change'}`,
        );
      }
    } catch (error) {
      if (!(error instanceof FactsError)) throw error;
      refused += 1;
      out(`line ${n}  refused (${error.status} ${error.code}): ${error.message}`);
    }
  });
  const after = lastCursor(facts);
  const changes = before === after ? 0 : facts.listChanges({ ...(before ? { since: before } : {}), limit: 5000 }).items.length;
  out();
  out(`replayed ${claims} claims and ${corrections} corrections; ${refused} requests refused`);
  out(`change feed: ${changes} new changes (cursor ${before ?? 'none'} -> ${after ?? 'none'})`);
  const counts = facts.hub.kinds
    .map((k) => [k.kind, facts.listRecords(k.kind, { includeRejected: true, includeMerged: true, limit: 1000 }).items.length] as const)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k} ${n}`);
  out(`records: ${counts.join(', ') || 'none'}`);
  db.close();
  return refused > 0 ? 2 : 0;
}

function originText(o: Record<string, unknown>, apps: Map<string, string>): string {
  if (typeof o.correction === 'string') return `correction ${o.correction} (${apps.get(o.correction) ?? '?'})`;
  return `${String(o.scope)}${o.partition ? `/${String(o.partition)}` : ''} ${String(o.key)}`;
}

function show(value: unknown): string {
  const text = JSON.stringify(value);
  return text.length > 70 ? `${text.slice(0, 67)}...` : text;
}

function printRecord(r: FactsRecordOut, apps: Map<string, string>): void {
  const flags = [
    `v${r.version}`,
    r.state,
    r.origin,
    `confidence ${r.confidence}`,
    r.person ? `person ${r.person}` : '',
    r.mergedInto ? `merged into ${r.mergedInto}` : '',
    r.review ? `review: ${(r.reviewReasons ?? []).join(', ')}` : '',
  ].filter(Boolean);
  out(`${r.kind} ${r.id}  ${flags.join('  ')}`);
  const names = [...Object.keys(r.fields), ...Object.keys(r.alternatives).filter((k) => !(k in r.fields))];
  for (const name of names) {
    const value = r.fields[name];
    const from = (r.provenance[name] ?? []).map((o) => originText(o as unknown as Record<string, unknown>, apps));
    out(`  ${name.padEnd(13)} ${value === undefined ? '(no value)' : show(value)}`);
    if (value !== undefined) out(`  ${''.padEnd(13)}   from ${from.join('; ') || '-'}`);
    if (Array.isArray(value)) {
      value.forEach((_, i) => {
        const e = r.provenance[`${name}/${i}`];
        if (e) out(`  ${''.padEnd(13)}   [${i}] from ${e.map((o) => originText(o as unknown as Record<string, unknown>, apps)).join('; ')}`);
      });
    }
    for (const a of r.alternatives[name] ?? []) {
      out(`  ${''.padEnd(13)}   alternative ${show(a.value)} (${a.reason}) from ${a.from.map((o) => originText(o as unknown as Record<string, unknown>, apps)).join('; ')}`);
    }
  }
  if (r.corrected.length > 0) out(`  corrected: ${r.corrected.join(', ')}`);
  out(`  claims: ${r.claims.map((c) => `${c.scope} ${c.key} (${c.confidence})`).join('; ') || 'none'}`);
}

function records(args: Args): number {
  const { db, facts } = open(args);
  const kind = args.options.get('kind');
  const kinds = typeof kind === 'string' ? [kind] : facts.hub.kinds.map((k) => k.kind);
  const apps = new Map(facts.listCorrections({ limit: 5000 }).items.map((c) => [c.id, c.app]));
  const all: FactsRecordOut[] = [];
  for (const k of kinds) all.push(...facts.listRecords(k, { includeRejected: true, includeMerged: true, limit: 1000 }).items);
  if (args.options.has('json')) out(JSON.stringify(all, null, 2));
  else
    for (const r of all) {
      printRecord(r, apps);
      out();
    }
  db.close();
  return 0;
}

function changes(args: Args): number {
  const { db, facts } = open(args);
  const since = args.options.get('since');
  const page = facts.listChanges({ ...(typeof since === 'string' ? { since } : {}), limit: 5000 });
  for (const c of page.items) {
    out(`${c.cursor}  ${c.op.padEnd(6)} ${c.id} v${c.version}${c.mergedInto ? ` merged into ${c.mergedInto}` : ''}${c.record ? ` ${c.record.state}` : ''}`);
  }
  out(`${page.items.length} changes${page.next ? `; more after ${page.next}` : ''}`);
  db.close();
  return 0;
}

function corrections(args: Args): number {
  const { db, facts } = open(args);
  for (const c of facts.listCorrections({ limit: 5000 }).items) out(JSON.stringify(c));
  db.close();
  return 0;
}

function main(argv: string[]): number {
  const args = parseArgs(argv);
  switch (args.command) {
    case 'replay':
      return replay(args);
    case 'records':
      return records(args);
    case 'changes':
      return changes(args);
    case 'corrections':
      return corrections(args);
    default:
      out(USAGE);
      return args.command === '' || args.command === 'help' || args.command === '--help' ? 0 : 1;
  }
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  if (error instanceof FactsError) {
    process.stderr.write(`memex-facts: ${error.message}\n`);
    process.exitCode = 1;
  } else {
    throw error;
  }
}
