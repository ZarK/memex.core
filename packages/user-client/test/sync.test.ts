// The outbox, the sync, and the local copy against the real facts engine (@tjalve/memex-facts) of a Memex.User hub in
// the same process. The hub is a stand-in only in its transport: it can be "stopped", and a send can lose its answer.
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openFacts, userHub, FactsError, type FactsEngine } from "@tjalve/memex-facts";
import { openDatabase, type SqliteDatabase } from "@tjalve/memex-sqlite";
import { nodeSqlite } from "@tjalve/memex-sqlite/node-sqlite";
import { SurfaceError } from "@tjalve/memex-surfaces";
import { describe, expect, it } from "vitest";
import { FactsSync, type HubClient, type HubCorrection } from "../src/index.js";

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "memex-user-client-"));

class StandIn {
  online = true;
  calls = 0;
  constructor(readonly facts: FactsEngine) {}
  #up() {
    if (!this.online) throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1"), { code: "ECONNREFUSED" });
  }
  client(): HubClient {
    const self = this;
    const wrap = <T>(fn: () => T) => {
      self.#up();
      try {
        return Promise.resolve(fn());
      } catch (error) {
        if (error instanceof FactsError) return Promise.reject(new SurfaceError("invalid_input", error.message, { status: error.status }));
        return Promise.reject(error);
      }
    };
    return {
      hub: "user",
      correctionsWrite: (body: { corrections: HubCorrection[] }) => {
        self.calls++;
        return wrap(() => self.facts.writeCorrections(body as never));
      },
      changesList: (body: { since?: string; limit?: number }) => wrap(() => self.facts.listChanges(body)),
      tripsGet: (body: { id: string }) => wrap(() => ({ record: self.facts.getRecord(body.id) })),
    } as unknown as HubClient;
  }
}

function hub(): { facts: FactsEngine; standIn: StandIn; tripId: string } {
  const db = openDatabase(":memory:", { driver: nodeSqlite, idleCheckpointMs: 0 });
  const facts = openFacts(db, { hub: userHub });
  const out = facts.writeClaims({
    scope: "photos.trips",
    generation: 1,
    claims: [
      {
        key: "trip-1",
        kind: "trip",
        confidence: 0.9,
        method: "rule:trip-nearness/2",
        generation: 1,
        fields: { title: "Lisbon", firstDay: "2025-05-01", lastDay: "2025-05-06", countries: ["PT"] },
        sources: [{ app: "photos", kind: "trip", id: "t1" }],
      },
    ],
  } as never);
  return { facts, standIn: new StandIn(facts), tripId: out.records[0]!.id! };
}

function app(file: string, standIn: StandIn, options: { version?: string; afterSend?: () => void; name?: string } = {}): { db: SqliteDatabase; sync: FactsSync } {
  const db = openDatabase(file, { driver: nodeSqlite, idleCheckpointMs: 0 });
  const sync = new FactsSync({
    db,
    app: options.name ?? "photos",
    appVersion: options.version ?? "1.0.0",
    connect: async () => standIn.client(),
    afterSend: options.afterSend,
  });
  return { db, sync };
}

const at = (s: number) => new Date(Date.UTC(2026, 9, 25, 10, 0, s)).toISOString();

