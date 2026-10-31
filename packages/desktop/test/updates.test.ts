import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import http, { createServer, type ClientRequest, type IncomingMessage, type RequestOptions, type Server } from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { UPDATES_ENV, UPDATE_SETTINGS_SCHEMA, UpdateController, channelOfVersion, parseUpdateFeed, readUpdateSettings, updateSupport, writeUpdateSettings, type UpdateState, type UpdaterLike } from "../src/updates.js";

const scratchDirs: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "memex-updates-"));
  scratchDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

describe("update feed and support", () => {
  it("tells the channel from the version", () => {
    expect(channelOfVersion("1.0.0")).toBe("latest");
    expect(channelOfVersion("1.0.0-rc.2")).toBe("beta");
    expect(channelOfVersion("0.1.0-beta.1")).toBe("beta");
  });

  it("checks a feed", () => {
    expect(parseUpdateFeed({ provider: "github", owner: "ZarK", repo: "memex.photos" })).toEqual({ provider: "github", owner: "ZarK", repo: "memex.photos" });
    expect(parseUpdateFeed({ provider: "github", owner: "ZarK", repo: "x", host: "127.0.0.1:8080", protocol: "http" })).toMatchObject({ host: "127.0.0.1:8080", protocol: "http" });
    expect(parseUpdateFeed({ provider: "generic", url: "https://example.com/updates/" })).toEqual({ provider: "generic", url: "https://example.com/updates/" });
    for (const bad of [null, {}, { provider: "s3" }, { provider: "github", owner: "a/b", repo: "x" }, { provider: "github", owner: "a", repo: "" }, { provider: "github", owner: "a", repo: "x", protocol: "ftp" }, { provider: "github", owner: "a", repo: "x", host: "h/evil" }, { provider: "generic", url: "file:///etc" }, { provider: "generic" }]) {
      expect(() => parseUpdateFeed(bad), JSON.stringify(bad)).toThrow();
    }
  });

  it("updates an installed Windows app and a Linux AppImage only", () => {
    const base = { packaged: true, env: {} as Record<string, string | undefined> };
    expect(updateSupport({ ...base, platform: "win32" }).supported).toBe(true);
    expect(updateSupport({ ...base, platform: "linux", env: { APPIMAGE: "/home/ada/Memex.AppImage" } }).supported).toBe(true);
    expect(updateSupport({ ...base, platform: "linux" })).toMatchObject({ supported: false, reason: expect.stringContaining("deb") });
    expect(updateSupport({ ...base, platform: "darwin" })).toMatchObject({ supported: false, reason: expect.stringContaining("macOS") });
    expect(updateSupport({ ...base, platform: "win32", packaged: false }).supported).toBe(false);
    expect(updateSupport({ ...base, platform: "win32", env: { [UPDATES_ENV]: "off" } }).supported).toBe(false);
    expect(updateSupport({ ...base, platform: "win32", env: { MEMEX_DESKTOP_SMOKE: "/tmp/smoke" } }).supported).toBe(false);
  });
});

describe("update settings", () => {
  it("starts on, on the channel of the version", () => {
    const file = path.join(scratch(), "updates.json");
    expect(readUpdateSettings(file, "1.0.0")).toEqual({ enabled: true, channel: "latest" });
    expect(readUpdateSettings(file, "1.0.0-rc.1")).toEqual({ enabled: true, channel: "beta" });
  });

  it("keeps what the person set, and ignores a file that is not ours", () => {
    const dir = scratch();
    const file = path.join(dir, "state", "updates.json");
    writeUpdateSettings(file, { enabled: false, channel: "beta" });
    expect(readUpdateSettings(file, "1.0.0")).toEqual({ enabled: false, channel: "beta" });
    expect(readdirSync(path.join(dir, "state"))).toEqual(["updates.json"]);
    const lines: string[] = [];
    writeFileSync(file, "{ not json");
    expect(readUpdateSettings(file, "1.0.0", (l) => lines.push(l))).toEqual({ enabled: true, channel: "latest" });
    writeFileSync(file, JSON.stringify({ schema: "other/1", enabled: false }));
    expect(readUpdateSettings(file, "1.0.0", (l) => lines.push(l))).toEqual({ enabled: true, channel: "latest" });
    writeFileSync(file, JSON.stringify({ schema: UPDATE_SETTINGS_SCHEMA, enabled: "no", channel: "nightly" }));
    expect(readUpdateSettings(file, "1.0.0")).toEqual({ enabled: true, channel: "latest" });
    expect(lines).toHaveLength(2);
  });
});

