#!/usr/bin/env node
// A small app on @tjalve/memex-user-client, for the proof run (proof.sh): it keeps its own table of edits and the
// client's outbox and local copy in one SQLite database, and syncs with the real Memex.User.
//
//   node proof/proof-app.mjs --db <file> --app <id> [--no-start] [--lose-answer] <command>
//     pull                          read the change feed into the local copy (no send)
//     sync                          send the outbox, then read the feed
//     set <record> <field> <json>   save an edit (the app's table and the outbox in one transaction), then try to send
//     save <correction json>        save any correction (create, set, clear, merge, ...) the same way, then try to send;
//                                   it prints the local id of a create
//     show <record>                 the local copy of a record, with its protected fields
//     list                          the records of the local copy
//     outbox                        the corrections that wait, with the mark of a refused one
//     held                          the held marks
//     edits                         the app's own log of edits: id, createdAt, op, record, field, value, and whether
//                                   the edit waits in the outbox with a refused mark
//
// --expect <name=value,...>: the sync report must have these values (delivered=2,waiting=0); otherwise exit code 4.
// --no-start: the sync uses Memex.User only when it runs (as when it is stopped and cannot start).
// --lose-answer: the process stops after User answered a corrections write and before the outbox records the answer,
// as if the answer were lost.
import { openDatabase } from "@tjalve/memex-sqlite";
import { nodeSqlite } from "@tjalve/memex-sqlite/node-sqlite";
import { FactsSync, ensureUser } from "../dist/index.js";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const has = (name) => {
  const i = args.indexOf(name);
  if (i >= 0) args.splice(i, 1);
  return i >= 0;
};
const file = flag("--db");
const app = flag("--app") ?? "proofts";
const noStart = has("--no-start");
const loseAnswer = has("--lose-answer");
const expect = flag("--expect");
const [command, ...rest] = args;
if (!file || !command) {
  console.error("Usage: proof-app.mjs --db <file> --app <id> [--no-start] [--lose-answer] <pull|sync|set|save|show|list|outbox|held|edits> ...");
  process.exit(2);
}

const db = openDatabase(file, { driver: nodeSqlite });
db.exec("CREATE TABLE IF NOT EXISTS proof_edits (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, op TEXT NOT NULL, record TEXT NOT NULL, field TEXT NOT NULL, value TEXT NOT NULL)");
const sync = new FactsSync({
  db,
  app,
  appVersion: "0.1.0",
  hubs: ["user"],
  connect: async () => {
    const client = await ensureUser({ start: !noStart });
    const l = client.launch;
    console.log(`  ensureUser: ${l.action}, Memex User ${l.record.version}, process ${l.record.running.pid}, ${l.record.running.url}`);
    return client;
  },
  afterSend: (hub, corrections) => {
    if (!loseAnswer) return;
    console.log(`  User stored ${corrections.length} correction(s); the process stops before the outbox records the answer.`);
    db.close();
    process.exit(3);
  },
});

const brief = (r) => ({
  id: r.id,
  version: r.version,
  state: r.state,
  ...(r.removed ? { removed: true, mergedInto: r.mergedInto } : {}),
  ...(r.kind === "trip" ? { title: r.record.fields.title, countries: r.record.fields.countries } : { fields: r.record.fields }),
});
const print = (report) => {
  const { hub, delivered, repeats, held, refused, readBack, applied, waiting, error } = report;
  console.log(`  ${hub}: delivered ${delivered}, repeats ${repeats}, held ${held}, refused ${refused}, read back ${readBack}, feed changes applied ${applied}, waiting ${waiting}${error ? `, not reached: ${error}` : ""}`);
  if (!expect) return;
  const wrong = expect
    .split(",")
    .map((pair) => pair.split("="))
    .filter(([name, value]) => String(report[name]) !== value)
    .map(([name, value]) => `${name} ${report[name]}, expected ${value}`);
  console.log(wrong.length ? `  EXPECTATION FAILED: ${wrong.join("; ")}` : `  as expected: ${expect}`);
  if (wrong.length) process.exitCode = 4;
};

switch (command) {
  case "pull":
    print(await sync.pull("user"));
    break;
  case "sync":
    for (const r of await sync.syncOnce()) print(r);
    break;
  case "set": {
    const [record, field, json] = rest;
    const value = JSON.parse(json);
    // The app's own edit and the correction in one transaction.
    const saved = db.transaction(() => {
      const s = sync.save("user", { op: "set", record, fields: { [field]: value } });
      db.run("INSERT INTO proof_edits (id, created_at, op, record, field, value) VALUES (?, ?, 'set', ?, ?, ?)", s.correction.id, s.correction.createdAt, record, field, json);
      return s;
    });
    console.log(`  saved ${saved.correction.id} at ${saved.correction.createdAt}: ${record} ${field} = ${json}`);
    print(await sync.send("user"));
    break;
  }
  case "save": {
    const input = JSON.parse(rest[0]);
    const saved = db.transaction(() => {
      const s = sync.save("user", input);
      const c = s.correction;
      const record = c.record ?? s.localId ?? (c.records ?? []).join("+");
      const field = Object.keys(c.fields ?? {}).join(",") || (c.names ?? []).join(",") || "*";
      db.run("INSERT INTO proof_edits (id, created_at, op, record, field, value) VALUES (?, ?, ?, ?, ?, ?)", c.id, c.createdAt, c.op, record, field, JSON.stringify(c));
      return s;
    });
    console.log(`  saved ${saved.correction.id} at ${saved.correction.createdAt}: ${saved.correction.op} ${saved.correction.record ?? (saved.correction.records ?? []).join(" + ") ?? ""}${saved.localId ? ` local id ${saved.localId}` : ""}`);
    print(await sync.send("user"));
    break;
  }
  case "held":
    for (const h of sync.store.held("user")) console.log(`  ${h.correction.id} ${h.correction.op} ${h.record} held: ${h.code}: ${h.message}`);
    console.log(`  ${sync.store.held("user").length} held`);
    break;
  case "show": {
    const r = sync.store.record("user", rest[0]);
    console.log(JSON.stringify({ ...brief(r), protected: [...sync.store.protectedFields("user", r.id)] }));
    break;
  }
  case "list":
    for (const r of sync.store.records("user")) console.log(`  ${JSON.stringify(brief(r))}`);
    break;
  case "outbox":
    for (const i of sync.store.outbox("user"))
      console.log(
        `  ${i.correction.id} ${i.correction.createdAt} ${i.correction.op} ${i.correction.record ?? i.localId ?? (i.correction.records ?? []).join("+")} ${JSON.stringify(i.correction.fields ?? i.correction.names ?? "")} attempts ${i.attempts}${i.refused ? `, refused by User (app version ${i.refused.appVersion}): ${i.refused.code}: ${i.refused.message}` : ""}`,
      );
    console.log(`  ${sync.store.outbox("user").length} waiting`);
    break;
  case "edits":
  {
    const refused = new Set(sync.store.outbox("user").filter((i) => i.refused).map((i) => i.correction.id));
    console.log(JSON.stringify(db.all("SELECT id, created_at AS createdAt, op, record, field, value FROM proof_edits ORDER BY created_at").map((e) => ({ ...e, refused: refused.has(e.id) }))));
  }
    break;
  default:
    console.error(`Unknown command ${command}.`);
    process.exit(2);
}
db.close();
