// The memex-facts CLI, run as a program (the test script builds dist/ first): claims from
// three producers replayed twice into a database file. The second run changes nothing, the
// correction survives, and the records say which producer gave each field.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { factId } from '@tjalve/memex-schema';
import type { FactsRecordOut } from '../src/index.js';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli.js');
const dir = mkdtempSync(join(tmpdir(), 'memex-facts-cli-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const run = (...args: string[]) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf-8' });

const tripId = factId('trip', 'photos.trips', 'trip-a');
const lines = [
  {
    scope: 'photos.trips',
    claims: [
      {
        key: 'trip-a',
        kind: 'trip',
        confidence: 0.9,
        method: 'rule:trip-nearness/2',
        generation: 2,
        fields: { title: 'Lisbon', firstDay: '2025-05-02', lastDay: '2025-05-08', countries: ['PT'] },
        sources: [{ app: 'photos', kind: 'trip', id: 'trip-a' }],
      },
    ],
  },
  {
    scope: 'finance.trips',
    claims: [
      {
        key: 'pt-2025-05',
        kind: 'trip',
        confidence: 0.7,
        method: 'rule:trip-from-payments/1',
        generation: 5,
        fields: { title: 'Card payments in Portugal', firstDay: '2025-05-01', lastDay: '2025-05-07', countries: ['PT'] },
        sources: [{ app: 'finance', kind: 'trip-evidence', id: 'pt-2025-05' }],
      },
    ],
  },
  {
    scope: 'health.trips',
    claims: [
      {
        key: 'run-2025-05-04',
        kind: 'trip',
        confidence: 0.8,
        method: 'rule:workout-away/1',
        generation: 1,
        fields: { title: 'Run', firstDay: '2025-05-04', lastDay: '2025-05-04', destinations: [{ name: 'Belém', town: 'Lisbon', country: 'PT' }] },
        sources: [{ app: 'health', kind: 'workout', id: 'wo-1' }],
      },
    ],
  },
  {
    corrections: [
      { id: 'cor_0000000000000000000000000000c0de', op: 'set', record: tripId, fields: { title: 'Lisbon with Sam' }, app: 'photos', createdAt: '2026-10-25T18:00:00Z' },
    ],
  },
];

describe('memex-facts replay', () => {
  const file = join(dir, 'claims.jsonl');
  const db = join(dir, 'user.db');
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

  it('replays three producers and a correction', () => {
    const r = run('replay', file, '--db', db, '--hub', 'user');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('replayed 3 claims and 1 corrections; 0 requests refused');
    expect(r.stdout).toContain('records: trip 1');
  });

  it('changes nothing on the second run, and the correction survives', () => {
    const r = run('replay', file, '--db', db);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('change feed: 0 new changes');
    expect(r.stdout.match(/no change/g)).toHaveLength(3);
    expect(r.stdout).toContain('(repeat)');
    const records = JSON.parse(execFileSync(process.execPath, [CLI, 'records', '--db', db, '--json'], { encoding: 'utf-8' })) as FactsRecordOut[];
    expect(records).toHaveLength(1);
    const [trip] = records;
    expect(trip!.fields).toMatchObject({ title: 'Lisbon with Sam', firstDay: '2025-05-01', lastDay: '2025-05-08' });
    expect(trip!.provenance.title).toEqual([{ correction: 'cor_0000000000000000000000000000c0de' }]);
    expect(trip!.provenance.firstDay).toEqual([{ scope: 'finance.trips', key: 'pt-2025-05' }]);
    expect(trip!.provenance.lastDay).toEqual([{ scope: 'photos.trips', key: 'trip-a' }]);
    expect(trip!.provenance.destinations).toEqual([{ scope: 'health.trips', key: 'run-2025-05-04' }]);
  });

  it('refuses a late retry with a lower generation', () => {
    const late = join(dir, 'late.jsonl');
    writeFileSync(late, JSON.stringify({ ...lines[0], claims: [{ ...lines[0]!.claims![0], generation: 1 }] }) + '\n');
    const r = run('replay', late, '--db', db);
    expect(r.status).toBe(2);
    expect(r.stdout).toContain('refused (409 stale-generation)');
  });

  it('prints the provenance of each field', () => {
    const r = run('records', '--db', db, '--kind', 'trip');
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/title\s+"Lisbon with Sam"\n\s+from correction cor_0000000000000000000000000000c0de \(photos\)/);
    expect(r.stdout).toMatch(/firstDay\s+"2025-05-01"\n\s+from finance\.trips pt-2025-05/);
  });
});