interface Call {
  allowPrerelease: boolean;
}

class FakeUpdater implements UpdaterLike {
  autoDownload = true;
  autoInstallOnAppQuit = false;
  allowPrerelease = false;
  allowDowngrade = true;
  feed: unknown = null;
  calls: Call[] = [];
  downloads = 0;
  installs: Array<[boolean | undefined, boolean | undefined]> = [];
  /** The answer for each pass: a version string for an update, null for none, an Error to fail. */
  answers: Array<string | null | Error> = [];
  gate: Promise<void> | null = null;
  setFeedURL(feed: unknown): void {
    this.feed = feed;
  }
  async checkForUpdates() {
    this.calls.push({ allowPrerelease: this.allowPrerelease });
    if (this.gate) await this.gate;
    const answer = this.answers.shift();
    if (answer instanceof Error) throw answer;
    if (answer === undefined || answer === null) return { isUpdateAvailable: false, updateInfo: { version: "0.0.0" } };
    return { isUpdateAvailable: true, updateInfo: { version: answer } };
  }
  async downloadUpdate() {
    this.downloads += 1;
  }
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean) {
    this.installs.push([isSilent, isForceRunAfter]);
  }
  on() {
    return this;
  }
}

function controller(version: string, extra: Partial<ConstructorParameters<typeof UpdateController>[0]> = {}) {
  const dir = scratch();
  const updater = new FakeUpdater();
  const timers: Array<{ callback: () => void; ms: number; cleared: boolean }> = [];
  const states: UpdateState[] = [];
  const logs: string[] = [];
  const c = new UpdateController({
    updater,
    feed: { provider: "github", owner: "ZarK", repo: "memex.photos" },
    version,
    settingsFile: path.join(dir, "updates.json"),
    log: (line) => logs.push(line),
    onState: (state) => states.push(state),
    setTimer: (callback, ms) => {
      // a timer that fired is spent, like a cleared one
      const timer = {
        callback: () => {
          timer.cleared = true;
          callback();
        },
        ms,
        cleared: false,
      };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      (timer as { cleared: boolean }).cleared = true;
    },
    now: () => new Date("2026-12-15T10:00:00Z"),
    ...extra,
  });
  const live = () => timers.filter((t) => !t.cleared);
  return { c, updater, timers, live, states, logs, dir, file: path.join(dir, "updates.json") };
}