describe("the outbox", () => {
  it("keeps edits across a stopped hub and a restart, and delivers each once in createdAt order", async () => {
    const { facts, standIn, tripId } = hub();
    const file = path.join(tmp(), "app.db");
    let { db, sync } = app(file, standIn);
    await sync.syncOnce();
    expect(sync.store.record("user", tripId)?.record.fields).toMatchObject({ title: "Lisbon" });

    standIn.online = false;
    sync.save("user", { op: "set", record: tripId, fields: { title: "Lisbon and Sintra" }, createdAt: at(1) } as never);
    sync.save("user", { op: "set", record: tripId, fields: { countries: ["PT", "ES"] }, createdAt: at(2) } as never);
    const failed = await sync.syncOnce();
    expect(failed[0]).toMatchObject({ delivered: 0, waiting: 2 });
    expect(failed[0]!.error).toMatch(/ECONNREFUSED/);
    // Saved at once, shown as saved.
    expect(sync.store.record("user", tripId)?.record.fields).toMatchObject({ title: "Lisbon and Sintra", countries: ["PT", "ES"] });
    db.close();

    // The app restarts; the hub comes back.
    ({ db, sync } = app(file, standIn));
    expect(sync.status("user").waiting).toBe(2);
    standIn.online = true;
    const done = await sync.syncOnce();
    expect(done[0]).toMatchObject({ delivered: 2, waiting: 0, repeats: 0 });
    const stored = facts.listCorrections({}).items;
    expect(stored.map((c) => c.createdAt)).toEqual([at(1), at(2)]);
    expect(facts.getRecord(tripId)!.fields).toMatchObject({ title: "Lisbon and Sintra", countries: ["PT", "ES"] });
    db.close();
  });

  it("sends a correction again after a lost answer, and the hub stores it once", async () => {
    const { facts, standIn, tripId } = hub();
    const file = path.join(tmp(), "app.db");
    let lose = true;
    const { sync } = app(file, standIn, {
      afterSend: () => {
        if (lose) throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
      },
    });
    const saved = sync.save("user", { op: "set", record: tripId, fields: { title: "Porto" } } as never);
    const first = await sync.syncOnce();
    expect(first[0]).toMatchObject({ delivered: 0, waiting: 1 });
    lose = false;
    const second = await sync.syncOnce();
    expect(second[0]).toMatchObject({ delivered: 1, repeats: 1, waiting: 0 });
    expect(standIn.calls).toBe(2);
    expect(facts.listCorrections({}).items.filter((c) => c.id === saved.correction.id)).toHaveLength(1);
  });

  it("orders by when the person acted, not by the send", async () => {
    const { facts, standIn, tripId } = hub();
    const a = app(path.join(tmp(), "a.db"), standIn, { name: "photos" });
    const b = app(path.join(tmp(), "b.db"), standIn, { name: "health" });
    a.sync.save("user", { op: "set", record: tripId, fields: { title: "Earlier" }, createdAt: at(1) } as never);
    b.sync.save("user", { op: "set", record: tripId, fields: { title: "Later" }, createdAt: at(2) } as never);
    await b.sync.syncOnce();
    const [report] = await a.sync.syncOnce();
    expect(report).toMatchObject({ delivered: 1, readBack: 1 });
    expect(facts.getRecord(tripId)!.fields).toMatchObject({ title: "Later" });
    // The app read the winner back once.
    expect(a.sync.store.record("user", tripId)?.record.fields).toMatchObject({ title: "Later" });
  });
});

describe("reading back", () => {
  it("reads a superseded record back in a later round when the first read fails", async () => {
    const { facts, standIn, tripId } = hub();
    // The first read back fails: the connection drops after the write was stored.
    const realGet = standIn.client.bind(standIn);
    let failGet = false;
    standIn.client = () => {
      const c = realGet() as unknown as Record<string, unknown>;
      return {
        ...c,
        tripsGet: (body: { id: string }) => {
          if (failGet) {
            failGet = false;
            return Promise.reject(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }));
          }
          return (c.tripsGet as (b: { id: string }) => Promise<unknown>)(body);
        },
      } as unknown as HubClient;
    };
    const a = app(path.join(tmp(), "a.db"), standIn, { name: "photos" });
    const b = app(path.join(tmp(), "b.db"), standIn, { name: "health" });
    await a.sync.syncOnce();
    standIn.online = false;
    a.sync.save("user", { op: "set", record: tripId, fields: { title: "Mine (earlier)" }, createdAt: at(1) } as never);
    standIn.online = true;
    b.sync.save("user", { op: "set", record: tripId, fields: { title: "Other app (later)" }, createdAt: at(2) } as never);
    await b.sync.syncOnce();
    // The feed goes past the winning change while the field is protected.
    await a.sync.pull("user");
    expect(a.sync.store.record("user", tripId)!.record.fields).toMatchObject({ title: "Mine (earlier)" });
    failGet = true;
    const [first] = await a.sync.syncOnce();
    expect(first).toMatchObject({ delivered: 1, readBack: 0, waiting: 0 });
    expect(first!.error).toMatch(/socket hang up/);
    expect(a.sync.store.readBacks("user")).toEqual([tripId]);
    // The app restarts; the next round reads the record back before anything else.
    const again = app(path.join(path.dirname(a.db.path), "a.db"), standIn, { name: "photos" });
    const [second] = await again.sync.syncOnce();
    expect(second).toMatchObject({ readBack: 1, waiting: 0 });
    expect(again.sync.store.readBacks("user")).toEqual([]);
    expect(facts.getRecord(tripId)!.fields).toMatchObject({ title: "Other app (later)" });
    expect(again.sync.store.record("user", tripId)!.record.fields).toMatchObject({ title: "Other app (later)" });
  });
});

