import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ZipWriter } from "@tjalve/memex-archive";
import { FILE_ATTRIBUTE, fixtureBackend } from "@tjalve/memex-folders";
import { migrate, openDatabase, type SqliteDatabase } from "@tjalve/memex-sqlite";
import { nodeSqlite } from "@tjalve/memex-sqlite/node-sqlite";
import { createImporter, digestData, ImportError, parseCsv, setupImport, tableRecords, type Reader } from "../src/index.js";

// Two small readers: things with an id of their own, and log lines without one.
interface Thing {
  id: string;
  name: string;
}
const things: Reader<Thing> = {
  id: "test.things",
  version: 1,
  source: "import:test:things",
  repeats: "duplicate",
  detect: (s) => (s.head.startsWith("thing_id,name") ? 90 : 0),
  async *read(entry) {
    const { records } = tableRecords(parseCsv(await entry.text(), ","));
    for (const r of records) {
      if (!r.values.thing_id) yield { ref: `row ${r.row}`, skip: "no id" };
      else yield { ref: `row ${r.row}`, identity: { id: r.values.thing_id }, data: { id: r.values.thing_id, name: r.values.name ?? "" } };
    }
  },
  write(data, ctx) {
    if (data.name === "explode") throw new Error("this record cannot be written");
    const id = ctx.createEntity("test.thing");
    ctx.insert("thing", { entity_id: id, thing_id: data.id, name: data.name });
    const parent = data.name.startsWith("child of ") ? ctx.db.get<{ entity_id: string }>("SELECT entity_id FROM thing WHERE thing_id = ?", data.name.slice(9)) : undefined;
    if (parent) ctx.link(id, parent.entity_id, "test.child-of");
    return id;
  },
  describe: (t) => `${t.id} ${t.name}`,
};
const logs: Reader<{ when: string; what: string }> = {
  id: "test.log",
  version: 1,
  source: "import:test:log",
  detect: (s) => (s.head.startsWith("when,what") ? 90 : 0),
  async *read(entry) {
    const { records } = tableRecords(parseCsv(await entry.text(), ","));
    for (const r of records) yield { ref: `row ${r.row}`, identity: r.values, data: { when: r.values.when ?? "", what: r.values.what ?? "" } };
  },
  write(data, ctx) {
    const id = ctx.createEntity("test.log");
    ctx.insert("log_line", { entity_id: id, at: data.when, what: data.what });
    // An integer key left out is taken from SQLite, and tracked too.
    ctx.insert("log_word", { word: data.what.split(" ")[0] ?? "" });
    return id;
  },
};

function setup(db: SqliteDatabase): void {
  setupImport(db);
  migrate(db, "test", [
    {
      name: "0001.sql",
      sql: `CREATE TABLE thing (entity_id TEXT PRIMARY KEY REFERENCES entity(id), thing_id TEXT NOT NULL, name TEXT NOT NULL);
CREATE TABLE log_line (entity_id TEXT PRIMARY KEY REFERENCES entity(id), at TEXT NOT NULL, what TEXT NOT NULL);
CREATE TABLE log_word (id INTEGER PRIMARY KEY, word TEXT NOT NULL);`,
    },
  ]);
}

let dir: string;
let n = 0;
async function fresh(): Promise<{ db: SqliteDatabase; root: string }> {
  n += 1;
  const root = path.join(dir, `drop${n}`);
  await fs.mkdir(root, { recursive: true });
  const db = openDatabase(path.join(dir, `test${n}.db`), { driver: nodeSqlite });
  setup(db);
  return { db, root };
}
async function write(root: string, rel: string, data: string | Uint8Array): Promise<void> {
  const file = path.join(root, ...rel.split("/"));
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, data);
}

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "memex-import-test-"));
});
afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const THINGS = "thing_id,name\nt1,one\nt2,two\n,no id here\nt2,two again\n";
const LOG = "when,what\n2025-01-01,boot up\n2025-01-01,boot up\n2025-01-02,shut down\n";