describe("update controller", () => {
  it("sets the updater up: its own download step, install on quit, no downgrade, the feed", () => {
    const { updater } = controller("1.0.0");
    expect(updater.autoDownload).toBe(false);
    expect(updater.autoInstallOnAppQuit).toBe(true);
    expect(updater.allowDowngrade).toBe(false);
    expect(updater.feed).toEqual({ provider: "github", owner: "ZarK", repo: "memex.photos" });
  });

  it("checks soon after the start and then every 6 hours", async () => {
    const t = controller("1.0.0");
    t.c.start();
    expect(t.live().map((x) => x.ms)).toEqual([30_000]);
    t.live()[0]?.callback();
    await vi_flush();
    expect(t.updater.calls).toHaveLength(1);
    expect(t.live().map((x) => x.ms)).toEqual([6 * 60 * 60 * 1000]);
    t.live()[0]?.callback();
    await vi_flush();
    expect(t.updater.calls).toHaveLength(2);
    expect(t.live().map((x) => x.ms)).toEqual([6 * 60 * 60 * 1000]);
    t.c.stop();
    expect(t.live()).toHaveLength(0);
  });

  it("downloads an update and waits for the quit", async () => {
    const t = controller("0.1.0");
    t.updater.answers = ["0.1.1"];
    const state = await t.c.checkNow();
    expect(state).toEqual({ status: "ready", version: "0.1.1" });
    expect(t.updater.downloads).toBe(1);
    expect(t.states.map((s) => s.status)).toEqual(["checking", "downloading", "ready"]);
    expect(t.updater.autoInstallOnAppQuit).toBe(true);
    // a ready update is not downloaded twice
    expect(await t.c.checkNow()).toEqual({ status: "ready", version: "0.1.1" });
    expect(t.updater.calls).toHaveLength(1);
    let stopped = 0;
    const withHook = controller("0.1.0", { beforeInstall: async () => void (stopped += 1) });
    withHook.updater.answers = ["0.1.1"];
    await withHook.c.checkNow();
    expect(await withHook.c.installNow()).toBe(true);
    expect(stopped).toBe(1);
    expect(withHook.updater.installs).toEqual([[true, true]]);
    expect(await t.c.installNow()).toBe(true);
    expect(t.updater.installs).toEqual([[true, true]]);
  });

  it("looks only at stable releases on the latest channel", async () => {
    const t = controller("1.0.0");
    t.updater.answers = [null];
    expect(await t.c.checkNow()).toEqual({ status: "idle", checkedAt: "2026-12-15T10:00:00.000Z" });
    expect(t.updater.calls).toEqual([{ allowPrerelease: false }]);
  });

  it("looks at stable first and then at release candidates on the beta channel", async () => {
    const t = controller("1.0.0-rc.1");
    expect(t.c.settings.channel).toBe("beta");
    t.updater.answers = [null, "1.0.0-rc.2"];
    expect(await t.c.checkNow()).toEqual({ status: "ready", version: "1.0.0-rc.2" });
    expect(t.updater.calls).toEqual([{ allowPrerelease: false }, { allowPrerelease: true }]);
    // a stable release wins and the candidates are not asked
    const u = controller("1.0.0-rc.2");
    u.updater.answers = ["1.0.0"];
    expect(await u.c.checkNow()).toEqual({ status: "ready", version: "1.0.0" });
    expect(u.updater.calls).toEqual([{ allowPrerelease: false }]);
  });

  it("goes on to the release candidates when a repository has no stable release yet", async () => {
    const t = controller("1.0.0-rc.1");
    t.updater.answers = [new Error("Unable to find latest version on GitHub"), "1.0.0-rc.2"];
    expect(await t.c.checkNow()).toEqual({ status: "ready", version: "1.0.0-rc.2" });
    // on the latest channel the same failure is an error
    const u = controller("1.0.0");
    u.updater.answers = [new Error("Unable to find latest version on GitHub\nstack")];
    expect(await u.c.checkNow()).toEqual({ status: "error", message: "Unable to find latest version on GitHub", checkedAt: "2026-12-15T10:00:00.000Z" });
    // and a failure of the last pass is an error
    const v = controller("1.0.0-rc.1");
    v.updater.answers = [null, new Error("offline")];
    expect(await v.c.checkNow()).toMatchObject({ status: "error", message: "offline" });
  });

  it("runs one check at a time", async () => {
    const t = controller("1.0.0");
    let open!: () => void;
    t.updater.gate = new Promise<void>((resolve) => (open = resolve));
    const first = t.c.checkNow();
    const second = t.c.checkNow();
    open();
    await Promise.all([first, second]);
    expect(t.updater.calls).toHaveLength(1);
  });

  it("has an off switch that is kept, stops the schedule and stops the install on quit", async () => {
    const t = controller("1.0.0");
    t.c.start();
    t.c.setEnabled(false);
    expect(t.live()).toHaveLength(0);
    expect(t.c.state).toEqual({ status: "off" });
    expect(t.updater.autoInstallOnAppQuit).toBe(false);
    expect(await t.c.checkNow()).toEqual({ status: "off" });
    expect(t.updater.calls).toHaveLength(0);
    expect(JSON.parse(readFileSync(t.file, "utf8"))).toMatchObject({ enabled: false });
    // a new start reads the switch
    const again = controller("1.0.0", { settingsFile: t.file });
    expect(again.c.settings.enabled).toBe(false);
    expect(again.c.state).toEqual({ status: "off" });
    again.c.start();
    expect(again.live().map((x) => x.ms)).toEqual([30_000]);
    again.live()[0]?.callback();
    await vi_flush();
    expect(again.updater.calls).toHaveLength(0);
    // on again: a check soon
    t.c.setEnabled(true);
    expect(t.updater.autoInstallOnAppQuit).toBe(true);
    expect(t.live().map((x) => x.ms)).toEqual([0]);
  });

  it("does not install a downloaded update after the switch went off during the download", async () => {
    const t = controller("1.0.0");
    t.updater.answers = ["1.0.1"];
    let open!: () => void;
    t.updater.gate = new Promise<void>((resolve) => (open = resolve));
    const running = t.c.checkNow();
    t.c.setEnabled(false);
    open();
    expect(await running).toEqual({ status: "off" });
    expect(await t.c.installNow()).toBe(false);
  });

  it("checks the new channel after a check that began on the old one, and keeps a downloaded update across the switch", async () => {
    const t = controller("1.0.0");
    t.c.start();
    let open!: () => void;
    t.updater.gate = new Promise<void>((resolve) => (open = resolve));
    t.updater.answers = [null];
    const running = t.c.checkNow();
    t.c.setChannel("beta");
    expect(t.live().map((x) => x.ms)).toEqual([30_000]); // no second check yet
    open();
    await running;
    await vi_flush();
    expect(t.live().map((x) => x.ms)).toEqual([0]);
    // a downloaded update stays when updates go off and on
    const u = controller("1.0.0");
    u.updater.answers = ["1.0.1"];
    await u.c.checkNow();
    u.c.setEnabled(false);
    u.c.setEnabled(true);
    expect(u.c.state).toEqual({ status: "ready", version: "1.0.1" });
    // a release candidate is dropped when the person goes back to stable releases
    const v = controller("1.0.0-rc.1");
    v.updater.answers = [null, "1.0.0-rc.2"];
    await v.c.checkNow();
    v.c.setChannel("latest");
    expect(v.c.state.status).toBe("idle");
    expect(v.updater.autoInstallOnAppQuit).toBe(false);
  });

  it("keeps the channel and checks again at once", async () => {
    const t = controller("1.0.0");
    t.c.start();
    t.c.setChannel("beta");
    expect(JSON.parse(readFileSync(t.file, "utf8"))).toMatchObject({ channel: "beta" });
    expect(t.live().map((x) => x.ms)).toEqual([0]);
  });
});