describe("the local copy", () => {
  it("applies the feed without overwriting an edit that waits", async () => {
    const { standIn, tripId } = hub();
    const a = app(path.join(tmp(), "a.db"), standIn, { name: "photos" });
    const b = app(path.join(tmp(), "b.db"), standIn, { name: "health" });
    await a.sync.syncOnce();
    await b.sync.syncOnce();
    standIn.online = false;
    // Explicit times: two saves can fall in the same millisecond, and the hub then orders them by arrival, so mine
    // (sent last) would win and nothing would be read back.
    a.sync.save("user", { op: "set", record: tripId, fields: { title: "Mine, waiting" }, createdAt: at(1) } as never);
    standIn.online = true;
    b.sync.save("user", { op: "set", record: tripId, fields: { title: "Theirs", countries: ["PT", "ES"] }, createdAt: at(2) } as never);
    await b.sync.syncOnce();
    const pulled = await a.sync.pull("user");
    expect(pulled.applied).toBeGreaterThan(0);
    const local = a.sync.store.record("user", tripId)!;
    expect(local.record.fields).toMatchObject({ title: "Mine, waiting", countries: ["PT", "ES"] });
    // Sent now, mine is the earlier act: the hub keeps it in the history, theirs wins, and the app reads the winner back.
    const [sent] = await a.sync.syncOnce();
    expect(sent).toMatchObject({ delivered: 1, readBack: 1 });
    expect(a.sync.store.record("user", tripId)!.record.fields).toMatchObject({ title: "Theirs", countries: ["PT", "ES"] });
  });

  it("gives a create's local id the hub's record id, and a later edit of it waits until then", async () => {
    const { facts, standIn } = hub();
    const { sync } = app(path.join(tmp(), "a.db"), standIn);
    const created = sync.save("user", {
      op: "create",
      kind: "home",
      fields: { type: "home", town: "Bergen", from: "2019" },
      sources: [{ app: "photos", kind: "home", id: "h1" }],
    } as never);
    sync.save("user", { op: "set", record: created.localId, fields: { label: "The flat" } } as never);
    expect(sync.store.nextBatch("user", "1.0.0")).toHaveLength(1);
    const [report] = await sync.syncOnce();
    expect(report).toMatchObject({ delivered: 2, waiting: 0 });
    const id = sync.store.recordIdOf("user", created.localId!)!;
    expect(id).toMatch(/^home_[0-9a-f]{32}$/);
    expect(facts.getRecord(id)!.fields).toMatchObject({ town: "Bergen", label: "The flat" });
    expect(sync.store.record("user", created.localId!)!.id).toBe(id);
  });
});

describe("marks", () => {
  it("keeps a refused correction with its mark, sends the others, and tries it again after an app update", async () => {
    const { facts, standIn, tripId } = hub();
    const file = path.join(tmp(), "a.db");
    let { db, sync } = app(file, standIn, { version: "1.0.0" });
    sync.save("user", { op: "set", record: tripId, fields: { nonsense: 1 } } as never);
    sync.save("user", { op: "set", record: tripId, fields: { title: "Fine" } } as never);
    const [report] = await sync.syncOnce();
    expect(report).toMatchObject({ refused: 1, delivered: 1, waiting: 1 });
    expect(sync.store.outbox("user")[0]!.refused).toMatchObject({ appVersion: "1.0.0" });
    expect(facts.getRecord(tripId)!.fields).toMatchObject({ title: "Fine" });
    // The same version does not try again.
    expect(sync.store.nextBatch("user", "1.0.0")).toHaveLength(0);
    db.close();
    ({ db, sync } = app(file, standIn, { version: "1.0.1" }));
    expect(sync.store.nextBatch("user", "1.0.1")).toHaveLength(1);
    db.close();
  });

  it("keeps a held correction's mark until a later correction of the same field", async () => {
    const { standIn } = hub();
    const { sync } = app(path.join(tmp(), "a.db"), standIn);
    const created = sync.save("user", { op: "create", kind: "home", fields: { type: "home", town: "Oslo" } } as never);
    await sync.syncOnce();
    const id = sync.store.recordIdOf("user", created.localId!)!;
    sync.save("user", { op: "clear", record: id, names: ["type"] } as never);
    const [held] = await sync.syncOnce();
    expect(held).toMatchObject({ held: 1, waiting: 0 });
    expect(sync.store.held("user")).toMatchObject([{ code: "required-field" }]);
    expect(sync.store.protectedFields("user", id).has("type")).toBe(true);
    sync.save("user", { op: "set", record: id, fields: { type: "cabin" } } as never);
    await sync.syncOnce();
    expect(sync.store.held("user")).toEqual([]);
    expect(sync.store.record("user", id)!.record.fields).toMatchObject({ type: "cabin" });
  });
});

describe("the background sync", () => {
  it("delivers a saved edit without a call from the app, and stops", async () => {
    const { facts, standIn, tripId } = hub();
    const { sync } = app(path.join(tmp(), "a.db"), standIn);
    sync.start();
    const saved = sync.save("user", { op: "set", record: tripId, fields: { title: "In the background" } } as never);
    for (let i = 0; i < 100 && sync.status("user").waiting > 0; i++) await new Promise((r) => setTimeout(r, 10));
    await sync.stop();
    expect(sync.status("user").waiting).toBe(0);
    expect(facts.listCorrections({}).items.map((c) => c.id)).toEqual([saved.correction.id]);
  });
});
