// A page with the three elements on a running Memex.Node, for a check in a browser. It stands for an app's own server:
// it serves the page and passes the elements' calls on with nodeUiCall.
//   MEMEX_APPS_DIR=<scratch> node proof/server.mjs [port]
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NodeClient } from "@tjalve/memex-node-client";
import { nodeUiCall } from "../dist/server.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const record = JSON.parse(fs.readFileSync(path.join(process.env.MEMEX_APPS_DIR, "node.json"), "utf8"));
const client = new NodeClient({ socket: record.running.socket });
const page = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Memex Node settings</title>
<style>:root { --bg: #faf8f3; --card: #fffdf8; --ink: #2a2118; --ink-2: #6b5e4c; --ink-3: #9a8d78; --line: rgba(42,33,24,.11); --line-2: rgba(42,33,24,.2); --accent: #a9761b; --sans: system-ui, sans-serif; }
body { margin: 2rem auto; max-width: 56rem; padding: 0 1rem; background: var(--bg); color: var(--ink); font-family: var(--sans); } h2 { font-weight: 500; margin-top: 2rem; }</style>
<h2>Model packs</h2><memex-node-packs app="proof"></memex-node-packs>
<h2>Where the packs are</h2><memex-node-location></memex-node-location>
<h2>Model servers and functions</h2><memex-node-backends></memex-node-backends>
<script type="module">import { defineMemexNodeElements } from "/dist/index.js"; defineMemexNodeElements();</script>`;

http.createServer(async (req, res) => {
  const url = req.url ?? "/";
  if (url === "/") return void res.writeHead(200, { "content-type": "text/html" }).end(page);
  if (url.startsWith("/dist/")) {
    const file = path.join(here, "..", url);
    if (!fs.existsSync(file)) return void res.writeHead(404).end();
    return void res.writeHead(200, { "content-type": "text/javascript" }).end(fs.readFileSync(file));
  }
  if (url.startsWith("/api/node/")) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const answer = await nodeUiCall(client, { method: req.method ?? "GET", path: url.slice("/api/node".length), body: Buffer.concat(chunks) });
    return void res.writeHead(answer.status, { "content-type": answer.contentType }).end(answer.body);
  }
  res.writeHead(404).end();
}).listen(Number(process.argv[2] ?? 18500), "127.0.0.1");