function vi_flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve)).then(() => new Promise<void>((resolve) => setImmediate(resolve)));
}

// ---------------------------------------------------------------------------------------------------------------
// The real electron-updater against a local server that answers as GitHub does. No release exists anywhere.

interface FakeRelease {
  tag: string;
  prerelease: boolean;
  /** The bytes of the Windows installer. */
  installer: Buffer;
  /** Lie about the digest. */
  badDigest?: boolean;
}

const OWNER = "ZarK";
const REPO = "memex.example";

function digest512(bytes: Buffer): string {
  return createHash("sha512").update(bytes).digest("base64");
}

/** Serves releases.atom, releases/latest and the downloads of releases, newest first. */
function githubServer(releases: FakeRelease[]): Promise<{ server: Server; host: string; requests: string[] }> {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://x");
    requests.push(url.pathname);
    const base = `/${OWNER}/${REPO}/releases`;
    if (url.pathname === `${base}.atom`) {
      const entries = releases
        .map((r) => `<entry><id>tag:github.com,2008:Repository/1/${r.tag}</id><link rel="alternate" type="text/html" href="http://${request.headers.host}${base}/tag/${r.tag}"/><title>${r.tag}</title><content type="html"></content></entry>`)
        .join("");
      response.setHeader("content-type", "application/atom+xml");
      response.end(`<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom">${entries}</feed>`);
      return;
    }
    // github.com answers /releases/latest on its web host; any other host (this server) on the Enterprise API path.
    if (url.pathname === `${base}/latest` || url.pathname === `/api/v3/repos/${OWNER}/${REPO}/releases/latest`) {
      const latest = releases.find((r) => !r.prerelease);
      if (!latest) {
        response.statusCode = 404;
        response.end("none");
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ tag_name: latest.tag }));
      return;
    }
    const match = url.pathname.match(new RegExp(`^${base}/download/([^/]+)/(.+)$`));
    const release = match ? releases.find((r) => r.tag === match[1]) : undefined;
    if (match && release) {
      const version = release.tag.replace(/^v/, "");
      const installerName = `Memex.Example-${version}-windows-x64.exe`;
      const channel = /-([a-z]+)/.exec(version)?.[1] ?? "latest";
      // electron-updater asks for latest.yml on Windows and latest-linux.yml on Linux: the test serves the same file for both.
      if (match[2] === `${channel}.yml` || match[2] === `${channel}-linux.yml`) {
        const sha512 = release.badDigest ? digest512(Buffer.from("other")) : digest512(release.installer);
        response.setHeader("content-type", "text/yaml");
        response.end(`version: ${version}\nfiles:\n  - url: ${installerName}\n    sha512: ${sha512}\n    size: ${release.installer.length}\npath: ${installerName}\nsha512: ${sha512}\nreleaseDate: '2026-12-15T09:00:00.000Z'\n`);
        return;
      }
      if (match[2] === installerName) {
        response.setHeader("content-length", String(release.installer.length));
        response.end(release.installer);
        return;
      }
    }
    response.statusCode = 404;
    response.end("not found");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, host: `127.0.0.1:${(server.address() as AddressInfo).port}`, requests }));
  });
}

