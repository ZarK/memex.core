# @tjalve/memex-desktop

The desktop shell of every Memex app: one Electron main process that starts the app's local server, waits for its ready line, sets the token cookie and shows the app in a sandboxed window. It also has the crash screen, About from `notices.json`, the `memex-<app>` CLI shim, the electron-builder base config, and the release scripts. Extracted from the Memex Study desktop shell and its installer work.

Electron is a peer dependency. Memex pins Electron 44.7.0 (the newest major that was at least 14 days old on 25 October 2026); the shell moves to Electron 45 after 3 November.

## The main process

```js
// main.mjs
import path from "node:path";
import { startDesktopApp } from "@tjalve/memex-desktop";

startDesktopApp({
  app: "photos",                       // the cookie is memex_photos_token; the ready line must name photos
  productName: "Memex Photos",
  server: (ctx) => ({ kind: "node", entry: path.join(ctx.appPath, "server", "main.mjs") }),
  // or a program: { kind: "exec", command: path.join(ctx.resourcesPath, "engine", "Memex.Photos.Engine.exe"), args: [] }
  license: "AGPL-3.0-or-later",
  copyright: "Copyright (c) 2026 Tjalve Aarflot",
  homepage: "https://example.com/memex-photos",
});
```

What the shell does:

| Part | How |
|---|---|
| Folders | `currentMemexPaths(app)` of `@tjalve/memex-storage` (or `paths`), then `electronPaths()`: Chromium's profile in `<state>/Electron`, its cache in `<cache>/Chromium`, logs and crash dumps in `<logs>`. A folder inside the installation folder stops the app. |
| Single instance | Electron's single-instance lock in that profile. A second start focuses the first window and quits with exit code 0. |
| Servers | `node`: a JavaScript entry in an Electron utility process. `exec`: a program (for example a .NET engine) as a child process with no shell. The shell sets `MEMEX_DESKTOP_APP`, `MEMEX_DESKTOP_EXECUTABLE`, `MEMEX_DESKTOP_CLI` and `MEMEX_DESKTOP_STOP`. |
| Ready line | The server writes `MEMEX_READY {"app","url","tokenFile"}` on standard output when it listens. The URL must be `http://127.0.0.1:<port>` with no path; the token file must be `<state>/token` and newer than this launch. The token is never on the line. Without a ready line in 60 seconds (`readyTimeoutMs`), the crash screen shows. |
| Token cookie | `memex_<app>_token`, HttpOnly, SameSite=Strict, Path=/, set for the server's URL before the window loads it (contracts/surfaces.md, Token). A new token after each restart. |
| Sandbox | `app.enableSandbox()`, context isolation, no Node.js in pages, no webview. Pages can navigate only within the app's own server; https links open in the browser; other links and new windows are refused. Every permission request is denied unless the app lists it in `permissions`. |
| Crash screen | When the server exits on its own, or fails before it is ready, or the page process stops: what happened, the exit code, the last 40 lines of output, the log file, and Restart and Quit. |
| About | Help > About (the app menu on macOS): version, license, Electron, Chromium and Node.js, and every component in `notices.json` (from `memex-licenses notices`), with a button that opens the notices folder. |
| Updates | With the `updates` option: the app checks its repository's releases, downloads an update and installs it when the app quits (see Updates). |
| Quit | The shell asks the server to stop (a message to a utility process; standard input closes for a program), waits up to 5 seconds, then ends it. |
| Log | `<logs>/desktop.log`: each step, and every line the server writes. |

The shell's own pages (starting, crash, About) are served from memory on `memex-shell://app/` with a strict content security policy. Only those pages get the Restart, Quit and notices actions.

## The server

```js
import { serveApp } from "@tjalve/memex-surfaces";
import { announceReady, desktopLaunch, onDesktopStop } from "@tjalve/memex-desktop/server";

const launch = desktopLaunch();          // { desktop, app, executable, mcp }
const running = await serveApp({ registry, kind: "app", data, state, ui, executable: launch.executable, mcp: launch.mcp });
onDesktopStop(() => running.stop());     // the record says stopped, then the server exits
announceReady({ app: "photos", url: running.server.url, tokenFile: running.tokenFile });
```

