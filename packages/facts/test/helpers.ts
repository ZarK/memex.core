// Test helpers: a fresh hub database, the contract fixtures, and the JSON Schema checker
// of packages/schema, so that every output of the engine is checked against the contracts.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '@tjalve/memex-sqlite';
import { nodeSqlite } from '@tjalve/memex-sqlite/node-sqlite';
import { parse as parseYaml } from 'yaml';
import { makeChecker } from '../../schema/test/json-schema.js';
import { openFacts, type FactsEngine, type HubDefinition } from '../src/index.js';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const text = (path: string) => readFileSync(join(ROOT, path), 'utf-8').replace(/\r\n/g, '\n');

const files: Record<string, unknown> = { 'schemas/surfaces/error.json': JSON.parse(text('schemas/surfaces/error.json')) };
for (const dir of ['schemas/user', 'schemas/contacts', 'schemas/facts']) {
  for (const name of readdirSync(join(ROOT, dir))) files[`${dir}/${name}`] = JSON.parse(text(`${dir}/${name}`));
}
for (const path of ['openapi/user.v1.yaml', 'openapi/contacts.v1.yaml']) files[path] = parseYaml(text(path));

/** Errors of a value against a schema, for example 'schemas/user/record.json'. Empty when it matches. */
export const check: (schema: string, value: unknown) => string[] = makeChecker(files);

/** A contract fixture, parsed. */
export function fixture<T = Record<string, unknown>>(hub: 'user' | 'contacts', name: string): T {
  return JSON.parse(text(`contracts/fixtures/${hub}/${name}`)) as T;
}

export function fixtureNames(hub: 'user' | 'contacts'): string[] {
  return Object.keys((JSON.parse(text(`contracts/fixtures/${hub}/index.json`)) as { fixtures: Record<string, string> }).fixtures);
}

/** A clock that moves one second per call, so that every run of a test gives the same times. */
export function clock(start = '2026-11-16T10:00:00Z'): () => string {
  let t = Date.parse(start);
  return () => {
    const s = new Date(t).toISOString().replace('.000Z', 'Z');
    t += 1000;
    return s;
  };
}

export function counter(): () => string {
  let n = 0;
  return () => {
    n += 1;
    return n.toString(16).padStart(32, '0');
  };
}

export function newHub(hub: HubDefinition, path = ':memory:'): FactsEngine {
  const db = openDatabase(path, { driver: nodeSqlite, idleCheckpointMs: 0 });
  return openFacts(db, { hub, now: clock(), randomHex: counter() });
}

/** Replaces ids everywhere in a JSON value: fixture ids to engine ids, or back. */
export function mapIds<T>(value: T, map: Map<string, string>): T {
  let s = JSON.stringify(value);
  for (const [from, to] of map) s = s.split(from).join(to);
  return JSON.parse(s) as T;
}