describe("import", () => {
  it("previews without writing, commits per file, re-runs to nothing new, and undoes the batch", { timeout: 60_000 }, async () => {
    const { db, root } = await fresh();
    await write(root, "a/things.csv", THINGS);
    await write(root, "a/log.csv", LOG);
    await write(root, "b/copy-of-things.csv", THINGS);
    await write(root, "b/notes.txt", "nothing to read here");
    await write(root, "b/.DS_Store", "x");
    await write(root, "c/__MACOSX/._things.csv", "x");
    const importer = createImporter(db, { readers: [things, logs] });
    const before = digestData(db);

    const preview = await importer.preview([root]);
    expect(digestData(db)).toEqual(before);
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM import_batch")!.n).toBe(0);
    expect(preview.accounted).toBe(true);
    const byPath = Object.fromEntries(preview.files.map((f) => [f.path, f]));
    expect(byPath["a/things.csv"]!.records).toEqual({ read: 4, new: 2, duplicate: 0, repeated: 1, skipped: 1 });
    // Identical log lines without an id of their own are numbered, so both are kept.
    expect(byPath["a/log.csv"]!.records).toEqual({ read: 3, new: 3, duplicate: 0, repeated: 0, skipped: 0 });
    expect(byPath["b/copy-of-things.csv"]).toMatchObject({ outcome: "copy", copyOf: "a/things.csv" });
    expect(byPath["b/notes.txt"]!.outcome).toBe("unrecognised");
    expect(preview.files.find((f) => f.path.endsWith("._things.csv"))!.outcome).toBe("ignored");
    expect(preview.totals.tables.thing).toEqual({ inserted: 2, updated: 0, deleted: 0 });

    const commit = await importer.commit([root]);
    expect(commit.accounted).toBe(true);
    expect(commit.files.map((f) => [f.path, f.outcome, f.records.new])).toEqual(preview.files.map((f) => [f.path, f.outcome, f.records.new]));
    expect(commit.totals.tables).toEqual(preview.totals.tables);
    const after = digestData(db);
    expect(after.tables.thing).toBe(2);
    expect(after.tables.log_line).toBe(3);
    expect(after.tables.provenance).toBe(5);
    const prov = db.get<{ batch_id: string; file_hash: string; reader: string; source_ref: string }>("SELECT * FROM provenance WHERE source = 'import:test:things' ORDER BY source_ref LIMIT 1")!;
    expect(prov).toMatchObject({ batch_id: commit.batchId, reader: "test.things/1", source_ref: "a/things.csv#row 2" });
    expect(prov.file_hash).toMatch(/^[0-9a-f]{64}$/);

    const again = await importer.commit([root]);
    expect(again.totals.records.new).toBe(0);
    expect(again.files.find((f) => f.path === "a/things.csv")).toMatchObject({ outcome: "unchanged", importedIn: commit.batchId });
    expect(digestData(db)).toEqual(after);
    const reread = await importer.commit([root], { reread: true });
    expect(reread.files.find((f) => f.path === "a/things.csv")!.records).toEqual({ read: 4, new: 0, duplicate: 2, repeated: 1, skipped: 1 });
    expect(reread.accounted).toBe(true);

    const undo = importer.undo(commit.batchId);
    expect(undo.undone).toHaveLength(2);
    expect(digestData(db)).toEqual(before);
    expect(() => importer.undo(commit.batchId)).toThrow(ImportError);
    expect(importer.batches().map((b) => b.state)).toEqual(["committed", "committed", "undone"]);

    // After an undo, the same files are read again, not taken as unchanged.
    const back = await importer.commit([root]);
    expect(back.files.find((f) => f.path === "a/things.csv")!.outcome).toBe("imported");
    expect(back.totals.records.new).toBe(5);
    db.close();
  });

  it("reads zip and gzip entries, and a file whose reader fails leaves the others committed", { timeout: 60_000 }, async () => {
    const { db, root } = await fresh();
    const zip = await ZipWriter.create(path.join(root, "pack.zip"));
    await zip.add("inner/things.csv", Buffer.from(THINGS));
    await zip.add("inner/readme.txt", Buffer.from("hello"));
    await zip.close();
    await write(root, "log.csv.gz", gzipSync(LOG));
    await write(root, "z/bad.csv", "thing_id,name\nt9,fine\nt10,explode\n");
    await write(root, "z/broken.csv.gz", gzipSync(LOG).subarray(0, 20));
    const importer = createImporter(db, { readers: [things, logs] });
    const report = await importer.commit([root]);
    expect(report.accounted).toBe(true);
    const outcomes = Object.fromEntries(report.files.map((f) => [f.path, f.outcome]));
    expect(outcomes).toMatchObject({
      "pack.zip": "archive",
      "pack.zip › inner/things.csv": "imported",
      "pack.zip › inner/readme.txt": "unrecognised",
      "log.csv.gz": "archive",
      "log.csv.gz › log.csv": "imported",
      "z/bad.csv": "failed",
    });
    expect(report.files.find((f) => f.path === "pack.zip")!.entries).toBe(2);
    expect(["failed", "archive"]).toContain(outcomes["z/broken.csv.gz"]);
    expect(report.files.find((f) => f.path === "z/bad.csv")!.reason).toMatch(/nothing from it was written/);
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM thing WHERE thing_id = 't9'")!.n).toBe(0);
    expect(digestData(db).tables.thing).toBe(2);
    const stored = importer.batch(report.batchId)!;
    expect(stored.files.find((f) => f.path === "pack.zip")).toMatchObject({ outcome: "archive", reason: "2 entries" });
    db.close();
  });

  it("refuses to undo a batch whose rows a later batch refers to", { timeout: 60_000 }, async () => {
    const { db, root } = await fresh();
    await write(root, "one/things.csv", "thing_id,name\np1,parent\n");
    const importer = createImporter(db, { readers: [things, logs] });
    const first = await importer.commit([path.join(root, "one")]);
    await write(root, "two/things.csv", "thing_id,name\nc1,child of p1\n");
    const second = await importer.commit([path.join(root, "two")]);
    expect(second.totals.tables.relationship).toEqual({ inserted: 1, updated: 0, deleted: 0 });
    const between = digestData(db);
    expect(() => importer.undo(first.batchId)).toThrow(/cannot be undone/);
    expect(digestData(db)).toEqual(between);
    importer.undo(second.batchId);
    importer.undo(first.batchId);
    expect(digestData(db).tables.thing).toBe(0);
    db.close();
  });

  it("refuses readers without an id, a version, or a source", () => {
    const db = openDatabase(":memory:", { driver: nodeSqlite });
    expect(() => createImporter(db, { readers: [{ ...things, id: "Bad Id" }] })).toThrow(ImportError);
    expect(() => createImporter(db, { readers: [{ ...things, version: 0 }] })).toThrow(ImportError);
    expect(() => createImporter(db, { readers: [things, things] })).toThrow(ImportError);
    db.close();
  });

  it("reports online-only files without reading them", { timeout: 60_000 }, async () => {
    const { db, root } = await fresh();
    await write(root, "things.csv", THINGS);
    const backend = fixtureBackend(
      {
        platform: "win32",
        folders: {
          "": [
            { name: "things.csv", size: Buffer.byteLength(THINGS) },
            { name: "cloud.csv", size: 12345, attributes: FILE_ATTRIBUTE.RECALL_ON_DATA_ACCESS },
          ],
        },
      },
      root,
    );
    const report = await createImporter(db, { readers: [things] }).preview([root], { listing: { backend } });
    expect(report.files.map((f) => [f.path, f.outcome])).toEqual([
      ["cloud.csv", "online-only"],
      ["things.csv", "imported"],
    ]);
    expect(report.onlineOnly).toEqual({ files: 1, bytes: 12345 });
    expect(report.accounted).toBe(true);
    db.close();
  });

  it("imports a single file root", { timeout: 60_000 }, async () => {
    const { db, root } = await fresh();
    await write(root, "things.csv", THINGS);
    const report = await createImporter(db, { readers: [things] }).commit([path.join(root, "things.csv")]);
    expect(report.files).toHaveLength(1);
    expect(report.files[0]).toMatchObject({ path: "things.csv", outcome: "imported" });
    db.close();
  });

  it("checks a single file root for online-only bytes and refuses a missing root before a batch starts", { timeout: 60_000 }, async () => {
    const { db, root } = await fresh();
    await write(root, "cloud.csv", THINGS);
    const backend = fixtureBackend(
      { platform: "win32", folders: { "": [{ name: "cloud.csv", size: 12345, attributes: FILE_ATTRIBUTE.RECALL_ON_DATA_ACCESS }] } },
      root,
    );
    const importer = createImporter(db, { readers: [things] });
    const held = await importer.commit([path.join(root, "cloud.csv")], { listing: { backend } });
    expect(held.files.map((f) => [f.path, f.outcome])).toEqual([["cloud.csv", "online-only"]]);
    expect(held.onlineOnly).toEqual({ files: 1, bytes: 12345 });
    expect(held.totals.records.read).toBe(0);
    const allowed = await importer.preview([path.join(root, "cloud.csv")], { listing: { backend }, allowOnlineOnly: true });
    expect(allowed.files[0]).toMatchObject({ path: "cloud.csv", outcome: "imported" });
    const batches = importer.batches().length;
    await expect(importer.commit([root, path.join(root, "missing")])).rejects.toMatchObject({ code: "not-found" });
    expect(importer.batches()).toHaveLength(batches);
    db.close();
  });

  it("marks a running batch whose process is gone as stopped, so it can be undone", { timeout: 60_000 }, async () => {
    const { db, root } = await fresh();
    await write(root, "things.csv", THINGS);
    const importer = createImporter(db, { readers: [things] });
    const report = await importer.commit([root]);
    // What a killed commit leaves: the batch is still running, owned by a process that is gone.
    const { spawnSync } = await import("node:child_process");
    const gone = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
    db.run("UPDATE import_batch SET state = 'running', finished_at = NULL, totals_json = NULL, owner_pid = ? WHERE id = ?", Number(gone.stdout), report.batchId);
    const batch = importer.batch(report.batchId)!.batch;
    expect(batch.state).toBe("stopped");
    expect(batch.totals?.records).toEqual(report.totals.records);
    expect(importer.undo(report.batchId).undone).toHaveLength(1);
    expect(db.get<{ n: number }>("SELECT count(*) AS n FROM thing")!.n).toBe(0);
    // A batch whose process is alive stays running and is not undone.
    const again = await importer.commit([root], { reread: true });
    db.run("UPDATE import_batch SET state = 'running', owner_pid = ? WHERE id = ?", process.ppid, again.batchId);
    expect(() => importer.undo(again.batchId)).toThrow(/still running in process/);
    expect(importer.batch(again.batchId)!.batch.state).toBe("running");
    db.close();
  });

  it("reads a file again when an earlier batch was undone while the batch that checked it was running", { timeout: 60_000 }, async () => {
    const { db, root } = await fresh();
    await write(root, "a/things.csv", THINGS);
    await write(root, "b/slow.log", LOG);
    let release: () => void = () => {};
    let reached: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const atGate = new Promise<void>((r) => (reached = r));
    const slow: Reader<{ when: string; what: string }> = {
      ...logs,
      async *read(entry, context) {
        reached();
        await gate;
        yield* logs.read(entry, context) as AsyncIterable<never>;
      },
    };
    const importer = createImporter(db, { readers: [things, slow] });
    const first = await importer.commit([path.join(root, "a")]);
    expect(first.totals.records.new).toBe(2);
    const running = importer.commit([path.join(root, "a"), path.join(root, "b")], { reread: true });
    await atGate;
    importer.undo(first.batchId);
    release();
    const second = await running;
    expect(second.files[0]).toMatchObject({ path: "things.csv", outcome: "imported", records: { new: 0, duplicate: 2 } });
    // The next run must not take things.csv as unchanged: its records are gone, so it is read and imported again.
    const third = await importer.commit([path.join(root, "a")]);
    expect(third.files[0]).toMatchObject({ outcome: "imported", records: { new: 2 } });
    expect(db.get<{ n: number }>("SELECT count(*) AS n FROM thing")!.n).toBe(2);
    db.close();
  });
  it("keys files on the name for a reader whose records depend on it: equal bytes under two names are both read", { timeout: 60_000 }, async () => {
    const { db, root } = await fresh();
    // A daily file: its name holds the day, so two days with equal bytes are two files, not a copy.
    const daily: Reader<{ day: string; what: string }> = {
      ...logs,
      id: "test.daily",
      source: "import:test:daily",
      detect: (s) => (/^\d{4}-\d{2}-\d{2}\.csv$/.test(s.name) ? 90 : 0),
      fileKey: (s) => s.name,
      async *read(entry, context) {
        expect(context.key).toBe(entry.name);
        expect(context.hash).toMatch(/^[0-9a-f]{64}$/);
        const { records } = tableRecords(parseCsv(await entry.text(), ","));
        const day = entry.name.slice(0, 10);
        for (const r of records) yield { ref: `row ${r.row}`, identity: { day, what: r.values.what }, data: { day, what: r.values.what ?? "" } };
      },
      write(data, ctx) {
        expect(ctx.file.key).toBe(`${data.day}.csv`);
        const id = ctx.createEntity("test.log");
        ctx.insert("log_line", { entity_id: id, at: data.day, what: data.what });
        return id;
      },
    };
    const same = "what\nresting\n";
    await write(root, "2024-06-01.csv", same);
    await write(root, "2024-06-02.csv", same);
    await write(root, "copy/2024-06-02.csv", same);
    const importer = createImporter(db, { readers: [daily] });
    const first = await importer.commit([root]);
    expect(first.accounted).toBe(true);
    expect(first.files.map((f) => [f.path, f.outcome, f.key])).toEqual([
      ["2024-06-01.csv", "imported", "2024-06-01.csv"],
      ["2024-06-02.csv", "imported", "2024-06-02.csv"],
      ["copy/2024-06-02.csv", "copy", "2024-06-02.csv"],
    ]);
    expect(db.all<{ at: string }>("SELECT at FROM log_line ORDER BY at").map((r) => r.at)).toEqual(["2024-06-01", "2024-06-02"]);
    // Unchanged needs the same bytes with the same key.
    await write(root, "2024-06-03.csv", same);
    const second = await importer.commit([root]);
    expect(second.files.map((f) => [f.path, f.outcome])).toEqual([
      ["2024-06-01.csv", "unchanged"],
      ["2024-06-02.csv", "unchanged"],
      ["2024-06-03.csv", "imported"],
      ["copy/2024-06-02.csv", "copy"],
    ]);
    expect(importer.batch(second.batchId)!.files[2]).toMatchObject({ path: "2024-06-03.csv", key: "2024-06-03.csv", outcome: "imported" });
    db.close();
  });

  it("reads a forgotten file again instead of finding it unchanged", { timeout: 60_000 }, async () => {
    const { db, root } = await fresh();
    await write(root, "things.csv", THINGS);
    const importer = createImporter(db, { readers: [things, logs] });
    const first = await importer.commit([root]);
    const file = first.files[0]!;
    expect((await importer.commit([root])).files[0]!.outcome).toBe("unchanged");
    expect(importer.forget([{ hash: file.hash!, reader: file.reader! }])).toBe(1);
    expect((await importer.commit([root])).files[0]!.outcome).toBe("imported");
    db.close();
  });

  it("counts a record that write() found in the database already as a duplicate, with its provenance", { timeout: 60_000 }, async () => {
    const { db, root } = await fresh();
    // A thing named "same as <id>" stands for a thing that is there already.
    const matching: Reader<Thing> = {
      ...things,
      write(data, ctx) {
        if (data.name.startsWith("same as ")) {
          const there = ctx.db.get<{ entity_id: string }>("SELECT entity_id FROM thing WHERE thing_id = ?", data.name.slice(8))!;
          return { entity: there.entity_id, existing: true };
        }
        return things.write(data, ctx);
      },
    };
    await write(root, "a/things.csv", "thing_id,name\nt1,first\n");
    await write(root, "b/things.csv", "thing_id,name\nt9,same as t1\nt2,second\n");
    const importer = createImporter(db, { readers: [matching] });
    const report = await importer.commit([root]);
    expect(report.accounted).toBe(true);
    expect(report.files[1]!.records).toMatchObject({ read: 2, new: 1, duplicate: 1 });
    expect(report.files[1]!.sample).toEqual(["t2 second"]);
    expect(db.get<{ n: number }>("SELECT count(*) AS n FROM thing")!.n).toBe(2);
    expect(db.get<{ n: number }>("SELECT count(*) AS n FROM provenance WHERE source = ?", matching.source)!.n).toBe(3);
    const again = await importer.commit([root], { reread: true });
    expect(again.totals.records).toMatchObject({ read: 3, new: 0, duplicate: 3 });
    db.close();
  });
});