`@tjalve/memex-desktop/server` imports no Electron, so the same server also runs under plain Node.js. A server in another language writes the same line.

## The CLI shim

The installer carries `resources/bin/memex-<app>.exe` (Windows) or `resources/bin/memex-<app>` (macOS, Linux). It runs the app's CLI module from `app.asar` with the Node.js inside the app's own program (`ELECTRON_RUN_AS_NODE`), so the CLI and the stdio MCP server need no separate Node.js. The shell passes the shim's path to the server, and the app record names it as the `mcp` command. Call the shim by its full path, or put the `bin` folder on PATH; a link to the shim does not work.

- On Windows the shim is a small console program, not a `.cmd` file. cmd.exe parses the arguments of a `.cmd` a second time, so a quoted argument with `&` or `|` (a JSON input that holds outside text) could run other commands, and Node.js refuses to start a `.cmd` without a shell. The program passes its command line unchanged to the app's program, waits for it, and exits with its exit code. `memex-desktop pack` compiles it with the C# compiler of the .NET Framework 4, which is part of Windows, so the Windows installer is packed on Windows.
- Windows PowerShell 5.1 drops the inner double quotes of an argument to any program, so a JSON input does not survive there as an argument. Use standard input (`'{"name":"Ada"}' | memex-<app> call <id> -`, with `$OutputEncoding` set to UTF-8 for text beyond ASCII), or PowerShell 7.3 and later.
- The shim needs the `runAsNode` fuse, which is off by default: with it on, any local program can run its own JavaScript as the app. An app that ships the CLI sets `builder.runAsNode: true` in its pack config, and `pack` refuses `cli` without it.
- An AppImage runs from a temporary mount, so its app record names the AppImage file (`$APPIMAGE`) as the program and has no `mcp` command. The deb has the shim at a stable path.
- On macOS the shim is `Contents/Resources/bin/memex-<app>` in the app bundle, a `sh` script that runs `Contents/MacOS/<Product>` with `ELECTRON_RUN_AS_NODE=1`.

`openDesktopApp()` from `@tjalve/memex-desktop/server` is the CLI's `open` (the `open` option of `runCli`): it starts the app's program without `ELECTRON_RUN_AS_NODE`; when the app runs, its window comes to the front. On macOS it opens the app bundle through LaunchServices (`/usr/bin/open -a`), as the Dock and Finder do: a running app is activated, and a new start runs as the app itself, not as a child of the terminal. On current macOS (checked on macOS 27) a new start through `open` inherits the caller's environment; `open` also passes the `MEMEX_*` variables (the folders of a test run) with `--env`, as a fallback for a macOS that does not.

### RunAsNode on macOS: opt-in, and only for an app without privacy grants

The `runAsNode` fuse stays off by default on macOS, as on Windows and Linux, and on macOS an app turns it on only when it never holds a macOS privacy grant.

