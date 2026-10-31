import type { SqliteDatabase } from "@tjalve/memex-sqlite";
import { SurfaceError } from "@tjalve/memex-surfaces";
import type { HubClient } from "./client.js";
import type { Hub, HubCorrection, HubCorrectionResult, HubRecord } from "./corrections.js";
import { ensureHub, type EnsureHubOptions } from "./ensure.js";
import { FactsStore, installStore, type CorrectionInput, type SavedCorrection } from "./store.js";

/** The largest corrections write (facts.md, The outbox). */
export const MAX_BATCH = 500;

export interface FactsSyncOptions {
  /** The app's own database: the outbox and the local copy live in it. */
  db: SqliteDatabase;
  /** The app id that each correction carries: the app in which the person acted. */
  app: string;
  /** The app's version. A correction that a hub refused (400) is tried again when this changes. */
  appVersion: string;
  /** The hubs to keep in sync. Default ["user"]. */
  hubs?: Hub[];
  /** How the sync reaches a hub. Default: ensureHub with `launcher`, which starts the hub on demand. */
  connect?: (hub: Hub) => Promise<HubClient>;
  /** Options for ensureUser and ensureContacts (start: false never starts a hub). */
  launcher?: EnsureHubOptions;
  /** The first wait after a failure. Default 1 s; it doubles up to maxBackoffMs. */
  minBackoffMs?: number;
  /** Default 5 minutes. */
  maxBackoffMs?: number;
  /** How often the background sync reads the change feed when nothing else wakes it. Default 30 s. */
  pollMs?: number;
  /** Lines for a log. */
  log?: (line: string) => void;
  /**
   * Runs after a hub answered a corrections write and before the outbox records the answer. For tests of a lost
   * answer: a process that stops here sends the same corrections again at its next start, and the hub stores each id
   * once.
   */
  afterSend?: (hub: Hub, corrections: HubCorrection[], results: HubCorrectionResult[]) => void | Promise<void>;
}

/** What one round of the sync did for a hub. */
export interface SyncReport {
  hub: Hub;
  /** Corrections that the hub stored and that left the outbox. */
  delivered: number;
  /** Results that were repeats of corrections the hub had stored. */
  repeats: number;
  /** Corrections that the hub stored and holds, with a mark. */
  held: number;
  /** Corrections that the hub refused (400), with a mark, still in the outbox. */
  refused: number;
  /** Records read back once after a write (overridden, superseded, repeatOf, or another record). */
  readBack: number;
  /** Changes of the feed applied to the local copy. */
  applied: number;
  /** Corrections that wait in the outbox after the round. */
  waiting: number;
  /** The failure that ended the round, when it failed. */
  error?: string;
}

/** The state of a hub's sync, for a "waiting to sync" sign. */
export interface SyncStatus {
  hub: Hub;
  waiting: number;
  held: number;
  refused: number;
  failures: number;
  lastError?: string;
  retryAt?: string;
}

/**
 * The background sync for one app: it saves the person's edits with their corrections in the app's
 * database, sends the outbox of each hub in createdAt order whenever the hub can be reached (starting it on demand),
 * retries with a backoff that survives restarts because the outbox is in the app's database, and applies the change
 * feed to the local copy without overwriting edits that wait.
 */
export class FactsSync {
  readonly store: FactsStore;
  readonly hubs: Hub[];
  readonly #options: FactsSyncOptions;
  readonly #clients = new Map<Hub, HubClient>();
  readonly #state = new Map<Hub, { failures: number; retryAt: number; lastError?: string }>();
  #running = false;
  #timer: NodeJS.Timeout | undefined;
  #wake: (() => void) | undefined;
  #pending = false;
  #loop: Promise<void> | undefined;
  #busy: Promise<unknown> = Promise.resolve();

  constructor(options: FactsSyncOptions) {
    this.#options = options;
    installStore(options.db);
    this.store = new FactsStore(options.db, options.app);
    this.hubs = options.hubs ?? ["user"];
    for (const hub of this.hubs) this.#state.set(hub, { failures: 0, retryAt: 0 });
  }

  /**
   * Saves a person's edit at once: the local copy and the outbox in one transaction (the caller's, when it has one, so
   * the app's own tables change in the same transaction). Then it wakes the background sync.
   */
  save(hub: Hub, correction: CorrectionInput): SavedCorrection {
    this.#hubOf(hub);
    const saved = this.store.save(hub, correction);
    this.#wakeUp();
    return saved;
  }