async function realUpdater(version: string, cache: string): Promise<UpdaterLike> {
  const module = (await import("electron-updater")) as unknown as { NsisUpdater?: new (options: unknown, app: unknown) => UpdaterLike; default?: { NsisUpdater: new (options: unknown, app: unknown) => UpdaterLike } };
  const NsisUpdater = module.NsisUpdater ?? module.default?.NsisUpdater;
  if (!NsisUpdater) throw new Error("electron-updater has no NsisUpdater.");
  // The builder writes app-update.yml into an installed app (the download step reads it); this stands in for it.
  mkdirSync(cache, { recursive: true });
  writeFileSync(path.join(cache, "app-update.yml"), `provider: github
owner: ${OWNER}
repo: ${REPO}
`);
  const adapter = {
    version,
    name: "memex-example",
    isPackaged: true,
    appUpdateConfigPath: path.join(cache, "app-update.yml"),
    userDataPath: cache,
    baseCachePath: cache,
    whenReady: () => Promise.resolve(),
    relaunch: () => {},
    quit: () => {},
    onQuit: () => {},
  };
  const runtime = (await import("builder-util-runtime")) as unknown as { HttpExecutor?: HttpExecutorClass; default?: { HttpExecutor: HttpExecutorClass } };
  const HttpExecutor = runtime.HttpExecutor ?? runtime.default?.HttpExecutor;
  if (!HttpExecutor) throw new Error("builder-util-runtime has no HttpExecutor.");
  // Outside Electron the updater has no way to make requests; the app's own updater gets Electron's net module.
  const { configureRequestOptions, configureRequestUrl } = runtime as unknown as { configureRequestOptions: (o: object) => void; configureRequestUrl: (u: URL, o: object) => void };
  class NodeExecutor extends HttpExecutor {
    // The download of ElectronHttpExecutor with node's http: the library's own digest check runs in doDownload.
    async download(url: URL, destination: string, options: { cancellationToken: { createPromise: <T>(f: (resolve: (v: T) => void, reject: (e: Error) => void, onCancel: (f: () => void) => void) => void) => Promise<T> }; headers?: object | null }): Promise<string> {
      return await options.cancellationToken.createPromise<string>((resolve, reject, onCancel) => {
        const requestOptions = { headers: options.headers || undefined, redirect: "manual" };
        configureRequestUrl(url, requestOptions);
        configureRequestOptions(requestOptions);
        (this as unknown as { doDownload: (o: object, t: object, n: number) => void }).doDownload(requestOptions, { destination, options, onCancel, callback: (error: Error | null) => (error == null ? resolve(destination) : reject(error)), responseHandler: null }, 0);
      });
    }
    createRequest(options: RequestOptions, callback: (response: IncomingMessage) => void): ClientRequest {
      return (options.protocol === "https:" ? https : http).request(options, callback);
    }
  }
  const updater = new NsisUpdater(undefined, adapter);
  (updater as unknown as { httpExecutor: unknown }).httpExecutor = new NodeExecutor();
  return updater;
}

type HttpExecutorClass = new () => { download: unknown; createRequest(options: RequestOptions, callback: (response: IncomingMessage) => void): ClientRequest };

