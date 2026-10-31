import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserWindow, Menu, app, dialog, ipcMain, protocol, safeStorage, session, shell, type MenuItemConstructorOptions } from "electron";
import { currentMemexPaths, electronPaths, isAppId, markCacheFolder } from "@tjalve/memex-storage";
import { desktopProgram } from "./cli-shim.js";
import { checkSafeStorage, cookieKeyFailureNeedsNewProcess, setTokenCookie, tokenCookieDetails } from "./cookie.js";
import { assertOutsideInstall, packagedInstallDirectory, type ShellPaths } from "./home.js";
import {
  ABOUT_URL,
  CRASH_URL,
  SHELL_CSP,
  SHELL_SCHEME,
  STARTING_URL,
  aboutPageHtml,
  crashPageHtml,
  parseNotices,
  startingPageHtml,
  type AboutInfo,
  type NoticesFile,
} from "./pages.js";
import { isAllowedAppUrl, isAllowedExternalUrl, type ReadyAnnouncement } from "./ready-line.js";
import { installServices, servicesAction, uninstallServices, type InstallServicesResult, type UninstallServicesResult } from "./services.js";
import { DESKTOP_ENV } from "./server.js";
import { UpdateController, parseUpdateFeed, updateSupport, type UpdateFeed, type UpdateSettings, type UpdateState, type UpdaterLike } from "./updates.js";
import { SMOKE_EXPECT_ENV, createSmokeRecorder, pageOutcome, smokeFolder, type SmokeOutcome, type SmokeRecorder } from "./smoke.js";
import { startServer, type RunningServer, type ServerSpec } from "./spawn.js";

export interface ShellContext {
  packaged: boolean;
  /** process.resourcesPath when packaged. */
  resourcesPath: string;
  /** app.getAppPath(): the app folder, or app.asar when packaged. */
  appPath: string;
  paths: ShellPaths;
}

export type ShellEvent =
  | { type: "single-instance-refused" }
  | { type: "second-instance"; argv: string[] }
  | { type: "server-ready"; announcement: ReadyAnnouncement; pid: number | undefined }
  | { type: "safe-storage-ready" }
  | { type: "relaunch-requested" }
  | { type: "page-loaded"; url: string; status: number | null; window: BrowserWindow }
  | { type: "window-shown"; window: BrowserWindow }
  | { type: "server-exit"; code: number | null; expected: boolean }
  | { type: "crash-screen"; reason: string; code: number | null | undefined; window: BrowserWindow }
  | { type: "about-shown"; window: BrowserWindow; components: number }
  | { type: "navigation-refused"; url: string; external: boolean }
  | { type: "window-open-refused"; url: string; external: boolean }
  | { type: "permission-refused"; permission: string }
  | { type: "notices-opened"; folder: string; ok: boolean }
  | { type: "services-installed"; result: InstallServicesResult | null }
  | { type: "services-failed"; error: string }
  | { type: "update-state"; state: UpdateState; settings: UpdateSettings }
  | { type: "updates-unavailable"; reason: string }
  | { type: "quit-requested"; from: "crash-screen" | "menu" | "api" };

