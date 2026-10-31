import { JOURNAL_FORMAT, newEntryId, type JournalEntry, type JournalFile } from "./journal.js";
import { pathKey, splitPath, timesEqual } from "./keys.js";
import { isSettling, DEFAULT_QUIET_MS } from "./stable.js";
import type { FolderListing, ListedFile } from "./types.js";

/**
 * What the scan decided about one file (contracts/folder-scan.md, Matching rules):
 * - "unchanged": rule 1, the journal entry at the path has the observed size and time.
 * - "found-again": rule 1 on a missing entry.
 * - "changed": rule 5, the entry at the path has other facts.
 * - "moved": rules 2, 4, and 6, an entry that left its path is here, with the same content.
 * - "moved-changed": rule 3, as rule 2 with other facts, proven by a strong file id.
 * - "new": rule 7.
 * - "missing": the file is gone from a folder that was listed completely.
 */
export type ScanOutcome = "new" | "unchanged" | "found-again" | "changed" | "moved" | "moved-changed" | "missing";

export interface ScanDecision {
  outcome: ScanOutcome;
  /** The observed path; for "missing", the entry's last path. */
  path: string;
  /** The journal entry the decision is about (a new id for "new"). */
  entryId: string;
  /** The entry's previous path, for "moved" and "moved-changed". */
  from?: string;
  /** The entry that held the observed path and leaves it (it becomes missing unless found elsewhere). */
  displaced?: string;
  /** "changed", "moved", or "moved-changed" of an entry that was missing. */
  foundAgain?: boolean;
  /** "unchanged" with facts that the journal records anew: a file id, a case-only rename, or the availability. */
  updated?: boolean;
  /** A new or changed file that is still being written (see Stable files); the journal does not take it yet. */
  settling?: boolean;
  /** The observed file; absent for "missing". */
  file?: ListedFile;
}

export interface ScanCounts {
  listed: number;
  onlineOnly: number;
  unchanged: number;
  new: number;
  changed: number;
  moved: number;
  missing: number;
  foundAgain: number;
  /** Files that went away between the listing and their content hash. */
  vanished: number;
  settling: number;
}

export interface ScanResult {
  root: string;
  nowMs: number;
  /** Every decision, "unchanged" included, in the order the rules made them. */
  decisions: ScanDecision[];
  counts: ScanCounts;
  /** Rule 6b: a new entry with the name of an entry that went missing in the same scan. */
  renameCandidates: Array<{ newEntryId: string; missingEntryId: string }>;
  /** False when a folder could not be listed: its entries were not checked. */
  complete: boolean;
  /** The journal after this scan. Settling files keep their earlier entry (or none). */
  journal: JournalFile;
}

export interface ScanOptions {
  /** The scan's clock, UTC milliseconds. Default Date.now(). */
  nowMs?: number;
  /** A file changed less than this long ago is settling. Default 10 seconds. */
  quietMs?: number;
  /**
   * The content hash (lowercase hex) of a local file, or null when it is gone. Without it, rules 4 and 6 do not run
   * and rule 2 needs a strong file id. It is never called for an online-only file.
   */
  hash?: (file: ListedFile) => Promise<string | null>;
  /** New entry ids. Default "f_" and a random UUID. */
  newId?: () => string;
}

interface Tracked {
  e: JournalEntry;
  original: JournalEntry | null;
  settled: boolean;
  displaced: boolean;
  folderKey: string;
  nameKey: string;
}

interface Deferred {
  file: ListedFile;
  x: Tracked | null;
  candidates: Tracked[];
}

const byPath = <T>(get: (t: T) => string) => (a: T, b: T): number => {
  const x = get(a);
  const y = get(b);
  return x < y ? -1 : x > y ? 1 : 0;
};

/**
 * Compares a listing with the journal of the same root and decides, for every file, whether it is unchanged, new,
 * changed, moved, or missing. It reads no file, except through `hash` for rules 2 (weak ids), 4, and 6.
 */