describe("electron-updater against a local GitHub-style feed", () => {
  let server: Server | null = null;
  beforeEach(() => {
    server = null;
  });
  afterEach(() => {
    server?.close();
  });

  async function run(current: string, releases: FakeRelease[], channel?: "latest" | "beta") {
    const hosted = await githubServer(releases);
    server = hosted.server;
    const dir = scratch();
    const updater = await realUpdater(current, path.join(dir, "cache"));
    const settingsFile = path.join(dir, "updates.json");
    if (channel) writeUpdateSettings(settingsFile, { enabled: true, channel });
    const logs: string[] = [];
    const c = new UpdateController({ updater, feed: { provider: "github", owner: OWNER, repo: REPO, host: hosted.host, protocol: "http" }, version: current, settingsFile, log: (l) => logs.push(l) });
    return { c, dir, logs, requests: hosted.requests, updater };
  }

  function downloaded(dir: string): string[] {
    const pending = path.join(dir, "cache", "memex-example", "pending");
    return existsSync(pending) ? readdirSync(pending).filter((n) => n.endsWith(".exe")) : [];
  }

  it("downloads a stable update and checks its digest", async () => {
    const installer = Buffer.from("MZ stable installer 0.1.1");
    const t = await run("0.1.0", [{ tag: "v0.1.1", prerelease: false, installer }]);
    expect(await t.c.checkNow()).toEqual({ status: "ready", version: "0.1.1" });
    const [name] = downloaded(t.dir);
    expect(name).toBe("Memex.Example-0.1.1-windows-x64.exe");
    expect(readFileSync(path.join(t.dir, "cache", "memex-example", "pending", name ?? ""))).toEqual(installer);
  });

  it("finds nothing when the app is the newest", async () => {
    const t = await run("0.1.1", [{ tag: "v0.1.1", prerelease: false, installer: Buffer.from("same") }]);
    expect((await t.c.checkNow()).status).toBe("idle");
    expect(downloaded(t.dir)).toEqual([]);
  });

  it("refuses an installer whose digest differs from the feed", async () => {
    const t = await run("0.1.0", [{ tag: "v0.1.1", prerelease: false, installer: Buffer.from("tampered"), badDigest: true }]);
    const state = await t.c.checkNow();
    expect(state.status).toBe("error");
    expect(downloaded(t.dir)).toEqual([]);
  });

  it("takes rc.1 to rc.2 on the beta channel and ignores it on the latest channel", async () => {
    const releases: FakeRelease[] = [
      { tag: "v1.0.0-rc.2", prerelease: true, installer: Buffer.from("rc2") },
      { tag: "v1.0.0-rc.1", prerelease: true, installer: Buffer.from("rc1") },
    ];
    const beta = await run("1.0.0-rc.1", releases);
    expect(beta.c.settings.channel).toBe("beta");
    expect(await beta.c.checkNow()).toEqual({ status: "ready", version: "1.0.0-rc.2" });
    expect(downloaded(beta.dir)).toEqual(["Memex.Example-1.0.0-rc.2-windows-x64.exe"]);
    server?.close();
    const stable = await run("1.0.0-rc.1", releases, "latest");
    expect((await stable.c.checkNow()).status).toBe("error"); // no stable release exists yet
    expect(downloaded(stable.dir)).toEqual([]);
  });

  it("takes rc.2 to 1.0.0 when the stable release is out", async () => {
    const t = await run("1.0.0-rc.2", [
      { tag: "v1.0.0", prerelease: false, installer: Buffer.from("final") },
      { tag: "v1.0.0-rc.2", prerelease: true, installer: Buffer.from("rc2") },
    ]);
    expect(await t.c.checkNow()).toEqual({ status: "ready", version: "1.0.0" });
    expect(downloaded(t.dir)).toEqual(["Memex.Example-1.0.0-windows-x64.exe"]);
  });

  it("takes a stable app to the next release candidate on the beta channel only", async () => {
    const releases: FakeRelease[] = [
      { tag: "v1.1.0-rc.1", prerelease: true, installer: Buffer.from("rc") },
      { tag: "v1.0.0", prerelease: false, installer: Buffer.from("final") },
    ];
    const latest = await run("1.0.0", releases);
    expect((await latest.c.checkNow()).status).toBe("idle");
    server?.close();
    const beta = await run("1.0.0", releases, "beta");
    expect(await beta.c.checkNow()).toEqual({ status: "ready", version: "1.1.0-rc.1" });
  });
});