- With the fuse on, any program of the account can run its own JavaScript as the app: `open -a "Memex Hello.app" --env ELECTRON_RUN_AS_NODE=1 --args -e "<code>"` ran the code in `Contents/MacOS/Memex Hello`, started by launchd (parent process 1), so macOS sees the app itself, with its bundle id `to.memex.hello`, as the responsible program.
- macOS privacy grants (TCC: Photos, Contacts, Calendars, Reminders, camera, microphone, location, and Files and Folders for Desktop, Documents, Downloads, removable and network volumes, or Full Disk Access) belong to that responsible program. So once the person grants the app access, the fuse would hand that access to every other program of the account. On Windows and Linux there are no such per-app grants, and the fuse only runs code as the same account.
- An app that reads and writes only its own folders (`~/Memex/<App>` and the OS folders of the storage contract) and asks for nothing that macOS guards may turn the fuse on for its CLI shim. Memex Hello does.
- The fuse is not the only way in: without the hardened runtime, dyld loads any library named in `DYLD_INSERT_LIBRARIES` into the app (shown on a Mac against an ad-hoc build). So every macOS build has the hardened runtime, ad hoc too, and its entitlements never allow `DYLD_*` variables (see Packing). An app with privacy grants needs both: the fuse off and the hardened runtime on.
- An app that reads files the person picks in Desktop, Documents, Downloads, Pictures or on an external drive, or that asks for Photos, Contacts, location or similar, ships on macOS without the fuse. Memex Photos is such an app, and so are most apps that import files. Such an app needs another route for its CLI and stdio MCP server on macOS that runs only the app's own code (for example a CLI mode of its main process, which reads only the checked `app.asar`), or a separate Node.js; `pack` does not offer it yet.

## Packing

`memex-desktop.config.mjs` next to the app's `package.json`:

```js
export default {
  builder: {
    app: "photos",
    productName: "Memex Photos",
    files: ["main.mjs", "server/**", "cli.mjs", "package.json", "icons/icon.ico", "icons/icon.png"],
    notices: "build/notices",                    // memex-licenses notices --out build/notices
    electronDist: "node_modules/electron/dist",  // memex-desktop fetch-electron
    runAsNode: true,                             // needed by the CLI shim; leave it out when there is no cli
  },
  cli: { entry: "cli.mjs" },
  asar: { required: ["main.mjs"], forbiddenPrefixes: ["build/"] },
  versionFiles: ["package.json"],
};
```

| Command | Does |
|---|---|
| `memex-desktop fetch-electron` | Memex installs with install scripts off, so Electron's own download does not run. This downloads the release zip of the installed `electron` version from GitHub, checks its SHA-256 against the `checksums.json` inside the npm package, unpacks it into `node_modules/electron/dist` and writes `path.txt`. The zip stays in `.cache/electron`, where `memex-licenses` finds the Chromium credits. |
| `memex-desktop icons icon.svg icons` | Renders `<size>x<size>.png`, `icon.png`, `icon.ico` and `icon.icns` with Electron. |
| `memex-desktop pack [--dir] [--require-tag]` | Checks the versions (and the `v<version>` tag from `MEMEX_RELEASE_TAG` or a GitHub tag push), writes the CLI shims, runs electron-builder with the base config, checks `app.asar` (no source maps, required files present, nothing forbidden) and writes `SHA256SUMS.txt`. |
| `memex-desktop checksums <dir> --base <name> [--merge]` | `SHA256SUMS.txt` for `<name>-<version>-<os>-<arch>` installers; `--merge` joins the `SHA256SUMS-<os>.txt` of each build job after it checks every digest. |
| `memex-desktop inspect-asar <dir> [--require <path>] [--forbid <prefix>]` | The `app.asar` check alone. |
| `memex-desktop version [--files a,b] [--require-tag]` | The version check alone. |
| `memex-desktop extract <dir> --out <empty dir> [--lockfile <pnpm-lock.yaml>]` | Writes the files of every `app.asar` (with `app.asar.unpacked`) and the rest of its `resources` folder (CLI shims, notices) into a folder, so that other tools can read what a build ships. First-party packages (`@tjalve/*` and every package the nearest `pnpm-lock.yaml` does not take from the registry) go under `node_modules.first-party`; registry packages stay under `node_modules`. Electron's own files are left out. |
| `memex-desktop smoke --program <installed program> --out <empty dir> [--timeout <s>] [--expect <text>] [-- <args>]` | Starts an installed app in smoke-test mode and fails unless it starts its server, shows its first page (HTTP 2xx, with text and a picture, and with `<text>` when given) and quits by itself. |