export interface DesktopAppOptions {
  /** The app id: photos, study, finance, ... It names the cookie (memex_<app>_token) and the ready line's app. */
  app: string;
  /** The display name, for example "Memex Photos". */
  productName: string;
  /** The app's folders. Defaults to currentMemexPaths(app) of @tjalve/memex-storage for a Memex app id. */
  paths?: ShellPaths;
  /** The local server: a JavaScript entry (node) or a program (exec). */
  server: ServerSpec | ((context: ShellContext) => ServerSpec);
  /** More variables for the server. */
  env?: Record<string, string>;
  window?: { width?: number; height?: number; minWidth?: number; minHeight?: number; backgroundColor?: string };
  /** The window icon (a .png, or an .ico on Windows). */
  icon?: string;
  /** The app's own license, for About (an SPDX id). */
  license?: string;
  copyright?: string;
  /** An https URL, for About. */
  homepage?: string;
  /** notices.json from @tjalve/memex-licenses. Defaults to <resources>/notices/notices.json when packaged. */
  notices?: string;
  /** How long the server may take to write its ready line. Defaults to 60 seconds. */
  readyTimeoutMs?: number;
  /**
   * How long the cookie key and the token cookie may take before the crash screen shows. Defaults to 60 seconds. On
   * macOS the first start creates the app's key in the login keychain ("<Product> Safe Storage"); when the keychain is
   * locked, macOS asks for its password first, and when access is denied or nobody answers, the crash screen shows.
   */
  cookieTimeoutMs?: number;
  /** Permissions the pages may have (for example "clipboard-sanitized-write"). Every other request is denied. */
  permissions?: string[];
  /** Each thing the shell does, for the app's own logging. */
  onEvent?: (event: ShellEvent) => void;
  /** Opens an https link in the user's browser. Defaults to Electron's shell.openExternal; a smoke test may record instead. */
  openExternal?: (url: string) => Promise<void>;
  /** Opens a folder in the file manager; resolves with an error message or "". Defaults to Electron's shell.openPath. */
  openPath?: (folder: string) => Promise<string>;
  /**
   * The shared services (Memex.Node, Memex.User) that the build carries in <resources>/services: each start installs
   * them into the services folder before the server starts, so that ensureNode and ensureUser find them. Default: on
   * when packaged and the build carries services. false turns it off; resources names another folder (an unpackaged run).
   */
  services?: false | { resources: string };
  /**
   * Where the app's releases are, for example { provider: "github", owner: "ZarK", repo: "memex.photos" }. The shell
   * checks when the app starts and every 6 hours, downloads an update in the background and installs it when the app
   * quits. Help > Check for Updates, the "Update Automatically" switch and the Beta Channel are in the menu. Default:
   * no updates. Updates run only in an installed app: Windows, and Linux as an AppImage.
   */
  updates?: false | UpdateFeed;
}

export interface DesktopShell {
  readonly window: BrowserWindow | null;
  readonly server: RunningServer | null;
  readonly logFile: string;
  /** Stops the server if it runs, starts it again and loads the app. */
  restart(): Promise<void>;
  showAbout(): BrowserWindow;
  quit(): void;
  /** The update controller, or null when the app has no updates (not installed, no feed, off for this build). */
  readonly updates: UpdateController | null;
}

const PRELOAD = fileURLToPath(new URL("../assets/shell-preload.cjs", import.meta.url));
const LOG_LIMIT = 5 * 1024 * 1024;

function resolvePaths(options: DesktopAppOptions): ShellPaths {
  if (options.paths) return options.paths;
  if (!isAppId(options.app)) throw new Error(`${options.app} is not a Memex app id; pass paths.`);
  const p = currentMemexPaths(options.app);
  return { data: p.data, cache: p.cache, logs: p.logs, state: p.state };
}

function openLog(logs: string): (line: string) => void {
  const file = path.join(logs, "desktop.log");
  try {
    if (statSync(file).size > LOG_LIMIT) renameSync(file, path.join(logs, "desktop.1.log"));
  } catch {
    // no log yet
  }
  return (line: string) => {
    const text = `${new Date().toISOString()} [${process.pid}] ${line}\n`;
    try {
      appendFileSync(file, text);
    } catch {
      // the log is best effort
    }
    if (!app.isPackaged) process.stdout.write(text);
  };
}

function fail(productName: string, error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  dialog.showErrorBox(`${productName} cannot start`, message);
  app.exit(1);
  throw error instanceof Error ? error : new Error(message);
}

/**
 * Starts a Memex desktop app. Call it at the top of the main module, before the app is ready. Returns null in a
 * second instance: that one focuses the first one's window and quits.
 */