export async function scanFolder(listing: FolderListing, journal: JournalFile, options: ScanOptions = {}): Promise<ScanResult> {
  const now = options.nowMs ?? Date.now();
  const quietMs = options.quietMs ?? DEFAULT_QUIET_MS;
  const newId = options.newId ?? newEntryId;
  const ic = listing.ignoresCase;
  const fs = listing.fileSystem;
  const strong = listing.idReliability === "strong";

  const tracked = new Map<string, Tracked>();
  const folders = new Map<string, Map<string, Tracked[]>>();
  const byFileId = new Map<string, Tracked[]>();
  const bySize = new Map<number, Tracked[]>();
  const decisions: ScanDecision[] = [];
  const counts: ScanCounts = { listed: listing.files.length, onlineOnly: 0, unchanged: 0, new: 0, changed: 0, moved: 0, missing: 0, foundAgain: 0, vanished: 0, settling: 0 };
  const notObserved: Tracked[] = [];
  const deferred: Deferred[] = [];
  const newEntries: Tracked[] = [];
  const becameMissing: Tracked[] = [];
  const settlingIds = new Set<string>();

  const keysOf = (p: string): { folderKey: string; nameKey: string } => {
    const { folder, name } = splitPath(p);
    return { folderKey: pathKey(folder, ic), nameKey: pathKey(name, ic) };
  };
  const folderMap = (folderKey: string): Map<string, Tracked[]> => {
    let m = folders.get(folderKey);
    if (m === undefined) folders.set(folderKey, (m = new Map()));
    return m;
  };
  const track = (t: Tracked): void => {
    tracked.set(t.e.id, t);
    const m = folderMap(t.folderKey);
    const list = m.get(t.nameKey);
    if (list === undefined) m.set(t.nameKey, [t]);
    else if (!list.includes(t)) list.push(t);
  };
  const untrack = (t: Tracked): void => {
    const list = folders.get(t.folderKey)?.get(t.nameKey);
    const i = list?.indexOf(t) ?? -1;
    if (i >= 0) list!.splice(i, 1);
  };
  const indexFileId = (t: Tracked): void => {
    if (t.e.fileId === null || t.e.volumeId === null) return;
    const key = `${t.e.volumeId}\n${t.e.fileId}`;
    const list = byFileId.get(key);
    if (list === undefined) byFileId.set(key, [t]);
    else if (!list.includes(t)) list.push(t);
  };

  for (const entry of journal.entries) {
    const t: Tracked = { e: { ...entry }, original: entry, settled: false, displaced: false, ...keysOf(entry.path) };
    track(t);
    indexFileId(t);
    const list = bySize.get(entry.size);
    if (list === undefined) bySize.set(entry.size, [t]);
    else list.push(t);
  }

  // What the listing saw, for the checks that the Photos scanner makes on the disk.
  const observed = new Map<string, ListedFile>();
  for (const f of listing.files) observed.set(pathKey(f.path, ic), f);
  const listedKeys = new Set(listing.listedFolders.map((f) => pathKey(f, ic)));
  const notCheckedKeys = new Set([...listing.unlistedFolders.map((f) => pathKey(f.path, ic)), ...listing.skippedFolders.map((f) => pathKey(f, ic))]);
  const skippedFileKeys = new Set(listing.skippedFiles.map((f) => pathKey(f, ic)));

  /** "listed", "gone" (not there, below a listed folder), or "unknown" (not listed, or left out). */
  const folderState = (folderKey: string): "listed" | "gone" | "unknown" => {
    if (listedKeys.has(folderKey)) return "listed";
    let current = folderKey;
    while (current !== "") {
      if (notCheckedKeys.has(current)) return "unknown";
      const parent = splitPath(current).folder;
      if (listedKeys.has(parent)) return "gone";
      current = parent;
    }
    return "unknown";
  };

  const availabilityOf = (f: ListedFile): JournalEntry["availability"] => (f.onlineOnly ? "online-only" : "local");
  const emit = (d: ScanDecision): void => {
    decisions.push(d);
    switch (d.outcome) {
      case "new":
        counts.new++;
        break;
      case "unchanged":
        counts.unchanged++;
        break;
      case "found-again":
        counts.foundAgain++;
        break;
      case "changed":
        counts.changed++;
        if (d.foundAgain === true) counts.foundAgain++;
        break;
      case "moved":
      case "moved-changed":
        counts.moved++;
        break;
      case "missing":
        counts.missing++;
        break;
    }
    if (d.settling === true) {
      counts.settling++;
      settlingIds.add(d.entryId);
    }
  };
  const settlingOf = (f: ListedFile): boolean => !f.onlineOnly && isSettling(f, now, quietMs);

  const apply = (t: Tracked, f: ListedFile, contentHash: string | null | undefined): void => {
    const e = t.e;
    if (e.size !== f.size || e.modifiedMs !== f.modifiedMs) e.changedMs = now;
    if (e.state !== "present") e.stateChangedMs = now;
    e.state = "present";
    e.path = f.path;
    e.size = f.size;
    e.modifiedMs = f.modifiedMs;
    e.fileId = f.fileId ?? e.fileId;
    e.volumeId = f.volumeId ?? e.volumeId;
    e.availability = availabilityOf(f);
    e.seenMs = now;
    if (contentHash !== undefined) e.contentHash = contentHash;
    indexFileId(t);
  };
  const factsChanged = (t: Tracked, f: ListedFile): boolean =>
    (f.fileId !== null && t.e.fileId !== f.fileId) ||
    (f.volumeId !== null && t.e.volumeId !== f.volumeId) ||
    t.e.path !== f.path ||
    t.e.availability !== availabilityOf(f);

  const findX = (folderKey: string, nameKey: string): Tracked | null => {
    const list = folders.get(folderKey)?.get(nameKey);
    if (list === undefined) return null;
    return (
      list.find((t) => t.e.state === "present" && !t.settled) ??
      list.filter((t) => t.e.state === "missing" && !t.settled && !t.displaced).sort((a, b) => b.e.stateChangedMs - a.e.stateChangedMs)[0] ??
      null
    );
  };
  const findByFileId = (f: ListedFile, exclude: Tracked | null): Tracked | null => {
    const list = byFileId.get(`${f.volumeId}\n${f.fileId}`) ?? [];
    return list.find((t) => t !== exclude && t.e.fileId === f.fileId && t.e.volumeId === f.volumeId && !(t.settled && t.e.state === "present")) ?? null;
  };
  const pathHoldsFileId = (t: Tracked, f: ListedFile): boolean => {
    const state = folderState(t.folderKey);
    if (state === "gone") return false;
    if (state === "unknown") return true;
    const there = observed.get(pathKey(t.e.path, ic));
    return there !== undefined && there.fileId === f.fileId && there.volumeId === f.volumeId;
  };
  const pathHoldsFacts = (t: Tracked): boolean => {
    const state = folderState(t.folderKey);
    if (state === "gone") return false;
    if (state === "unknown") return true;
    const there = observed.get(pathKey(t.e.path, ic));
    return there !== undefined && there.size === t.e.size && timesEqual(there.modifiedMs, t.e.modifiedMs, fs);
  };
  const hashCache = new Map<string, string | null>();
  const hashOf = async (f: ListedFile): Promise<string | null> => {
    if (options.hash === undefined || f.onlineOnly) return null;
    if (!hashCache.has(f.path)) hashCache.set(f.path, await options.hash(f));
    return hashCache.get(f.path) ?? null;
  };
  const hashEquals = async (f: ListedFile, t: Tracked): Promise<boolean> => {
    if (t.e.contentHash === null || options.hash === undefined || f.onlineOnly) return false;
    return (await hashOf(f)) === t.e.contentHash;
  };

  const emitNew = (f: ListedFile, contentHash: string | null): void => {
    const id = newId();
    const e: JournalEntry = {
      id,
      path: f.path,
      size: f.size,
      modifiedMs: f.modifiedMs,
      fileId: f.fileId,
      volumeId: f.volumeId,
      availability: availabilityOf(f),
      state: "present",
      contentHash,
      firstSeenMs: now,
      changedMs: now,
      seenMs: now,
      stateChangedMs: now,
    };
    const t: Tracked = { e, original: null, settled: true, displaced: false, ...keysOf(f.path) };
    track(t);
    indexFileId(t);
    newEntries.push(t);
    emit({ outcome: "new", path: f.path, entryId: id, file: f, ...(settlingOf(f) ? { settling: true } : {}) });
  };
  const emitChanged = (f: ListedFile, x: Tracked, contentHash: string | null): void => {
    const foundAgain = x.e.state !== "present";
    emit({ outcome: "changed", path: f.path, entryId: x.e.id, file: f, ...(foundAgain ? { foundAgain } : {}), ...(settlingOf(f) ? { settling: true } : {}) });
    x.settled = true;
    apply(x, f, contentHash);
  };
  const emitMove = (outcome: "moved" | "moved-changed", f: ListedFile, y: Tracked, x: Tracked | null): void => {
    let displaced: string | undefined;
    if (x !== null && x.e.state === "present" && x !== y) {
      x.displaced = true;
      x.e.state = "missing";
      x.e.stateChangedMs = now;
      displaced = x.e.id;
    }
    const foundAgain = y.e.state !== "present";
    emit({
      outcome,
      path: f.path,
      entryId: y.e.id,
      from: y.e.path,
      file: f,
      ...(displaced !== undefined ? { displaced } : {}),
      ...(foundAgain ? { foundAgain } : {}),
      ...(outcome === "moved-changed" && settlingOf(f) ? { settling: true } : {}),
    });
    untrack(y);
    Object.assign(y, keysOf(f.path));
    y.displaced = false;
    y.settled = true;
    apply(y, f, outcome === "moved-changed" ? null : undefined);
    track(y);
  };
  const markMissing = (t: Tracked): void => {
    if (t.settled && t.e.state === "present") return;
    if (t.e.state !== "missing") t.e.stateChangedMs = now;
    t.e.state = "missing";
    t.settled = true;
    becameMissing.push(t);
    emit({ outcome: "missing", path: t.e.path, entryId: t.e.id });
  };

  const match = async (f: ListedFile, folderKey: string, nameKey: string): Promise<void> => {
    const x = findX(folderKey, nameKey);
    const idsUsable = listing.idReliability !== "unusable" && f.fileId !== null && f.volumeId !== null;

    // Rule 1: unchanged.
    if (x !== null && x.e.size === f.size && timesEqual(x.e.modifiedMs, f.modifiedMs, fs)) {
      const sameId = x.e.fileId !== null && x.e.fileId === f.fileId && x.e.volumeId === f.volumeId;
      if (sameId || !idsUsable || findByFileId(f, x) === null) {
        if (x.e.state !== "present") {
          emit({ outcome: "found-again", path: f.path, entryId: x.e.id, file: f });
        } else {
          const updated = factsChanged(x, f);
          emit({ outcome: "unchanged", path: f.path, entryId: x.e.id, file: f, ...(updated ? { updated } : {}) });
        }
        x.settled = true;
        apply(x, f, undefined);
        return;
      }
    }

    // Rules 2 and 3: another entry has the observed file id, and its own path no longer holds it.
    if (idsUsable) {
      const y = findByFileId(f, x);
      if (y !== null && !pathHoldsFileId(y, f)) {
        const sameFacts = y.e.size === f.size && timesEqual(y.e.modifiedMs, f.modifiedMs, fs);
        if (sameFacts && (strong || (await hashEquals(f, y)))) {
          emitMove("moved", f, y, x);
          return;
        }
        if (!sameFacts && strong) {
          emitMove("moved-changed", f, y, x);
          return;
        }
      }
    }

    // Rules 4 and 6: an entry that left its path has the same size (and, with an entry at the path, the same time).
    if (options.hash !== undefined && !f.onlineOnly) {
      const candidates: Tracked[] = [];
      for (const c of bySize.get(f.size) ?? []) {
        if (c === x || (c.settled && c.e.state === "present") || c.e.size !== f.size) continue;
        if (x !== null && !timesEqual(c.e.modifiedMs, f.modifiedMs, fs)) continue;
        if (c.e.state === "missing" || c.displaced || !pathHoldsFacts(c)) candidates.push(c);
      }
      if (candidates.length > 0) {
        if (x !== null) x.settled = true;
        deferred.push({ file: f, x, candidates });
        return;
      }
    }

    // Rule 5: changed in place.
    if (x !== null) {
      emitChanged(f, x, null);
      return;
    }

    // Rule 7: new.
    emitNew(f, null);
  };

  // The walk: each listed folder's files in name order, then the folder's entries that no file took.
  const filesByFolder = new Map<string, ListedFile[]>();
  for (const f of listing.files) {
    const k = pathKey(splitPath(f.path).folder, ic);
    const list = filesByFolder.get(k);
    if (list === undefined) filesByFolder.set(k, [f]);
    else list.push(f);
    if (f.onlineOnly) counts.onlineOnly++;
  }
  const skippedByFolder = new Map<string, Set<string>>();
  for (const k of skippedFileKeys) {
    const { folder, name } = splitPath(k);
    let s = skippedByFolder.get(folder);
    if (s === undefined) skippedByFolder.set(folder, (s = new Set()));
    s.add(name);
  }
  const walked = new Set<string>();
  for (const folder of listing.listedFolders) {
    const folderKey = pathKey(folder, ic);
    if (walked.has(folderKey)) continue;
    walked.add(folderKey);
    const seen = new Set<string>(skippedByFolder.get(folderKey) ?? []);
    for (const f of filesByFolder.get(folderKey) ?? []) {
      const nameKey = pathKey(splitPath(f.path).name, ic);
      seen.add(nameKey);
      await match(f, folderKey, nameKey);
    }
    for (const list of folders.get(folderKey)?.values() ?? []) {
      for (const t of list) {
        if (t.e.state !== "present" || t.settled) continue;
        if (!t.displaced && !seen.has(t.nameKey)) notObserved.push(t);
        else if (seen.has(t.nameKey)) t.settled = true; // A name the listing left out (hidden, ignored): not checked.
      }
    }
  }

  // Settle: pair the observations that wait for their content hash.
  if (deferred.length > 0) {
    const hashed: Array<{ d: Deferred; hash: string }> = [];
    for (const d of deferred) {
      const hash = await hashOf(d.file);
      if (hash === null) {
        counts.vanished++;
        if (d.x !== null) d.x.settled = false;
        continue;
      }
      hashed.push({ d, hash });
    }
    const paired = new Set<Deferred>();
    const used = new Set<string>();
    const groups = new Map<string, Deferred[]>();
    for (const { d, hash } of hashed) {
      const g = groups.get(hash);
      if (g === undefined) groups.set(hash, [d]);
      else g.push(d);
    }
    for (const [hash, observations] of groups) {
      const seenIds = new Set<string>();
      const candidates: Tracked[] = [];
      for (const d of observations) {
        for (const c of d.candidates) {
          if (seenIds.has(c.e.id)) continue;
          seenIds.add(c.e.id);
          if (!(c.settled && c.e.state === "present") && c.e.contentHash === hash) candidates.push(c);
        }
      }
      const pairs: Array<{ d: Deferred; c: Tracked }> = [];
      const sortedObservations = [...observations].sort(byPath((d) => d.file.path));
      for (const d of sortedObservations) {
        const nameKey = keysOf(d.file.path).nameKey;
        const same = candidates.filter((c) => !used.has(c.e.id) && c.nameKey === nameKey).sort(byPath((c) => c.e.path))[0];
        if (same !== undefined) {
          used.add(same.e.id);
          paired.add(d);
          pairs.push({ d, c: same });
        }
      }
      const restCandidates = candidates.filter((c) => !used.has(c.e.id)).sort(byPath((c) => c.e.path));
      const restObservations = sortedObservations.filter((d) => !paired.has(d));
      for (let i = 0; i < Math.min(restCandidates.length, restObservations.length); i++) {
        used.add(restCandidates[i]!.e.id);
        paired.add(restObservations[i]!);
        pairs.push({ d: restObservations[i]!, c: restCandidates[i]! });
      }
      for (const { d, c } of pairs.sort(byPath((p) => p.d.file.path))) emitMove("moved", d.file, c, d.x);
    }
    for (const { d, hash } of hashed) {
      if (paired.has(d)) continue;
      if (d.x !== null && !d.x.displaced) emitChanged(d.file, d.x, hash);
      else emitNew(d.file, hash);
    }
  }

  // Settle: entries that are gone from completely listed folders become missing.
  for (const t of notObserved) if (!t.settled && t.e.state === "present") markMissing(t);
  for (const t of [...tracked.values()]) if (t.displaced && !t.settled) markMissing(t);
  for (const t of [...tracked.values()]) {
    if (t.settled || t.displaced || t.e.state !== "present" || listedKeys.has(t.folderKey)) continue;
    if (folderState(t.folderKey) === "gone") markMissing(t);
  }

  // Rule 6b: each entry that went missing is the rename candidate of at most one new entry with its name.
  const renameCandidates: ScanResult["renameCandidates"] = [];
  const taken = new Set<string>();
  for (const created of [...newEntries].sort(byPath((t) => t.e.path))) {
    const missing = becameMissing.filter((t) => !taken.has(t.e.id) && t.nameKey === created.nameKey).sort(byPath((t) => t.e.path))[0];
    if (missing !== undefined) {
      taken.add(missing.e.id);
      renameCandidates.push({ newEntryId: created.e.id, missingEntryId: missing.e.id });
    }
  }

  const entries: JournalEntry[] = [];
  for (const t of tracked.values()) {
    if (settlingIds.has(t.e.id)) {
      if (t.original !== null) entries.push(t.original);
    } else {
      entries.push(t.e);
    }
  }
  entries.sort(byPath((e) => e.path));
  return {
    root: listing.root,
    nowMs: now,
    decisions,
    counts,
    renameCandidates,
    complete: listing.complete,
    journal: { format: JOURNAL_FORMAT, root: listing.root, scannedMs: now, entries },
  };
}
