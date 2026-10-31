import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { SMOKE_ENV } from "./smoke.js";

/**
 * Update feeds. The app checks the releases of its own repository: a stable release is "latest", a release candidate
 * (a version such as 1.0.0-rc.2) is "beta". The shell checks when the app starts and then every 6 hours, downloads an
 * update in the background and installs it when the app quits. The person can turn all of it off.
 */

export type UpdateChannel = "latest" | "beta";

/** Where the releases are. The GitHub form takes the releases of one repository; host and protocol are for a test server. */
export type UpdateFeed =
  | { provider: "github"; owner: string; repo: string; host?: string; protocol?: "https" | "http" }
  | { provider: "generic"; url: string };

export interface UpdateSettings {
  enabled: boolean;
  channel: UpdateChannel;
}

export type UpdateState =
  | { status: "off" }
  | { status: "idle"; checkedAt?: string }
  | { status: "checking" }
  | { status: "downloading"; version: string }
  | { status: "ready"; version: string }
  | { status: "error"; message: string; checkedAt?: string };

/** The part of electron-updater's AppUpdater that the controller uses. */
export interface UpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  allowDowngrade: boolean;
  setFeedURL(feed: unknown): void;
  checkForUpdates(): Promise<{ isUpdateAvailable?: boolean; updateInfo: { version: string } } | null>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
  on(event: "error", listener: (error: Error) => void): unknown;
}

export interface UpdateSupport {
  supported: boolean;
  reason?: string;
}

export const UPDATE_SETTINGS_SCHEMA = "memex.updates/1";
export const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const UPDATE_FIRST_CHECK_DELAY_MS = 30 * 1000;
/** Set to "off" to start an app with updates turned off for this run (the settings file is not changed). */
export const UPDATES_ENV = "MEMEX_DESKTOP_UPDATES";

const GITHUB_NAME = /^[A-Za-z0-9._-]+$/;

/** The channel a version belongs to: a version with a prerelease part (1.0.0-rc.2) is beta. */
export function channelOfVersion(version: string): UpdateChannel {
  return /^\d+\.\d+\.\d+-[0-9A-Za-z]/.test(version) ? "beta" : "latest";
}

/** Checks a feed. A feed from the app's own code is trusted; this only catches mistakes. */
export function parseUpdateFeed(value: unknown): UpdateFeed {
  const feed = value as Partial<Record<string, unknown>> | null;
  if (feed && feed.provider === "github") {
    const { owner, repo, host, protocol } = feed;
    if (typeof owner !== "string" || !GITHUB_NAME.test(owner)) throw new Error("The update feed needs a GitHub owner.");
    if (typeof repo !== "string" || !GITHUB_NAME.test(repo)) throw new Error("The update feed needs a GitHub repository.");
    if (host !== undefined && (typeof host !== "string" || !/^[A-Za-z0-9.:-]+$/.test(host))) throw new Error("The update feed host is not valid.");
    if (protocol !== undefined && protocol !== "https" && protocol !== "http") throw new Error("The update feed protocol must be https or http.");
    return { provider: "github", owner, repo, ...(host === undefined ? {} : { host }), ...(protocol === undefined ? {} : { protocol }) };
  }
  if (feed && feed.provider === "generic") {
    if (typeof feed.url !== "string") throw new Error("The update feed needs a url.");
    const url = new URL(feed.url);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("The update feed url must be https or http.");
    return { provider: "generic", url: url.href };
  }
  throw new Error("The update feed must be github or generic.");
}

/**
 * What this build can do. Windows installs an update with the NSIS installer and Linux with the AppImage. A deb is
 * managed by the package manager, and an unsigned macOS build cannot install an update: it needs a Developer ID.
 */
export function updateSupport(input: { platform: string; env: Record<string, string | undefined>; packaged: boolean }): UpdateSupport {
  if (!input.packaged) return { supported: false, reason: "The app is not installed." };
  if (input.env[SMOKE_ENV]) return { supported: false, reason: "The app runs in smoke-test mode." };
  if (input.env[UPDATES_ENV]?.toLowerCase() === "off") return { supported: false, reason: `${UPDATES_ENV} is off.` };
  if (input.platform === "win32") return { supported: true };
  if (input.platform === "linux") {
    return input.env.APPIMAGE ? { supported: true } : { supported: false, reason: "Only an AppImage updates itself; a deb is updated with the package manager." };
  }
  if (input.platform === "darwin") return { supported: false, reason: "An unsigned macOS build cannot install updates." };
  return { supported: false, reason: `Updates are not available on ${input.platform}.` };
}