export function startDesktopApp(options: DesktopAppOptions): DesktopShell | null {
  const { productName } = options;
  // The installer hooks run the app's program with --memex-services=install or --memex-services=uninstall: the shell
  // does only that, with no window and no single-instance lock, and exits with 0 or 1.
  const hook = servicesAction(process.argv);
  if (hook) {
    runServicesHook(options, hook);
    return null;
  }
  // Electron names the app after package.json (its productName, else its name, such as "memex-photos"). The name is
  // shown in menus and names the cookie key in the macOS login keychain ("<name> Safe Storage"), which macOS shows when
  // it asks the person about the key, so the app takes its product name there. Windows and Linux keep the name they
  // were proven with (on Linux it names the libsecret entry of the cookie key and the window class).
  if (process.platform === "darwin" && app.getName() !== productName) app.setName(productName);
  const packaged = app.isPackaged;
  let paths: ShellPaths;
  let electron: ReturnType<typeof electronPaths>;
  let smoke: SmokeRecorder | null = null;
  try {
    const smokeAt = smokeFolder();
    if (smokeAt) {
      smoke = createSmokeRecorder(smokeAt, {
        app: options.app,
        productName,
        version: app.getVersion(),
        platform: process.platform,
        arch: process.arch,
        electron: process.versions.electron ?? "",
      }, { expect: process.env[SMOKE_EXPECT_ENV] || undefined });
    }
    paths = resolvePaths(options);
    assertOutsideInstall(paths, packagedInstallDirectory({ packaged, exePath: app.getPath("exe") }));
    electron = electronPaths(paths);
    for (const dir of [electron.userData, electron.logs, electron.crashDumps, electron.diskCache]) mkdirSync(dir, { recursive: true });
  } catch (error) {
    return fail(productName, error);
  }
  const log = openLog(paths.logs);
  // storage.md: apps mark their cache folder at start-up, so that backup tools and indexers leave it out.
  markCacheFolder(paths.cache).catch((error: unknown) => log(`The cache folder could not be marked: ${error instanceof Error ? error.message : String(error)}`));
  const logFile = path.join(paths.logs, "desktop.log");
  const emit = (event: ShellEvent) => {
    if (smoke) smokeStep(smoke, event);
    try {
      options.onEvent?.(event);
    } catch (error) {
      log(`onEvent failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  // Smoke-test mode (MEMEX_DESKTOP_SMOKE): the first app page or the crash screen ends the run.
  const smokeStep = (recorder: SmokeRecorder, event: ShellEvent) => {
    recorder.event(event as { type: string } & Record<string, unknown>);
    let outcome: SmokeOutcome | null = null;
    if (event.type === "page-loaded" && port !== null && isAllowedAppUrl(event.url, port)) outcome = pageOutcome(event.status);
    else if (event.type === "crash-screen") outcome = { ok: false, reason: event.reason };
    else if (event.type === "single-instance-refused") outcome = { ok: false, reason: "Another instance of the app runs." };
    if (!outcome) return;
    const win = "window" in event ? event.window : null;
    void recorder.finish(win, outcome).then((result) => {
      log(`Smoke test ${result?.ok ? "passed" : "failed"}; the results are in ${recorder.folder}. Quitting.`);
      app.quit();
    });
  };

  // The single-instance lock lives in userData, so userData is set first.
  app.setPath("userData", electron.userData);
  app.setPath("sessionData", electron.sessionData);
  app.setPath("logs", electron.logs);
  app.setPath("crashDumps", electron.crashDumps);

  if (!app.requestSingleInstanceLock()) {
    log("Another instance runs; this one hands over and quits.");
    emit({ type: "single-instance-refused" });
    app.quit();
    return null;
  }

  // After the lock: a second instance must not open the first one's disk cache.
  app.commandLine.appendSwitch("disk-cache-dir", electron.diskCache);
  protocol.registerSchemesAsPrivileged([{ scheme: SHELL_SCHEME, privileges: { standard: true, secure: true } }]);
  app.enableSandbox();

  const context = (): ShellContext => ({ packaged, resourcesPath: process.resourcesPath, appPath: app.getAppPath(), paths });
  const tokenFile = path.join(paths.state, "token");
  const noticesFile = options.notices ?? (packaged ? path.join(process.resourcesPath, "notices", "notices.json") : undefined);
  const allowed = new Set(options.permissions ?? []);
  const openExternal = options.openExternal ?? ((url: string) => shell.openExternal(url));
  const openPath = options.openPath ?? ((folder: string) => shell.openPath(folder));

  let mainWindow: BrowserWindow | null = null;
  let aboutWindow: BrowserWindow | null = null;
  let server: RunningServer | null = null;
  let port: number | null = null;
  let crashHtml = "";
  let aboutHtml = "";
  let shuttingDown = false;
  let quitReady = false;
  let launching: Promise<void> | null = null;
  let safeStorageChecked = false;
  let relaunchOnRestart = false;
  let firstShow = true;
  let updates: UpdateController | null = null;

  const focus = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  };

  app.on("second-instance", (_event, argv) => {
    log("A second instance started; focusing this window.");
    emit({ type: "second-instance", argv });
    focus();
    // macOS brings a window of an app that is not active only to the front of that app; the person started the app
    // again, so it becomes the active app. (Opened through LaunchServices, macOS activates it before "activate".)
    if (process.platform === "darwin") app.focus({ steal: true });
  });

  // Every page: no new windows (https links open in the browser), no navigation away from the app's own server,
  // no webview. The shell's own pages are loaded by the main process, which these checks do not stop.
  app.on("web-contents-created", (_event, contents) => {
    const external = (url: string): boolean => {
      if (!isAllowedExternalUrl(url)) return false;
      openExternal(url).catch((error: unknown) => log(`The link did not open: ${error instanceof Error ? error.message : String(error)}`));
      return true;
    };
    contents.setWindowOpenHandler(({ url }) => {
      const opened = external(url);
      log(`A new window was refused${opened ? "; the link opens in the browser" : ""}: ${url}`);
      emit({ type: "window-open-refused", url, external: opened });
      return { action: "deny" };
    });
    const guard = (event: { preventDefault(): void }, url: string) => {
      if (port !== null && isAllowedAppUrl(url, port)) return;
      event.preventDefault();
      const opened = external(url);
      log(`A navigation away from the app was refused${opened ? "; the link opens in the browser" : ""}: ${url}`);
      emit({ type: "navigation-refused", url, external: opened });
    };
    contents.on("will-navigate", guard);
    contents.on("will-redirect", guard);
    contents.on("will-attach-webview", (event) => event.preventDefault());
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("activate", () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      mainWindow = createMainWindow();
      if (port !== null && server && !server.exited) void loadApp();
      else void mainWindow.loadURL(crashHtml ? CRASH_URL : STARTING_URL);
    } else focus();
  });

  app.on("before-quit", (event) => {
    shuttingDown = true;
    if (quitReady || !server || server.exited) return;
    event.preventDefault();
    const running = server;
    log("Stopping the server.");
    void running.stop().finally(() => {
      quitReady = true;
      app.quit();
    });
  });

  const isShellPage = (url: string | undefined) => typeof url === "string" && url.startsWith(`${SHELL_SCHEME}://app/`);

  function createMainWindow(): BrowserWindow {
    const w = options.window ?? {};
    const win = new BrowserWindow({
      width: w.width ?? 1280,
      height: w.height ?? 800,
      minWidth: w.minWidth ?? 360,
      minHeight: w.minHeight ?? 480,
      show: false,
      title: productName,
      autoHideMenuBar: true,
      backgroundColor: w.backgroundColor ?? "#f6f3ec",
      icon: options.icon,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false, preload: PRELOAD, spellcheck: false },
    });
    win.once("ready-to-show", () => {
      win.show();
      // macOS activates an app that the person opens from the Dock or Finder, but not one opened by another program
      // that is not active itself (a script, a terminal in the background, the CLI's open). The first window of a
      // start comes to the front, as the person asked for the app.
      if (firstShow && process.platform === "darwin") app.focus({ steal: true });
      firstShow = false;
      log("The window is shown.");
      emit({ type: "window-shown", window: win });
    });
    // The HTTP status of the page in the window (did-navigate is for the main frame only); -1 or 0 is no HTTP answer.
    let status: number | null = null;
    win.webContents.on("did-navigate", (_event, _url, httpResponseCode) => {
      status = httpResponseCode > 0 ? httpResponseCode : null;
    });
    win.webContents.on("did-finish-load", () => {
      const url = win.webContents.getURL();
      emit({ type: "page-loaded", url, status, window: win });
    });
    win.webContents.on("render-process-gone", (_event, details) => {
      if (details.reason === "clean-exit") return;
      log(`The window's page stopped: ${details.reason}.`);
      void showCrash(`The window stopped (${details.reason}).`, details.exitCode, server?.tail() ?? []);
    });
    win.on("closed", () => {
      if (mainWindow === win) mainWindow = null;
    });
    return win;
  }

  async function showCrash(reason: string, code: number | null | undefined, output: string[]): Promise<void> {
    port = null;
    crashHtml = crashPageHtml({ productName, reason, code, output, logFile });
    log(`Crash screen: ${reason}${code === undefined || code === null ? "" : ` (exit code ${code})`}`);
    if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createMainWindow();
    const win = mainWindow;
    await win.loadURL(CRASH_URL).catch((error: unknown) => log(`The crash screen did not load: ${String(error)}`));
    if (!win.isVisible()) win.show();
    emit({ type: "crash-screen", reason, code, window: win });
  }

  async function loadApp(): Promise<void> {
    if (!mainWindow || mainWindow.isDestroyed() || port === null) return;
    await mainWindow.loadURL(`http://127.0.0.1:${port}/`);
  }

  function serverEnv(): Record<string, string | undefined> {
    const program = desktopProgram({ app: options.app, packaged, exePath: app.getPath("exe"), resourcesPath: process.resourcesPath });
    return {
      ...process.env,
      ...options.env,
      [DESKTOP_ENV.executable]: program.executable,
      [DESKTOP_ENV.cli]: program.cli ?? "",
    };
  }

  async function launch(): Promise<void> {
    if (shuttingDown) return;
    const spec = typeof options.server === "function" ? options.server(context()) : options.server;
    log(`Starting the ${spec.kind} server.`);
    const running = startServer(spec, {
      app: options.app,
      tokenFile,
      env: serverEnv(),
      readyTimeoutMs: options.readyTimeoutMs ?? 60_000,
      onOutput: (stream, line) => log(`server ${stream}: ${line}`),
    });
    server = running;
    running.onExit((raw) => {
      // Windows reports a process ended by TerminateProcess(-1) as 4294967295.
      const code = raw !== null && raw > 0x7fffffff ? raw - 0x100000000 : raw;
      const expected = shuttingDown || server !== running;
      log(`The server exited with code ${code ?? "unknown"}${expected ? "" : " unexpectedly"}.`);
      emit({ type: "server-exit", code, expected });
      if (expected) return;
      if (port !== null) void showCrash(`The ${productName} server stopped.`, code, running.tail());
    });
    let ready;
    try {
      ready = await running.ready;
    } catch (error) {
      if (shuttingDown || server !== running) return;
      await showCrash(error instanceof Error ? error.message : String(error), undefined, running.tail());
      return;
    }
    if (server !== running || running.exited) return;
    const { announcement, token } = ready;
    log(`The server is ready at ${announcement.url} (process ${running.pid ?? "unknown"}).`);
    emit({ type: "server-ready", announcement, pid: running.pid });
    if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createMainWindow();
    const session = mainWindow.webContents.session;
    if (process.platform === "darwin" && !safeStorageChecked) {
      try {
        await checkSafeStorage(safeStorage, productName, options.cookieTimeoutMs ?? 60_000);
        safeStorageChecked = true;
        log(`The cookie key in the login keychain ("${productName} Safe Storage") works.`);
        emit({ type: "safe-storage-ready" });
      } catch (error) {
        if (shuttingDown || server !== running) return;
        relaunchOnRestart = cookieKeyFailureNeedsNewProcess(error);
        log(`The cookie key is not usable: ${error instanceof Error ? error.message : String(error)}`);
        await showCrash(error instanceof Error ? error.message : String(error), undefined, running.tail());
        return;
      }
    }
    try {
      await setTokenCookie(() => session.cookies.set(tokenCookieDetails(options.app, announcement.url, token)), options.cookieTimeoutMs ?? 60_000);
    } catch (error) {
      if (shuttingDown || server !== running) return;
      log(`The token cookie was not stored: ${error instanceof Error ? error.message : String(error)}`);
      await showCrash(error instanceof Error ? error.message : String(error), undefined, running.tail());
      return;
    }
    port = announcement.port;
    try {
      await loadApp();
    } catch (error) {
      if (port !== null) await showCrash(`The app page did not load: ${error instanceof Error ? error.message : String(error)}`, undefined, running.tail());
    }
  }

  async function restart(): Promise<void> {
    if (launching) return launching;
    if (relaunchOnRestart) {
      // This process keeps the refused keychain answer, so only a new process asks the keychain again.
      log("Restarting the app in a new process, because this process keeps the refused cookie key.");
      emit({ type: "relaunch-requested" });
      app.relaunch();
      app.quit();
      return;
    }
    launching = (async () => {
      const previous = server;
      server = null;
      port = null;
      crashHtml = "";
      if (previous && !previous.exited) {
        log("Stopping the server for a restart.");
        await previous.stop();
      }
      if (mainWindow && !mainWindow.isDestroyed()) await mainWindow.loadURL(STARTING_URL).catch(() => undefined);
      try {
        await launch();
      } catch (error) {
        if (shuttingDown) return;
        log(`Restart failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
        await showCrash(error instanceof Error ? error.message : String(error), undefined, (server as RunningServer | null)?.tail() ?? []);
      }
    })().finally(() => {
      launching = null;
    });
    return launching;
  }

  function readAbout(): AboutInfo {
    let notices: NoticesFile | null = null;
    let noticesError: string | undefined;
    if (!noticesFile) noticesError = "This copy has no notices.json.";
    else {
      try {
        notices = parseNotices(readFileSync(noticesFile, "utf8"));
      } catch (error) {
        noticesError = `The notices could not be read: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    return {
      productName,
      version: app.getVersion(),
      license: options.license,
      copyright: options.copyright,
      homepage: options.homepage,
      runtime: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node },
      notices,
      noticesError,
      canOpenNotices: notices !== null,
    };
  }

  function showAbout(): BrowserWindow {
    if (aboutWindow && !aboutWindow.isDestroyed()) {
      aboutWindow.focus();
      return aboutWindow;
    }
    const info = readAbout();
    aboutHtml = aboutPageHtml(info);
    const win = new BrowserWindow({
      width: 640,
      height: 720,
      title: `About ${productName}`,
      parent: mainWindow ?? undefined,
      autoHideMenuBar: true,
      show: false,
      icon: options.icon,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false, preload: PRELOAD, spellcheck: false },
    });
    win.setMenu(null);
    win.once("ready-to-show", () => {
      win.show();
      emit({ type: "about-shown", window: win, components: info.notices?.components.length ?? 0 });
    });
    win.on("closed", () => {
      if (aboutWindow === win) aboutWindow = null;
    });
    aboutWindow = win;
    void win.loadURL(ABOUT_URL);
    return win;
  }

  function requestQuit(from: "crash-screen" | "menu" | "api"): void {
    log(`Quit requested (${from}).`);
    emit({ type: "quit-requested", from });
    app.quit();
  }

  function updatesMenu(): MenuItemConstructorOptions[] {
    const controller = updates;
    if (!controller) return [];
    const state = controller.state;
    const settings = controller.settings;
    const check: MenuItemConstructorOptions =
      state.status === "ready"
        ? { label: `Restart to Update to ${state.version}`, click: () => void controller.installNow() }
        : {
            label: state.status === "checking" ? "Checking for Updates..." : state.status === "downloading" ? `Downloading ${state.version}...` : "Check for Updates",
            enabled: settings.enabled && state.status !== "checking" && state.status !== "downloading",
            click: () => void controller.checkNow(),
          };
    return [
      { type: "separator" },
      check,
      { label: "Update Automatically", type: "checkbox", checked: settings.enabled, click: (item) => controller.setEnabled(item.checked) },
      { label: "Beta Channel", type: "checkbox", checked: settings.channel === "beta", click: (item) => controller.setChannel(item.checked ? "beta" : "latest") },
    ];
  }

  // Updates: a controller on electron-updater, only in an installed app that has a feed. A failure is logged and the
  // app runs as it did.
  async function startUpdates(): Promise<void> {
    if (!options.updates) return;
    const support = updateSupport({ platform: process.platform, env: process.env, packaged });
    if (!support.supported) {
      log(`Updates are not available: ${support.reason}`);
      emit({ type: "updates-unavailable", reason: support.reason ?? "" });
      return;
    }
    try {
      const feed = parseUpdateFeed(options.updates);
      const module = (await import("electron-updater")) as { autoUpdater?: UpdaterLike; default?: { autoUpdater?: UpdaterLike } };
      const updater = module.autoUpdater ?? module.default?.autoUpdater;
      if (!updater) throw new Error("electron-updater has no autoUpdater.");
      updates = new UpdateController({
        updater,
        feed,
        version: app.getVersion(),
        settingsFile: path.join(paths.state, "updates.json"),
        log: (line) => log(`updates: ${line}`),
        onState: (state, settings) => {
          emit({ type: "update-state", state, settings });
          buildMenu();
        },
      });
      updates.start();
      buildMenu();
      log(`Updates are on the ${updates.settings.channel} channel (${updates.settings.enabled ? "on" : "off"}).`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`Updates could not start: ${message}`);
      emit({ type: "updates-unavailable", reason: message });
    }
  }

  function buildMenu(): void {
    const about: MenuItemConstructorOptions = { label: `About ${productName}`, click: () => showAbout() };
    const updateItems = updatesMenu();
    const view: MenuItemConstructorOptions = {
      label: "View",
      submenu: [
        { role: "reload" },
        ...(packaged ? [] : [{ role: "toggleDevTools" } as MenuItemConstructorOptions]),
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    };
    const template: MenuItemConstructorOptions[] =
      process.platform === "darwin"
        ? [
            { label: productName, submenu: [about, ...updateItems, { type: "separator" }, { role: "hide" }, { role: "hideOthers" }, { role: "unhide" }, { type: "separator" }, { label: `Quit ${productName}`, accelerator: "Cmd+Q", click: () => requestQuit("menu") }] },
            { role: "editMenu" },
            view,
            { role: "windowMenu" },
          ]
        : [{ label: "File", submenu: [{ label: "Quit", accelerator: "Ctrl+Q", click: () => requestQuit("menu") }] }, { role: "editMenu" }, view, { label: "Help", submenu: [about, ...updateItems] }];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  }

  // The services the build carries go into the services folder before the server starts. A failure is logged, and the
  // app starts anyway: its own data never depends on them, and ensureNode or ensureUser says what is missing.
  async function ensureServices(): Promise<void> {
    if (options.services === false) return;
    const resources = options.services?.resources ?? (packaged ? process.resourcesPath : null);
    if (!resources) return;
    try {
      const result = await installServices({ resources, client: servicesClient(options), log: (line) => log(`services: ${line}`) });
      if (result) emit({ type: "services-installed", result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`services: the shared services could not be installed: ${message}`);
      emit({ type: "services-failed", error: message });
    }
  }

  async function ready(): Promise<void> {
    const ses = session.defaultSession;
    ses.setPermissionRequestHandler((_contents, permission, callback) => {
      const ok = allowed.has(permission);
      if (!ok) {
        log(`A page asked for the ${permission} permission; refused.`);
        emit({ type: "permission-refused", permission });
      }
      callback(ok);
    });
    ses.setPermissionCheckHandler((_contents, permission) => allowed.has(permission));
    ses.protocol.handle(SHELL_SCHEME, (request) => {
      const { pathname } = new URL(request.url);
      const html = pathname === "/crash" ? crashHtml : pathname === "/about" ? aboutHtml : pathname === "/starting" ? startingPageHtml(productName) : "";
      if (!html) return new Response("Not found", { status: 404 });
      return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": SHELL_CSP } });
    });
    ipcMain.handle("memex-shell:restart", (event) => {
      if (!isShellPage(event.senderFrame?.url) || event.sender !== mainWindow?.webContents) return false;
      void restart();
      return true;
    });
    ipcMain.handle("memex-shell:quit", (event) => {
      if (!isShellPage(event.senderFrame?.url)) return false;
      requestQuit("crash-screen");
      return true;
    });
    ipcMain.handle("memex-shell:open-notices", async (event) => {
      if (!isShellPage(event.senderFrame?.url) || !noticesFile) return false;
      const folder = path.dirname(noticesFile);
      const problem = await openPath(folder);
      log(problem ? `The notices folder ${folder} did not open: ${problem}` : `Opened the notices folder ${folder}.`);
      emit({ type: "notices-opened", folder, ok: problem === "" });
      return problem === "";
    });
    buildMenu();
    mainWindow = createMainWindow();
    await mainWindow.loadURL(STARTING_URL);
    await ensureServices();
    await launch();
    await startUpdates();
  }

  app.whenReady().then(ready).catch((error: unknown) => {
    log(`Start failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    void showCrash(error instanceof Error ? error.message : String(error), undefined, server?.tail() ?? []);
  });

  log(`${productName} ${app.getVersion()} starts (Electron ${process.versions.electron}, ${packaged ? "packaged" : "unpackaged"}).`);

  return {
    get window() {
      return mainWindow;
    },
    get server() {
      return server;
    },
    logFile,
    restart,
    showAbout,
    quit: () => requestQuit("api"),
    get updates() {
      return updates;
    },
  };
}

function servicesClient(options: DesktopAppOptions): { app: string; productName: string; version: string; program: string } {
  return { app: options.app, productName: options.productName, version: app.getVersion(), program: app.getPath("exe") };
}

/** --memex-services=install|uninstall from the installer: install or remove the shared services, log, and exit. */
function runServicesHook(options: DesktopAppOptions, action: "install" | "uninstall"): void {
  let log: (line: string) => void = () => {};
  try {
    const paths = resolvePaths(options);
    mkdirSync(paths.logs, { recursive: true });
    log = openLog(paths.logs);
  } catch {
    // without the app's folders there is no log
  }
  const resources = options.services === false ? null : (options.services?.resources ?? process.resourcesPath);
  const run = async (): Promise<InstallServicesResult | UninstallServicesResult | null> => {
    if (!resources) return null;
    if (action === "install") return installServices({ resources, client: servicesClient(options), log: (line) => log(`services (installer): ${line}`) });
    return uninstallServices({ app: options.app, log: (line) => log(`services (uninstaller): ${line}`) });
  };
  log(`${options.productName} ${app.getVersion()}: ${action} the shared services.`);
  run().then(
    (result) => {
      log(`services (${action}): ${JSON.stringify(result)}`);
      app.exit(0);
    },
    (error: unknown) => {
      log(`services (${action}) failed: ${error instanceof Error ? error.message : String(error)}`);
      app.exit(1);
    },
  );
}
