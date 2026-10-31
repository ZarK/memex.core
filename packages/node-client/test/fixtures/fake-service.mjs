// A stand-in for a Memex service, for the launcher tests: it listens on a named pipe (Windows) or a Unix socket, takes a
// single-instance lock, writes its app record, answers GET /health, GET /v1/status and POST /v1/drain, and holds work
// for POST /v1/hold?ms=<n>. It gives out leases (POST /v1/leases, renew, DELETE), which hold the process like work and
// are served while it drains. It follows the rules of Memex.Node: a drain gives up the lock and never writes the record
// again; the process stops when nothing is held.
//   node fake-service.mjs --version 1.2.0 [--app node]
// MEMEX_APPS_DIR names the apps folder, FAKE_STATE the state folder.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const app = arg("--app", "node");
const version = arg("--version", "1.0.0");
const apps = process.env.MEMEX_APPS_DIR;
const state = process.env.FAKE_STATE;
fs.mkdirSync(apps, { recursive: true });
fs.mkdirSync(state, { recursive: true });

const lockFile = path.join(state, `${app}.lock`);
let lock;
try {
  lock = fs.openSync(lockFile, "wx");
} catch {
  console.log(`${app} already runs.`);
  process.exit(0);
}
let draining = false;
let held = 0;
const leases = new Set();
const releaseLock = () => {
  if (lock === undefined) return;
  fs.closeSync(lock);
  lock = undefined;
  fs.rmSync(lockFile, { force: true });
};
const record = path.join(apps, `${app}.json`);
const socket = process.platform === "win32" ? `\\\\.\\pipe\\memex-fake-${randomBytes(8).toString("hex")}` : path.join(os.tmpdir(), `memex-fake-${randomBytes(6).toString("hex")}.sock`);
const writeRecord = (running) => {
  const temp = `${record}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ format: "memex.app/1", app, name: `Fake ${app}`, kind: "service", version, executable: "not-a-program", running }, null, 2) + "\n");
  // Windows refuses a rename over a file for a moment while another process reads it (the launcher reads the record
  // while it waits for the start), so retry as renameOver of @tjalve/memex-surfaces does.
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(temp, record);
      return;
    } catch (error) {
      if (attempt >= 4 || !["EPERM", "EBUSY", "EACCES"].includes(error.code)) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (attempt + 1));
    }
  }
};
const stopIfDrained = () => {
  if (draining && held === 0) setTimeout(() => process.exit(0), 50);
};
const server = http.createServer((req, res) => {
  const json = (status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const url = new URL(req.url, "http://localhost");
  if (req.method === "GET" && url.pathname === "/health") return json(200, { status: draining ? "draining" : "ok", app, version });
  if (req.method === "POST" && url.pathname === "/v1/drain") {
    const first = !draining;
    draining = true;
    if (first) releaseLock();
    json(202, { draining: true, pid: process.pid, version, held });
    return stopIfDrained();
  }
  const lease = /^\/v1\/leases\/([^/]+)(\/renew)?$/.exec(url.pathname);
  if (lease) {
    const [, id, renew] = lease;
    const body = (state) => ({ lease: { id, state, pid: process.pid, version } });
    if (!leases.has(id)) return json(404, { error: { code: "not_found", message: `No lease ${id}.` } });
    if (renew && req.method === "POST") return json(200, body("granted"));
    if (!renew && req.method === "DELETE") {
      leases.delete(id);
      held--;
      json(200, body("ended"));
      return stopIfDrained();
    }
  }
  if (req.method === "GET" && url.pathname === "/v1/status") return json(200, { version, startedAt: "2026-10-25T00:00:00Z", devices: [], lanes: {}, leases: leases.size, sessions: 0, backends: 0, pid: process.pid });
  if (draining) return json(503, { error: { code: "draining", message: "This service drains." } });
  if (req.method === "POST" && url.pathname === "/v1/leases") {
    const id = `ls_${randomBytes(6).toString("hex")}`;
    leases.add(id);
    held++;
    return json(201, { lease: { id, state: "granted", pid: process.pid, version } });
  }
  if (req.method === "POST" && url.pathname === "/v1/hold") {
    held++;
    setTimeout(() => {
      held--;
      stopIfDrained();
    }, Number(url.searchParams.get("ms") ?? "1000"));
    return json(200, { held });
  }
  json(404, { error: { code: "not_found", message: `No route ${req.method} ${url.pathname}.` } });
});
server.listen(socket, () => writeRecord({ pid: process.pid, startedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), socket }));
process.on("exit", () => {
  if (!draining) {
    try {
      const current = JSON.parse(fs.readFileSync(record, "utf8"));
      if (current.running?.pid === process.pid) writeRecord(null);
    } catch {
      // gone
    }
  }
  releaseLock();
});
process.on("SIGTERM", () => process.exit(0));
// Stops by itself after a while, so a failed test leaves nothing behind.
setTimeout(() => process.exit(0), Number(process.env.FAKE_LIFETIME_MS ?? "30000")).unref();