`MEMEX_DESKTOP_SMOKE=<absolute folder>` is the smoke-test mode of the shell: the app runs as always, the shell records its events in `events.jsonl`, and when the first app page has loaded it writes `window.png`, `window.txt` and `result.json` and quits (on the crash screen, `result.json` says why). The release workflow of memex.core uses it on every installer; see [docs/desktop-release.md](../../docs/desktop-release.md).

The base config (`builderConfig()` in `@tjalve/memex-desktop/build`):

- `appId` `to.memex.<app>`, `asar`, no source maps. `publish` is `null`, unless the app sets `updates` (see Updates).
- Windows: NSIS x64, per user (`%LOCALAPPDATA%\Programs\<Product>`, HKCU only, no elevation), the user may choose the folder, and the uninstaller leaves the user's data. The program gets its icon and version resources; nothing is signed until a certificate is chosen.
- macOS: dmg for arm64, with an ad-hoc signature of the whole bundle until a Developer ID is chosen (`macIdentity`). Setting the fuses changes the Electron Framework binary; on Apple silicon macOS stops a program whose signature no longer matches it (SIGKILL at start), so an unsigned bundle does not run. The ad-hoc signature also gives the bundle its id (`to.memex.<app>`). The hardened runtime is always on, so dyld ignores `DYLD_INSERT_LIBRARIES` and the other `DYLD_*` variables. Its entitlements (`assets/entitlements.mac*.plist`) allow only the JIT that V8 needs; an ad-hoc build also turns library validation off, because an ad-hoc signature has no team id and library validation would refuse the app's own Electron Framework. Linux: AppImage and deb for x64, named `linux-x64`. The deb needs `homepage` and `maintainer` ("Name <email>") in the builder options.
- Installers are named `<Product.With.Dots>-<version>-<windows|macos|linux>-<arch>.<ext>`.
- Fuses: no `NODE_OPTIONS`, no inspect arguments, cookie encryption, asar integrity, app only from asar, no extra file-protocol privileges; run-as-node on for the CLI shim.
- Cookie encryption on macOS keeps its key in the login keychain: the generic password with service `<Product> Safe Storage` and account `<Product> Key` (on macOS the shell gives the app its product name, so the item and the macOS question name the product, not the npm package). The token cookie is a session cookie and never reaches the disk; cookies that last (an app's settings) are stored encrypted (`v10`). On macOS the shell checks the key before it sets the token cookie (`safeStorage` encrypts and decrypts a short text), so the first start creates the key, and a keychain that refuses shows the crash screen with the reason and a Restart button. The process keeps the keychain's answer, so after a refusal Restart starts the app again in a new process, which asks the keychain again; after a timeout Restart starts only the server again, because the question may still be open. When macOS asks the person (a locked keychain, or a build it does not know yet), the app shows its starting page until the answer, and the crash screen after `cookieTimeoutMs` (60 seconds) without one. Checked on a Mac (macOS 27): the first start of a fresh install created the item without a question; a start where the keychain could not ask (outside the logged-in session) showed the crash screen.
- An ad-hoc signature has no team id, so the keychain records the item's partition as the build's code hash (`cdhash:<hash>`). Measured on 26 October: the first start of an update (0.1.0, then 0.1.1 with the same data) made macOS ask before the new build could use its key, and the securityd log named the code hash ("ACL partition mismatch: client cdhash:..."), so a designated requirement cannot avoid the question. Expected, not yet measured: that "Always Allow" adds that build so that its next start does not ask, and that a Developer ID build records `teamid:<id>` and keeps its key across updates without a question. The Restart after a refusal in a new process is also not yet measured with a person who presses Deny.
- The first window of a start comes to the front (`app.focus({ steal: true })` on macOS): macOS activates an app that the person opens from the Dock or Finder, but not one opened by a program that is not itself active, such as a script or the CLI's `open`.

## Shared services

Every Memex app installer carries Memex.Node and Memex.User, and the app starts them with `ensureNode` (`@tjalve/memex-node-client`) and `ensureUser` (`@tjalve/memex-user-client`). The rules are in contracts/surfaces.md (Service launcher, Installers).

1. Package each service for each target in its own repository: `node tools/package.mjs --target <target> --out <dir>` in memex.node, `node scripts/package.mjs --target <target> --out <dir>` in memex.user. Each writes `memex-<service>-<version>-<target>.tar.gz` and a `.json` record with its SHA-256. A macOS copy is made on a Mac.
2. Pin them: `memex-desktop services pin --from <dir> --pins services.json` checks each archive and writes or extends `services.json` (`memex.services/1`), one archive and SHA-256 for each service and target. The app keeps `services.json` in its repository.
3. Name them in the pack config: `services: { pins: "services.json", from: "<dir with the archives>" }`. `pack` checks each archive of the build's target (`win-x64`, `osx-arm64`, `linux-x64`) against its pin, unpacks it, checks its `service.json` and that it has no links, and packs it as `<resources>/services/<service>/<version>/` with `<resources>/services/services.json`. A missing pin or archive, or another SHA-256, stops the pack.

| Where | What happens |
|---|---|
| Windows install | The NSIS hook (`assets/installer.nsh`) runs `"<program>" --memex-services=install`: the shell copies the services into `%LOCALAPPDATA%\Programs\Memex\Services` (or `MEMEX_SERVICES_DIR`), lists the app in `clients/<app>.json`, and exits. It shows no window. A failure does not stop the install. |
| Every start | Before the server starts, the shell installs the carried versions that are missing (the same step), so a dmg app, an AppImage or a failed installer hook gets them too. The log says what it did (`services:` lines in `desktop.log`); a failure is logged and the app starts anyway. |
| Copy | Under `services.lock`: into `.partial-<version>-<random>`, each file checked against its source by SHA-256, then renamed into place. A version is not copied when two newer ones are installed. The two newest versions of each service stay; older ones are removed unless they run. |
| Windows uninstall | The NSIS hook runs `--memex-services=uninstall` before the files go (not on an update): the app's client entry goes. When no other app is a client, each service that runs from the folder gets `POST /v1/drain`, the shell waits for it to stop (at most 70 s), and removes the service folders and the services folder. |
| macOS | A dmg has no installer: the first start installs the services into `~/Library/Application Support/Memex/Services`. The dmg window has a note, `About Memex services.txt`: the services hold programs only, an app is removed with the Trash, and after the last app the services folder can go too. The next start of another Memex app removes the client entry of an app whose program is gone. |

The services folder must be outside `~/Memex` (`MEMEX_HOME`) and the pack store; the shell refuses another one, and it never removes anything outside the services folder. The first install writes the marker `memex-services.json` (`memex.services-folder/1`) into a new or empty folder; a folder that holds other files and has no marker is refused, and an uninstaller changes nothing in it. In the services folder, a folder counts as a service only when it holds nothing but version folders with a `service.json` for that service; anything else stays as it is, and the folder itself stays when it holds anything other than services.

Signing: `services.sign` in the pack config names a module whose default export gets the staged copies (`{ services: [{ app, version, folder, command }], target, platform }`) before electron-builder runs, for example to sign the Windows programs with the app's certificate. Without it nothing is signed on Windows and Linux. On macOS electron-builder signs every program in the bundle, the services too, with the app's identity (ad hoc until a Developer ID is chosen) and the hardened runtime.

`memex-desktop services status` shows the installed versions and the clients; `memex-desktop services stage` unpacks the pinned archives as `pack` does.

## Updates

An app updates itself from the releases of its own repository. Two settings turn it on:

```js
// main.mjs
startDesktopApp({ /* ... */, updates: { provider: "github", owner: "ZarK", repo: "memex.photos" } });
```

```js
// memex-desktop.config.mjs
export default { builder: { /* ... */, updates: { owner: "ZarK", repo: "memex.photos" } } };
```

| Part | How |
|---|---|
| Check | 30 seconds after the app starts, then every 6 hours. Help > Check for Updates (the app menu on macOS) checks at once. One check runs at a time. |
| Channels | `latest` follows stable releases. `beta` also follows release candidates (`v1.0.0-rc.2`). A version with a prerelease part starts on `beta`, any other version on `latest`. The person can change it in the menu (Beta Channel). On `beta` the shell looks for a stable release first and then for a release candidate, so rc.1 goes to rc.2, and rc.2 goes to 1.0.0. |
| Download | In the background, when a check finds a newer version. The installer is checked against the sha512 in the update file. The shell never goes back to an older version. |
| Install | When the app quits (`autoInstallOnAppQuit`), silently. The menu item "Restart to Update to <version>" does it at once and starts the app again. |
| Off switch | Menu: Update Automatically. The choice is kept in `<state>/updates.json` (`memex.updates/1`). Off means no new checks and no install on quit; a download that already runs may finish, and a downloaded update waits until updates are on. `MEMEX_DESKTOP_UPDATES=off` turns updates off for one run. |
| Where it runs | Only an installed app: Windows (NSIS) and Linux (AppImage). A deb is updated with the package manager. An unsigned macOS build cannot install updates; that comes with the Developer ID. An app in smoke-test mode never updates. The log says why updates are not available (`updates:` lines in `desktop.log`). |
| Failure | A failed check or download is logged and shown as the state `error`. The app runs as before and tries again at the next check. |

The build writes the files that the installed app reads. With `builder.updates` electron-builder writes `app-update.yml` into the app and, for each release, `latest.yml` (`rc.yml` for a release candidate, `latest-linux.yml` and `rc-linux.yml` on Linux) and a blockmap for each installer. `memex-desktop pack` checks that the update file is there, is for the build's version, and lists only files of the release with the sha512 that the files have. It writes the names of the files to publish in `UPDATE-FILES.txt`, and the release workflow puts them on the release beside the installers.

The repository must be public: the installed app reads the release without a token. Until then the check fails with a 404 and the app runs as before. No update is signed yet, so the sha512 in the update file (from the release page, over https) is the only check on an installer until Windows signing and the macOS Developer ID are there. The update files are not in `SHA256SUMS.txt` and have no attestation; they carry the sha512 of the installers. `MEMEX_HELLO_UPDATE_FEED` is for the example only: an app must not read its feed from the environment, because any program of the account could then point it at its own installer.

To try it without a release, run an app against a folder that holds `latest.yml` and the installer: the app's code passes `updates: { provider: "generic", url: "http://127.0.0.1:<port>/" }`. [`examples/hello`](examples/hello) does this with `MEMEX_HELLO_UPDATE_FEED`. The tests of this package run the real electron-updater against a local server that answers as GitHub does.

## Example

[`examples/hello`](examples/hello) is the smallest app on the shell: a `@tjalve/memex-surfaces` server with one capability and a page that makes a cookie request and a cookie write, the CLI, and the pack config.

```bash
pnpm install && pnpm build
cd packages/desktop/examples/hello
node ../../dist/bin.js fetch-electron
node ../../dist/bin.js icons icon.svg icons
node ../../../licenses/dist/bin.js notices --out build/notices --repo ../../../.. --importer packages/desktop/examples/hello --electron-dist node_modules/electron/dist --product "Memex Hello"
node_modules/electron/dist/electron .          # run it
node ../../dist/bin.js pack                     # release/Memex.Hello-0.1.0-windows-x64.exe and SHA256SUMS.txt
```

With `MEMEX_HELLO_SERVICES=<dir>` (the archives and their `services.json`) the build carries Memex.Node and Memex.User, and its page shows what `ensureNode` and `ensureUser` did; `MEMEX_HELLO_VARIANT=two` packs Memex Hello Two, a second app for trying the shared services. `MEMEX_HELLO_ROOT` moves its folders, `MEMEX_HELLO_SERVER=exec` runs the server as a program instead of a utility process, and `MEMEX_HELLO_PROOF=<folder>` records the shell's events and a picture and the text of each screen.