export function readUpdateSettings(file: string, version: string, log: (line: string) => void = () => {}): UpdateSettings {
  const defaults: UpdateSettings = { enabled: true, channel: channelOfVersion(version) };
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return defaults;
  }
  try {
    const data = JSON.parse(text) as Partial<Record<string, unknown>>;
    if (data.schema !== UPDATE_SETTINGS_SCHEMA) throw new Error("another schema");
    return {
      enabled: typeof data.enabled === "boolean" ? data.enabled : defaults.enabled,
      channel: data.channel === "latest" || data.channel === "beta" ? data.channel : defaults.channel,
    };
  } catch (error) {
    log(`The update settings could not be read and are ignored: ${error instanceof Error ? error.message : String(error)}`);
    return defaults;
  }
}

export function writeUpdateSettings(file: string, settings: UpdateSettings): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ schema: UPDATE_SETTINGS_SCHEMA, enabled: settings.enabled, channel: settings.channel }, null, 2)}\n`);
  renameSync(temporary, file);
}

export interface UpdateControllerOptions {
  updater: UpdaterLike;
  feed: UpdateFeed;
  /** The installed version. */
  version: string;
  /** Where the settings are kept. */
  settingsFile: string;
  log?: (line: string) => void;
  onState?: (state: UpdateState, settings: UpdateSettings) => void;
  intervalMs?: number;
  firstCheckDelayMs?: number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
  now?: () => Date;
  /** Runs before the installer starts for "Restart to Update": the shell stops its server here, so that no program of the app still runs. */
  beforeInstall?: () => Promise<void>;
}

/**
 * Checks for updates on a schedule. One check at a time. On the beta channel it looks for a stable release first and
 * then for a release candidate: electron-updater follows only the prerelease line of a version such as 1.0.0-rc.2, so a
 * stable 1.0.0 would never reach it in one pass.
 */
export class UpdateController {
  private readonly options: UpdateControllerOptions;
  private readonly log: (line: string) => void;
  private current: UpdateSettings;
  private currentState: UpdateState;
  private timer: unknown = null;
  private running: Promise<UpdateState> | null = null;
  private started = false;
  private readyVersion: string | null = null;
  private rerun = false;

  constructor(options: UpdateControllerOptions) {
    this.options = { ...options, feed: parseUpdateFeed(options.feed) };
    this.log = options.log ?? (() => {});
    this.current = readUpdateSettings(options.settingsFile, options.version, this.log);
    this.currentState = this.current.enabled ? { status: "idle" } : { status: "off" };
    const { updater } = options;
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = true;
    updater.allowDowngrade = false;
    updater.setFeedURL(this.options.feed);
    updater.on("error", (error) => this.log(`updater: ${error.message}`));
  }

  get settings(): UpdateSettings {
    return { ...this.current };
  }

  get state(): UpdateState {
    return this.currentState;
  }

  /** Starts the schedule: a first check soon after the app starts, then every 6 hours. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.schedule(this.options.firstCheckDelayMs ?? UPDATE_FIRST_CHECK_DELAY_MS);
  }

  stop(): void {
    this.started = false;
    if (this.timer !== null) (this.options.clearTimer ?? clearTimeout)(this.timer as never);
    this.timer = null;
  }

  setEnabled(enabled: boolean): void {
    if (enabled === this.current.enabled) return;
    this.current = { ...this.current, enabled };
    this.save();
    this.log(`Updates are ${enabled ? "on" : "off"}.`);
    // Off means no install on quit either: a downloaded update waits until the person turns updates on again.
    this.options.updater.autoInstallOnAppQuit = enabled;
    if (!enabled) {
      if (this.timer !== null) (this.options.clearTimer ?? clearTimeout)(this.timer as never);
      this.timer = null;
      this.setState({ status: "off" });
    } else {
      this.setState(this.readyVersion ? { status: "ready", version: this.readyVersion } : { status: "idle" });
      if (this.started) this.schedule(0);
    }
  }

  setChannel(channel: UpdateChannel): void {
    if (channel === this.current.channel) return;
    this.current = { ...this.current, channel };
    this.save();
    this.log(`The update channel is ${channel}.`);
    // A release candidate that is downloaded does not stay for a person who went back to stable releases.
    if (channel === "latest" && this.readyVersion !== null && channelOfVersion(this.readyVersion) === "beta") {
      this.readyVersion = null;
      this.options.updater.autoInstallOnAppQuit = false;
      if (this.currentState.status === "ready") this.setState({ status: "idle" });
    }
    this.options.onState?.(this.currentState, this.settings);
    if (!this.current.enabled || !this.started) return;
    // A check that runs now looks at the old channel: run another one when it ends.
    if (this.running) this.rerun = true;
    else this.schedule(0);
  }

  /** One check now. Does nothing while updates are off. Returns the state that it ends in. */
  checkNow(): Promise<UpdateState> {
    if (!this.current.enabled) return Promise.resolve(this.currentState);
    if (this.running) return this.running;
    if (this.currentState.status === "ready") return Promise.resolve(this.currentState);
    this.running = this.check().finally(() => {
      this.running = null;
      if (this.rerun) {
        this.rerun = false;
        if (this.started && this.current.enabled) this.schedule(0);
      }
    });
    return this.running;
  }

  /** Quits the app, runs the installer of a downloaded update and starts the app again. */
  async installNow(): Promise<boolean> {
    if (this.currentState.status !== "ready" || !this.current.enabled) return false;
    this.log(`Restarting to install update ${this.currentState.version}.`);
    // The installer replaces the app's files: nothing of the app may still run when it starts.
    await this.options.beforeInstall?.();
    this.options.updater.quitAndInstall(true, true);
    return true;
  }

  private async check(): Promise<UpdateState> {
    const { updater } = this.options;
    this.setState({ status: "checking" });
    try {
      // The passes: stable first; on the beta channel then the release candidates.
      const passes = this.current.channel === "beta" ? [false, true] : [false];
      for (const allowPrerelease of passes) {
        updater.allowPrerelease = allowPrerelease;
        let result: Awaited<ReturnType<UpdaterLike["checkForUpdates"]>>;
        try {
          result = await updater.checkForUpdates();
        } catch (error) {
          // A repository with only release candidates has no stable release: the beta pass can still find one.
          if (allowPrerelease || !passes.includes(true)) throw error;
          this.log(`The stable pass failed (${error instanceof Error ? error.message : String(error)}); looking at the release candidates.`);
          continue;
        }
        if (!this.current.enabled) return this.currentState;
        if (result?.isUpdateAvailable) {
          const version = result.updateInfo.version;
          this.log(`Update ${version} found${allowPrerelease ? " (release candidate)" : ""}; downloading.`);
          this.setState({ status: "downloading", version });
          updater.autoInstallOnAppQuit = true;
          await updater.downloadUpdate();
          if (!this.current.enabled) return this.currentState;
          this.log(`Update ${version} is downloaded; it installs when the app quits.`);
          this.readyVersion = version;
          return this.setState({ status: "ready", version });
        }
      }
      this.log("No update found.");
      if (!this.current.enabled) return this.currentState;
      return this.setState({ status: "idle", checkedAt: (this.options.now ?? (() => new Date()))().toISOString() });
    } catch (error) {
      const message = error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error);
      this.log(`The update check failed: ${message}`);
      if (!this.current.enabled) return this.currentState;
      return this.setState({ status: "error", message, checkedAt: (this.options.now ?? (() => new Date()))().toISOString() });
    }
  }

  private schedule(ms: number): void {
    if (this.timer !== null) (this.options.clearTimer ?? clearTimeout)(this.timer as never);
    this.timer = (this.options.setTimer ?? setTimeout)(() => {
      this.timer = null;
      if (!this.started || !this.current.enabled) return;
      void this.checkNow().finally(() => {
        if (this.started && this.current.enabled && this.timer === null) this.schedule(this.options.intervalMs ?? UPDATE_INTERVAL_MS);
      });
    }, ms);
    (this.timer as { unref?: () => void } | null)?.unref?.();
  }

  private setState(state: UpdateState): UpdateState {
    this.currentState = state;
    this.options.onState?.(state, this.settings);
    return state;
  }

  private save(): void {
    try {
      writeUpdateSettings(this.options.settingsFile, this.current);
    } catch (error) {
      this.log(`The update settings were not saved: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
