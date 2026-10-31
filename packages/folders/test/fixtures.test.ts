import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  JOURNAL_FORMAT,
  fixtureBackend,
  isSettling,
  listFolder,
  plan,
  scanFolder,
  type FixtureTree,
  type JournalEntry,
  type JournalFile,
  type ListedFile,
  type ScanDecision,
} from "../src/index.js";

const fixtures = new URL("../../../contracts/fixtures/folder-scan/", import.meta.url);
function load<T>(name: string): T {
  return JSON.parse(readFileSync(fileURLToPath(new URL(name, fixtures)), "utf8")) as T;
}

const ROOT = "/fixture";
const NOW = 1_800_000_000_000;

function journalOf(root: string, entries: Array<Partial<JournalEntry> & { id: string; path: string }>): JournalFile {
  return {
    format: JOURNAL_FORMAT,
    root,
    scannedMs: null,
    entries: entries.map((e) => ({
      size: 0,
      modifiedMs: 0,
      fileId: null,
      volumeId: null,
      availability: "local",
      state: "present",
      contentHash: null,
      firstSeenMs: 0,
      changedMs: 0,
      seenMs: 0,
      stateChangedMs: 0,
      ...e,
    })),
  };
}

function counter(): () => string {
  let n = 0;
  return () => `new-${++n}`;
}

function shown(d: ScanDecision): Record<string, unknown> {
  const { file: _file, ...rest } = d;
  return rest;
}

interface ListingCase {
  name: string;
  options?: { includeHidden?: boolean };
  tree: FixtureTree;
  expected: {
    files: Array<[string, boolean, boolean]>;
    listedFolders: string[];
    unlistedFolders?: Array<[string, boolean]>;
    skippedFolders: string[];
    skippedFiles: string[];
    links: string[];
    warnings: Array<[string, string]>;
    complete: boolean;
  };
}

describe("listing fixtures", () => {
  const { cases } = load<{ cases: ListingCase[] }>("listing.json");
  it("has cases", () => expect(cases.length).toBeGreaterThan(8));
  for (const c of cases) {
    it(c.name, async () => {
      const root = c.tree.platform === "win32" ? "C:\\fixture" : ROOT;
      const listing = await listFolder(root, { backend: fixtureBackend(c.tree, root), includeHidden: c.options?.includeHidden ?? false });
      expect(listing.files.map((f) => [f.path, f.onlineOnly, f.sizeKnown])).toEqual(c.expected.files);
      expect(listing.listedFolders).toEqual(c.expected.listedFolders);
      expect(listing.unlistedFolders.map((u) => [u.path, u.gone])).toEqual(c.expected.unlistedFolders ?? []);
      expect(listing.skippedFolders).toEqual(c.expected.skippedFolders);
      expect(listing.skippedFiles).toEqual(c.expected.skippedFiles);
      expect(listing.links).toEqual(c.expected.links);
      expect(listing.warnings.map((w) => [w.code, w.path])).toEqual(c.expected.warnings);
      expect(listing.complete).toBe(c.expected.complete);
    });
  }
});

interface ScanCase {
  name: string;
  nowMs?: number;
  tree: FixtureTree;
  journal: Array<Partial<JournalEntry> & { id: string; path: string }>;
  hashes?: Record<string, string>;
  expected: {
    decisions: Array<Record<string, unknown>>;
    counts?: Record<string, number>;
    renameCandidates?: Array<{ newEntryId: string; missingEntryId: string }>;
    complete?: boolean;
    journal?: Array<[string, string, string]>;
  };
}

describe("scan fixtures", () => {
  const { cases } = load<{ cases: ScanCase[] }>("scan.json");
  it("has cases", () => expect(cases.length).toBeGreaterThan(15));
  for (const c of cases) {
    it(c.name, async () => {
      const listing = await listFolder(ROOT, { backend: fixtureBackend(c.tree, ROOT) });
      const hashes = c.hashes;
      const hash =
        hashes === undefined
          ? undefined
          : async (f: ListedFile): Promise<string | null> => {
              if (f.onlineOnly) throw new Error(`hashed an online-only file: ${f.path}`);
              return hashes[f.path] ?? null;
            };
      const result = await scanFolder(listing, journalOf(ROOT, c.journal), { nowMs: c.nowMs ?? NOW, newId: counter(), ...(hash ? { hash } : {}) });
      const decisions = result.decisions.filter((d) => !(d.outcome === "unchanged" && d.updated !== true)).map(shown);
      expect(decisions).toEqual(c.expected.decisions);
      if (c.expected.counts) expect(result.counts).toMatchObject(c.expected.counts);
      expect(result.renameCandidates).toEqual(c.expected.renameCandidates ?? result.renameCandidates);
      expect(result.complete).toBe(c.expected.complete ?? true);
      if (c.expected.journal) {
        const byId = (a: [string, string, string], b: [string, string, string]): number => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
        expect(result.journal.entries.map((e) => [e.id, e.path, e.state] as [string, string, string]).sort(byId)).toEqual([...c.expected.journal].sort(byId));
      }
    });
  }
});

interface PlanCase {
  name: string;
  root: string;
  location: { platform: string; env: Record<string, string>; home: string };
  tree: FixtureTree;
  journal: Array<Partial<JournalEntry> & { id: string; path: string }>;
  expected: {
    read: { files: number; bytes: number };
    local: { files: number; bytes: number };
    onlineOnly: { files: number; bytes: number; unknownSizeFiles: number };
    settling?: { files: number; bytes: number };
    providers: Array<[string | null, string, number, number]>;
    needsConfirmation: boolean;
    text: string | null;
  };
}

describe("plan fixtures", () => {
  const { cases } = load<{ cases: PlanCase[] }>("plan.json");
  for (const c of cases) {
    it(c.name, async () => {
      const tree: FixtureTree = {
        ...c.tree,
        folders: Object.fromEntries(
          Object.entries(c.tree.folders).map(([k, v]) => [k, Array.isArray(v) ? v.map((e) => ({ modifiedMs: 1_700_000_000_000, ...e })) : v]),
        ),
      };
      const listing = await listFolder(c.root, { backend: fixtureBackend(tree, c.root) });
      const scan = await scanFolder(listing, journalOf(listing.root, c.journal), { nowMs: NOW, newId: counter() });
      const result = plan(scan, { location: c.location });
      expect(result.read).toEqual(c.expected.read);
      expect(result.local).toEqual(c.expected.local);
      expect({ files: result.onlineOnly.files, bytes: result.onlineOnly.bytes, unknownSizeFiles: result.onlineOnly.unknownSizeFiles }).toEqual(c.expected.onlineOnly);
      expect(result.settling).toEqual(c.expected.settling ?? { files: 0, bytes: 0 });
      expect(result.onlineOnly.providers.map((p) => [p.provider, p.root, p.files, p.bytes])).toEqual(c.expected.providers);
      expect(result.needsConfirmation).toBe(c.expected.needsConfirmation);
      expect(result.text).toBe(c.expected.text);
    });
  }
});

describe("stable fixtures", () => {
  const { cases } = load<{
    cases: Array<{ name: string; file: { modifiedMs: number; createdMs: number | null }; nowMs: number; quietMs: number; settling: boolean }>;
  }>("stable.json");
  for (const c of cases) {
    it(c.name, () => expect(isSettling(c.file, c.nowMs, c.quietMs)).toBe(c.settling));
  }
});
