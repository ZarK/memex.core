// The local server of Memex Hello: the surfaces of @tjalve/memex-surfaces (/api/v1, the token, the cookie checks,
// the app record) and a small UI. The desktop shell starts it in a utility process and waits for its ready line.
import { mkdirSync, utimesSync } from 'node:fs'
import path from 'node:path'
import { openDataFolder } from '@tjalve/memex-storage'
import { serveApp } from '@tjalve/memex-surfaces'
import { announceReady, desktopLaunch, onDesktopStop } from '@tjalve/memex-desktop/server'
import { ensureNode } from '@tjalve/memex-node-client'
import { ensureUser } from '@tjalve/memex-user-client'
import { helloIdentity } from './identity.mjs'
import { helloPaths } from './paths.mjs'
import { greeting, registry } from './registry.mjs'

const paths = helloPaths()
const identity = helloIdentity()
mkdirSync(paths.state, { recursive: true })
// storage.md: a missing data folder stops the app instead of an empty one taking its place. Only the first run with
// the default root, or with a root given by MEMEX_HELLO_ROOT (Hello's MEMEX_HOME), makes it.
await openDataFolder({ app: 'hello', data: paths.data, source: process.env.MEMEX_HELLO_ROOT ? 'memex-home' : 'default', state: paths.state })

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; base-uri 'none'; form-action 'none'">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${identity.productName}</title>
<link rel="stylesheet" href="/app.css">
</head>
<body><main>
<h1>${identity.productName}</h1>
<p>The smallest app on the Memex desktop shell.</p>
<dl>
<dt>Page</dt><dd id="origin"></dd>
<dt>Cookie request</dt><dd id="get">waiting</dd>
<dt>Cookie write</dt><dd id="post">waiting</dd>
<dt>Cookie in page</dt><dd id="cookie"></dd>
<dt>Memex Node</dt><dd id="node">waiting</dd>
<dt>Memex User</dt><dd id="user">waiting</dd>
</dl>
</main><script src="/app.js"></script></body></html>
`

const STYLE = `
:root { color-scheme: light dark; --bg: #f6f3ec; --fg: #1d1b18; --muted: #5d5850; --line: #d9d2c3; --ok: #2f5d50; --bad: #9b2c2c; }
@media (prefers-color-scheme: dark) { :root { --bg: #181715; --fg: #ece8df; --muted: #a59e92; --line: #38342e; --ok: #8cc4b0; --bad: #f19c9c; } }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, "Segoe UI", sans-serif; }
main { max-width: 680px; margin: 0 auto; padding: 40px 24px; }
h1 { font-size: 24px; margin: 0 0 4px; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; border-top: 1px solid var(--line); padding-top: 16px; }
dt { color: var(--muted); }
dd { margin: 0; overflow-wrap: anywhere; }
.ok { color: var(--ok); font-weight: 600; }
.bad { color: var(--bad); font-weight: 600; }
`

const SCRIPT = `
const show = (id, text, ok) => { const el = document.getElementById(id); el.textContent = text; el.className = ok ? 'ok' : 'bad'; };
document.getElementById('origin').textContent = location.origin;
show('cookie', document.cookie === '' ? 'not readable (HttpOnly)' : 'readable: ' + document.cookie, document.cookie === '');
fetch('/ui/greeting').then(async (r) => {
  const body = await r.json();
  show('get', r.status + ' ' + (body.text ? body.text + ' (server process ' + body.pid + ', started ' + body.startedAt + ')' : JSON.stringify(body)), r.ok);
}).catch((e) => show('get', String(e), false));
fetch('/ui/greeting', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'desktop shell' }) }).then(async (r) => {
  const body = await r.json();
  show('post', r.status + ' ' + (body.text || JSON.stringify(body)), r.ok);
}).catch((e) => show('post', String(e), false));
fetch('/ui/services').then(async (r) => {
  const body = await r.json();
  for (const id of ['node', 'user']) {
    const s = body[id];
    show(id, s && s.ok ? s.name + ' ' + s.version + ' ' + s.action + ' (process ' + s.pid + ') from ' + s.program : 'not running: ' + (s ? s.error : r.status), !!(s && s.ok));
  }
}).catch((e) => { show('node', String(e), false); show('user', String(e), false); });
`

// The shared services through their clients, as every Memex app reaches them: ensureNode and ensureUser
// find the copy that runs, or start the newest copy in the services folder, which the installer or the shell's start
// filled from this build's resources/services. action says what the launcher did: found, started or took-over.
async function sharedServices() {
  const one = async (name, ensure, call) => {
    try {
      const client = await ensure()
      const launch = client.launch
      const answer = await call(client)
      return { ok: true, name, action: launch.action, version: launch.record.version, pid: launch.record.running?.pid, program: launch.record.executable, answer }
    } catch (error) {
      return { ok: false, name, error: error instanceof Error ? error.message : String(error) }
    }
  }
  return {
    node: await one('Memex Node', () => ensureNode(), async (node) => {
      const status = await node.getStatus()
      return { version: status.version, startedAt: status.startedAt }
    }),
    user: await one('Memex User', () => ensureUser(), async (user) => {
      const health = await user.getHealth()
      return { status: health.status, version: health.version }
    }),
  }
}

function send(response, status, type, body, headers = {}) {
  response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers })
  response.end(body)
}

// Runs after the request checks of @tjalve/memex-surfaces: the memex_hello_token cookie is valid, and a write came
// from the app's own origin.
async function ui(request, response) {
  const url = new URL(request.url, 'http://127.0.0.1')
  if (request.method === 'GET' && url.pathname === '/') return send(response, 200, 'text/html; charset=utf-8', PAGE)
  if (request.method === 'GET' && url.pathname === '/app.js') return send(response, 200, 'text/javascript; charset=utf-8', SCRIPT)
  if (request.method === 'GET' && url.pathname === '/app.css') return send(response, 200, 'text/css; charset=utf-8', STYLE)
  if (url.pathname === '/ui/services' && request.method === 'GET') {
    return send(response, 200, 'application/json', JSON.stringify(await sharedServices()))
  }
  if (url.pathname === '/ui/greeting' && request.method === 'GET') {
    return send(response, 200, 'application/json', JSON.stringify(greeting()))
  }
  if (url.pathname === '/ui/greeting' && request.method === 'POST') {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    let name
    try {
      name = String(JSON.parse(Buffer.concat(chunks).toString('utf8')).name ?? '').slice(0, 80)
    } catch {
      return send(response, 400, 'application/json', JSON.stringify({ error: { code: 'invalid_json', message: 'The body is not JSON.' } }))
    }
    // A cookie that lasts a year, as an app would keep a setting: Chromium stores it on disk, encrypted with the app's
    // cookie key (on macOS the "Memex Hello Safe Storage" item in the login keychain).
    const greeted = `memex_hello_greeted=${encodeURIComponent(new Date().toISOString())}; Max-Age=31536000; Path=/; HttpOnly; SameSite=Strict`
    return send(response, 200, 'application/json', JSON.stringify(greeting(name)), { 'set-cookie': greeted })
  }
  return send(response, 404, 'application/json', JSON.stringify({ error: { code: 'not_found', message: 'No such page.' } }))
}

const launch = desktopLaunch()
const running = await serveApp({
  registry,
  kind: 'app',
  data: paths.data,
  state: paths.state,
  apps: paths.apps,
  ui,
  executable: launch.executable,
  mcp: launch.mcp,
})
onDesktopStop(() => running.stop())
process.stdout.write(`Memex Hello server listening on ${running.server.url}\n`)

// MEMEX_HELLO_FAULT tries the shell's start-up checks: no-ready never writes the ready line, stale-token makes the
// token file look older than this launch, and foreign-token-file names another file than <state>/token.
const fault = process.env.MEMEX_HELLO_FAULT
if (fault === 'no-ready') {
  process.stdout.write('Memex Hello server: MEMEX_HELLO_FAULT=no-ready, so no ready line.\n')
} else {
  if (fault === 'stale-token') {
    const old = new Date(Date.now() - 60 * 60 * 1000)
    utimesSync(running.tokenFile, old, old)
  }
  const tokenFile = fault === 'foreign-token-file' ? path.join(paths.data, 'token') : running.tokenFile
  announceReady({ app: identity.app, url: running.server.url, tokenFile })
}
