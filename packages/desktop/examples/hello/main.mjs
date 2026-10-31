// The main process of Memex Hello: everything comes from the Memex desktop shell.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { app } from 'electron'
import { startDesktopApp } from '@tjalve/memex-desktop'
import { helloIdentity } from './identity.mjs'
import { helloPaths } from './paths.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const paths = helloPaths()
const identity = helloIdentity()

// MEMEX_HELLO_PROOF=<folder> records what the shell does and what the window shows, for trying the shell by hand
// and in a release smoke test: events.jsonl, and a picture and the text of each screen. In that mode:
// - MEMEX_HELLO_OPEN_ABOUT=1 opens About after the app loads, and MEMEX_HELLO_PRESS_NOTICES=1 then presses its
//   "Open the notices folder" button.
// - MEMEX_HELLO_PRESS=restart|quit presses that button on the crash screen.
// - MEMEX_HELLO_PROBE=1 makes the first app page try to leave the app (links and navigations to other origins), ask
//   for permissions, and then crash its own page process.
// - Links and folders the shell would open in the browser or the file manager are recorded instead of opened.
// Buttons are pressed with mouse input sent to the page (webContents.sendInputEvent), not with page script.
// MEMEX_HELLO_READY_TIMEOUT_MS shortens the wait for the server's ready line, and MEMEX_HELLO_COOKIE_TIMEOUT_MS the wait
// for the token cookie (a cookie that is never stored shows the crash screen).
const proof = process.env.MEMEX_HELLO_PROOF
if (proof) {
  mkdirSync(proof, { recursive: true })
  // When the app becomes the active app (macOS) and a window gets the focus: the proof of open.
  app.on('did-become-active', () => note({ type: 'proof-app-active' }))
  app.on('activate', (_event, hasVisibleWindows) => note({ type: 'proof-activate', hasVisibleWindows }))
  app.on('browser-window-focus', (_event, win) => note({ type: 'proof-window-focus', title: win.getTitle() }))
}

