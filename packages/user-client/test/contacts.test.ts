// The contacts target of the outbox and the feed reader against the real facts engine
// (@tjalve/memex-facts) with the Memex.Contacts hub definition, in the same process. The hub is a stand-in only in its
// transport. A proof against the running Memex.Contacts service waits for its facts API.
import { readdirSync, readFileSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openFacts, contactsHub, FactsError, type FactsEngine } from "@tjalve/memex-facts";
import { openDatabase } from "@tjalve/memex-sqlite";
import { nodeSqlite } from "@tjalve/memex-sqlite/node-sqlite";
import { SurfaceError } from "@tjalve/memex-surfaces";
import { describe, expect, it } from "vitest";
import { FactsSync, type HubClient, type HubCorrection } from "../src/index.js";

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../contracts/fixtures/contacts");
const tmp = () => mkdtempSync(path.join(os.tmpdir(), "memex-user-client-contacts-"));

function standIn(facts: FactsEngine): HubClient {
  const wrap = <T>(fn: () => T) => {
    try {
      return Promise.resolve(fn());
    } catch (error) {
      if (error instanceof FactsError) return Promise.reject(new SurfaceError("invalid_input", error.message, { status: error.status }));
      return Promise.reject(error);
    }
  };
  const get = (body: { id: string }) => wrap(() => ({ record: facts.getRecord(body.id) }));
  return {
    hub: "contacts",
    correctionsWrite: (body: { corrections: HubCorrection[] }) => wrap(() => facts.writeCorrections(body as never)),
    changesList: (body: { since?: string; limit?: number }) => wrap(() => facts.listChanges(body)),
    personsGet: get,
    homesGet: get,
  } as unknown as HubClient;
}

function contacts(): { facts: FactsEngine; jonA: string; jonB: string; kari: string; ola: string } {
  const db = openDatabase(":memory:", { driver: nodeSqlite, idleCheckpointMs: 0 });
  const facts = openFacts(db, { hub: contactsHub });
  const card = (key: string, name: string) => ({
    key,
    kind: "person",
    subject: { card: key },
    confidence: 1,
    method: "card:vcard/1",
    generation: 1,
    fields: { name, type: "person" },
    sources: [{ app: "contacts", kind: "card", id: key }],
  });
  const out = facts.writeClaims({
    scope: "contacts.persons",
    claims: [
      card("card_00000000000000000000000000000a01", "Jon Example"),
      card("card_00000000000000000000000000000a02", "Jon Example"),
      card("card_00000000000000000000000000000b01", "Kari Example"),
      card("card_00000000000000000000000000000c01", "Ola Example"),
    ],
  } as never);
  const [jonA, jonB, kari, ola] = out.records.map((r) => r.id!);
  return { facts, jonA: jonA!, jonB: jonB!, kari: kari!, ola: ola! };
}

function app(facts: FactsEngine, file = path.join(tmp(), "app.db")): FactsSync {
  const db = openDatabase(file, { driver: nodeSqlite, idleCheckpointMs: 0 });
  return new FactsSync({ db, app: "photos", appVersion: "1.0.0", hubs: ["contacts"], connect: async () => standIn(facts) });
}

describe("the contacts target", () => {
  it("saves every correction of the contacts fixtures", () => {
    const { facts } = contacts();
    const sync = app(facts);
    const files = readdirSync(FIXTURES).filter((f) => /^corrections-.*\.request\.json$/.test(f));
    const all = files.flatMap((f) => (JSON.parse(readFileSync(path.join(FIXTURES, f), "utf8")) as { corrections: HubCorrection[] }).corrections);
    expect(new Set(all.map((c) => c.op))).toEqual(new Set(["create", "merge", "pin", "set", "unmerge"]));
    for (const c of all) sync.save("contacts", c as never);
    expect(sync.status("contacts").waiting).toBe(all.length);
  });

  it("delivers merge, pin, a create with person, and unmerge, and the feed brings each back", async () => {
    const { facts, jonA, jonB, kari, ola } = contacts();
    const sync = app(facts);
    expect((await sync.pull("contacts")).applied).toBe(4);

    sync.save("contacts", { op: "merge", records: [jonA, jonB] } as never);
    sync.save("contacts", { op: "pin", records: [kari, ola] } as never);
    const home = sync.save("contacts", {
      op: "create",
      kind: "home",
      person: jonA,
      fields: { type: "home", label: "Jon's home", town: "Trondheim", from: "2011", residents: [{ person: kari, from: "2016" }] },
      sources: [{ app: "photos", kind: "home", id: "h1" }],
    } as never);
    sync.save("contacts", { op: "set", record: home.localId, fields: { label: "The house by the river" } } as never);
    // Saved at once: the merged person shows as merged, the home under its local id.
    expect(sync.store.record("contacts", jonB)!.mergedInto).toBe(jonA);
    expect(sync.store.record("contacts", home.localId!)!.record.fields).toMatchObject({ label: "The house by the river" });

    const [sent] = await sync.syncOnce();
    expect(sent).toMatchObject({ delivered: 4, refused: 0, held: 0, waiting: 0 });
    const homeId = sync.store.recordIdOf("contacts", home.localId!)!;
    expect(homeId).toMatch(/^home_[0-9a-f]{32}$/);
    expect(facts.getRecord(homeId)).toMatchObject({ person: jonA, fields: { label: "The house by the river", town: "Trondheim" } });
    expect(facts.getRecord(jonB)!.mergedInto).toBe(jonA);
    expect(facts.pins().map((p) => [...p].sort())).toEqual([[kari, ola].sort()]);
    expect(sync.store.record("contacts", home.localId!)!.id).toBe(homeId);
    expect(sync.store.record("contacts", jonB)!.mergedInto).toBe(jonA);

    sync.save("contacts", { op: "unmerge", record: jonB } as never);
    expect(sync.store.protectedFields("contacts", jonB).has("*")).toBe(true);
    expect(sync.store.record("contacts", jonB)!.mergedInto).toBeUndefined();
    const [unmerged] = await sync.syncOnce();
    expect(unmerged).toMatchObject({ delivered: 1, held: 0, waiting: 0 });
    expect(facts.getRecord(jonB)!.mergedInto).toBeUndefined();
    expect(sync.store.record("contacts", jonB)).toMatchObject({ removed: false });
    expect(sync.store.record("contacts", jonB)!.mergedInto).toBeUndefined();

    // A second unmerge of a person that is not merged is stored and held (not-merged), with a mark.
    sync.save("contacts", { op: "unmerge", record: jonB } as never);
    const [held] = await sync.syncOnce();
    expect(held).toMatchObject({ delivered: 1, held: 1, waiting: 0 });
    expect(sync.store.held("contacts")).toMatchObject([{ code: "not-merged", record: jonB }]);
  });

  it("refuses to save an unmerge without record and a pin without two records", () => {
    const { facts, kari } = contacts();
    const sync = app(facts);
    expect(() => sync.save("contacts", { op: "unmerge", person: kari } as never)).toThrow(/unmerge needs record/);
    expect(() => sync.save("contacts", { op: "pin", records: [kari] } as never)).toThrow(/pin needs records with two persons/);
  });
});