  /** Sends what waits and reads the feed, for each hub. A hub that cannot be reached is reported, never thrown. */
  async syncOnce(hubs: Hub[] = this.hubs): Promise<SyncReport[]> {
    return this.#serial(async () => {
      const reports: SyncReport[] = [];
      for (const hub of hubs) {
        const report = await this.#round(hub, { send: true, pull: true });
        reports.push(report);
      }
      return reports;
    });
  }

  /** Sends what waits, without reading the feed. */
  async send(hub: Hub): Promise<SyncReport> {
    return this.#serial(() => this.#round(hub, { send: true, pull: false }));
  }

  /** Reads the feed into the local copy, without sending. */
  async pull(hub: Hub): Promise<SyncReport> {
    return this.#serial(() => this.#round(hub, { send: false, pull: true }));
  }

  status(hub: Hub): SyncStatus {
    const items = this.store.outbox(hub);
    const s = this.#state.get(hub) ?? { failures: 0, retryAt: 0 };
    return {
      hub,
      waiting: items.length,
      held: this.store.held(hub).length,
      refused: items.filter((i) => i.refused).length,
      failures: s.failures,
      ...(s.lastError ? { lastError: s.lastError } : {}),
      ...(s.retryAt > Date.now() ? { retryAt: new Date(s.retryAt).toISOString() } : {}),
    };
  }

  /** Starts the background sync. It runs until stop(). */
  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#loop = this.#background();
  }

  /** Stops the background sync after its current round. */
  async stop(): Promise<void> {
    this.#running = false;
    this.#wakeUp();
    await this.#loop;
  }

  async #background(): Promise<void> {
    const poll = this.#options.pollMs ?? 30_000;
    while (this.#running) {
      // A save during the round wakes the next wait at once.
      this.#pending = false;
      const now = Date.now();
      for (const hub of this.hubs) {
        const s = this.#state.get(hub)!;
        if (s.retryAt > now) continue;
        await this.#serial(() => this.#round(hub, { send: true, pull: true }));
      }
      if (!this.#running) break;
      if (this.#pending) continue;
      const next = Math.min(poll, ...this.hubs.map((h) => Math.max(0, this.#state.get(h)!.retryAt - Date.now())).filter((ms) => ms > 0));
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
        this.#timer = setTimeout(resolve, next);
        this.#timer.unref?.();
      });
      this.#wake = undefined;
    }
  }

  #wakeUp(): void {
    this.#pending = true;
    clearTimeout(this.#timer);
    this.#wake?.();
  }

  /** One round at a time: the background loop and the calls of the app never send the same items twice at once. */
  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#busy.then(fn, fn);
    this.#busy = next.catch(() => undefined);
    return next;
  }

  #hubOf(hub: Hub): void {
    if (!this.hubs.includes(hub)) throw new TypeError(`This sync is for ${this.hubs.join(" and ")}, not ${hub}.`);
  }

  async #client(hub: Hub): Promise<HubClient> {
    let client = this.#clients.get(hub);
    if (!client) {
      client = await (this.#options.connect ?? ((h: Hub) => ensureHub(h, this.#options.launcher)))(hub);
      this.#clients.set(hub, client);
    }
    return client;
  }

  async #round(hub: Hub, what: { send: boolean; pull: boolean }): Promise<SyncReport> {
    this.#hubOf(hub);
    const report: SyncReport = { hub, delivered: 0, repeats: 0, held: 0, refused: 0, readBack: 0, applied: 0, waiting: 0 };
    const s = this.#state.get(hub)!;
    try {
      // A read back that an earlier round could not finish (the hub stopped, the app quit) is done first.
      if (this.store.readBacks(hub).length) await this.#readBack(hub, await this.#client(hub), report);
      if (what.send && this.store.nextBatch(hub, this.#options.appVersion, 1).length) await this.#sendAll(hub, report);
      if (what.pull) await this.#pullAll(hub, report);
      s.failures = 0;
      s.retryAt = 0;
      delete s.lastError;
    } catch (error) {
      // A hub that is stopped, starting, or failing: the edits wait, and the sync tries again later.
      this.#clients.delete(hub);
      s.failures++;
      const min = this.#options.minBackoffMs ?? 1000;
      const max = this.#options.maxBackoffMs ?? 300_000;
      const wait = Math.min(max, min * 2 ** Math.min(20, s.failures - 1));
      s.retryAt = Date.now() + wait;
      s.lastError = (error as Error).message;
      report.error = s.lastError;
      this.#options.log?.(`Memex ${hub} cannot be reached (${s.lastError}). The edits wait; the next try is in ${Math.round(wait / 1000)} s.`);
    }
    report.waiting = this.store.outbox(hub).length;
    return report;
  }

  async #sendAll(hub: Hub, report: SyncReport): Promise<void> {
    const version = this.#options.appVersion;
    for (;;) {
      const batch = this.store.nextBatch(hub, version, MAX_BATCH);
      if (!batch.length) return;
      const client = await this.#client(hub);
      this.store.countAttempt(batch.map((b) => b.seq));
      let progressed: boolean;
      try {
        progressed = await this.#write(hub, client, batch, report);
      } catch (error) {
        if (!(error instanceof SurfaceError) || error.status !== 400) throw error;
        // The hub refused the whole call: one at a time, so one bad correction never stops the others.
        progressed = false;
        for (const item of batch) {
          try {
            if (await this.#write(hub, client, [item], report)) progressed = true;
          } catch (single) {
            if (!(single instanceof SurfaceError) || single.status !== 400) throw single;
            this.store.markRefused(item.seq, { code: single.code, message: single.message, ...(single.field ? { field: single.field } : {}) }, version);
            report.refused++;
            progressed = true;
          }
        }
      }
      if (!progressed) return;
    }
  }

  async #write(hub: Hub, client: HubClient, batch: ReturnType<FactsStore["nextBatch"]>, report: SyncReport): Promise<boolean> {
    const corrections = batch.map((b) => b.correction);
    const output = await (client as { correctionsWrite(body: { corrections: HubCorrection[] }): Promise<{ results: HubCorrectionResult[] }> }).correctionsWrite({ corrections });
    await this.#options.afterSend?.(hub, corrections, output.results);
    this.store.stored(hub, batch, output.results);
    for (const r of output.results) {
      if (r.repeat) report.repeats++;
      if (r.status === "held") report.held++;
    }
    const matched = output.results.filter((r, i) => batch[i]?.correction.id === r.id).length;
    report.delivered += matched;
    await this.#readBack(hub, client, report);
    return matched > 0;
  }

  /** Reads back each record in the read-back table once; a record leaves the table only after its read is applied. */
  async #readBack(hub: Hub, client: HubClient, report: SyncReport): Promise<void> {
    for (const id of this.store.readBacks(hub)) {
      const record = await this.#get(client, id);
      if (this.store.readBackDone(hub, id, record)) report.readBack++;
    }
  }

  async #get(client: HubClient, id: string): Promise<HubRecord | undefined> {
    const kind = id.slice(0, id.indexOf("_"));
    const method = `${PLURALS[kind] ?? kind + "s"}Get`;
    const fn = (client as unknown as Record<string, (body: { id: string }) => Promise<{ record: HubRecord }>>)[method];
    if (typeof fn !== "function") return undefined;
    try {
      return (await fn.call(client, { id })).record;
    } catch (error) {
      if (error instanceof SurfaceError && error.status === 404) return undefined;
      throw error;
    }
  }

  async #pullAll(hub: Hub, report: SyncReport): Promise<void> {
    const client = await this.#client(hub);
    for (;;) {
      const since = this.store.cursor(hub);
      const page = await (client as { changesList(body: { since?: string; limit?: number }): Promise<{ items: { cursor: string; op: "upsert" | "remove"; id: string; kind: string; version: number; record?: HubRecord; mergedInto?: string }[]; next: string | null }> }).changesList({
        ...(since ? { since } : {}),
        limit: 500,
      });
      report.applied += this.store.applyChanges(hub, page.items);
      if (page.next === null || page.items.length === 0) return;
    }
  }
}

const PLURALS: Record<string, string> = {
  person: "persons",
  home: "homes",
  workplace: "workplaces",
  place: "places",
  stay: "stays",
  trip: "trips",
  chapter: "chapters",
  milestone: "milestones",
  circle: "circles",
  relation: "relations",
  date: "dates",
  identity: "identities",
};