const shell = startDesktopApp({
  app: identity.app,
  productName: identity.productName,
  paths,
  // MEMEX_HELLO_SERVER=exec runs the same server as its own program (this Electron program as Node.js), the way an
  // app runs a server that is not JavaScript, such as a .NET engine.
  server: (context) => process.env.MEMEX_HELLO_SERVER === 'exec'
    ? { kind: 'exec', command: process.execPath, args: [path.join(context.appPath, 'server.mjs')] }
    : { kind: 'node', entry: path.join(context.appPath, 'server.mjs') },
  env: {
    MEMEX_HELLO_ROOT: paths.root,
    ...(process.env.MEMEX_HELLO_SERVER === 'exec' ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
  },
  icon: path.join(here, 'icons', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
  license: 'MIT',
  copyright: 'Copyright (c) 2026 Tjalve Aarflot',
  homepage: 'https://github.com/ZarK/memex.core/tree/main/packages/desktop',
  notices: app.isPackaged ? undefined : path.join(here, 'build', 'notices', 'notices.json'),
  readyTimeoutMs: Number(process.env.MEMEX_HELLO_READY_TIMEOUT_MS) || undefined,
  cookieTimeoutMs: Number(process.env.MEMEX_HELLO_COOKIE_TIMEOUT_MS) || undefined,
  onEvent: record,
  ...(proof
    ? {
        openExternal: async (url) => note({ type: 'proof-open-external', url }),
        openPath: async (folder) => {
          note({ type: 'proof-open-path', folder })
          return ''
        },
      }
    : {}),
})

function note(entry) {
  if (!proof) return
  appendFileSync(path.join(proof, 'events.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), mainPid: process.pid, ...entry })}\n`)
}

const counts = new Map()

async function waitFor(win, ready) {
  for (let i = 0; i < 50; i++) {
    if (await win.webContents.executeJavaScript(ready).catch(() => false)) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

async function capture(win, kind, ready) {
  counts.set(kind, (counts.get(kind) ?? 0) + 1)
  const name = `${kind}-${counts.get(kind)}`
  await waitFor(win, ready)
  const image = await win.webContents.capturePage()
  writeFileSync(path.join(proof, `${name}.png`), image.toPNG())
  const text = await win.webContents.executeJavaScript('document.body.innerText')
  writeFileSync(path.join(proof, `${name}.txt`), text)
  note({ type: 'captured', name, url: win.webContents.getURL(), title: win.getTitle(), text })
}

// Presses a button with mouse input at its place on the page, as a click by the user would.
async function press(win, id) {
  const box = await win.webContents.executeJavaScript(`(() => { const el = document.getElementById(${JSON.stringify(id)}); el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()`)
  note({ type: 'pressing', id, point: box })
  win.focus()
  win.webContents.sendInputEvent({ type: 'mouseMove', x: box.x, y: box.y })
  win.webContents.sendInputEvent({ type: 'mouseDown', x: box.x, y: box.y, button: 'left', clickCount: 1 })
  win.webContents.sendInputEvent({ type: 'mouseUp', x: box.x, y: box.y, button: 'left', clickCount: 1 })
}

let probed = false

// The app page tries to leave the app and to get permissions; the shell must refuse each one.
async function probe(win) {
  const tries = [
    "window.open('https://example.com/from-window-open'); 'window.open https'",
    "window.open('http://127.0.0.1:9/from-window-open'); 'window.open loopback'",
    "(() => { const a = document.createElement('a'); a.href = 'https://example.org/from-link'; a.target = '_blank'; document.body.append(a); a.click(); return 'link https, new window' })()",
    "location.href = 'http://127.0.0.1:9/elsewhere'; 'navigate loopback'",
    "location.href = 'https://example.net/elsewhere'; 'navigate https'",
    "location.href = 'file:///etc/hosts'; 'navigate file'",
    "Notification.requestPermission().then((r) => 'notifications: ' + r)",
    "new Promise((resolve) => navigator.geolocation.getCurrentPosition(() => resolve('geolocation: allowed'), (e) => resolve('geolocation: ' + e.message), { timeout: 5000 }))",
    "navigator.mediaDevices.getUserMedia({ video: true }).then(() => 'camera: allowed', (e) => 'camera: ' + e.name)",
  ]
  for (const code of tries) {
    const result = await win.webContents.executeJavaScript(code, true).catch((e) => `error: ${e.message}`)
    await new Promise((resolve) => setTimeout(resolve, 300))
    note({ type: 'probe', code, result, urlAfter: win.webContents.getURL() })
  }
  note({ type: 'probe-crash-page' })
  win.webContents.forcefullyCrashRenderer()
}

function record(event) {
  const { window: win, ...rest } = event
  note(rest)
  if (!proof) return
  if (event.type === 'page-loaded' && event.url.startsWith('http://127.0.0.1:')) {
    void capture(win, 'window', "!['get','post'].some((id) => document.getElementById(id).textContent === 'waiting')").then(async () => {
      if (process.env.MEMEX_HELLO_PROBE === '1' && !probed) {
        probed = true
        await probe(win)
        return
      }
      if (process.env.MEMEX_HELLO_OPEN_ABOUT === '1') shell?.showAbout()
    })
  }
  if (event.type === 'crash-screen') {
    void capture(win, 'crash', "document.readyState === 'complete' && !!document.getElementById('restart')").then(() => {
      const button = process.env.MEMEX_HELLO_PRESS
      if (button === 'restart' || button === 'quit') return press(win, button)
    })
  }
  if (event.type === 'about-shown') {
    void capture(win, 'about', "document.readyState === 'complete'").then(() => {
      if (process.env.MEMEX_HELLO_PRESS_NOTICES === '1') return press(win, 'notices')
    })
  }
}
