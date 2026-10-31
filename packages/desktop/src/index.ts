/**
 * @tjalve/memex-desktop: the Electron main process of every Memex app. Import it in the app's main module only;
 * the server uses @tjalve/memex-desktop/server, and packing uses @tjalve/memex-desktop/build.
 */
export { startDesktopApp } from "./shell.js";
export type { DesktopAppOptions, DesktopShell, ShellContext, ShellEvent } from "./shell.js";
export type { ExecServerSpec, NodeServerSpec, RunningServer, ServerSpec } from "./spawn.js";
export type { ShellPaths } from "./home.js";
export { assertOutsideInstall, isInsideDirectory, packagedInstallDirectory } from "./home.js";
export { cookieName, isLaunchToken, tokenCookieDetails } from "./cookie.js";
export { READY_PREFIX, createReadyLineReader, formatReadyLine, isAllowedAppUrl, isAllowedExternalUrl, parseReadyLine } from "./ready-line.js";
export type { ReadyAnnouncement, ReadyLineReader } from "./ready-line.js";
export { ABOUT_URL, CRASH_URL, SHELL_SCHEME, aboutPageHtml, crashPageHtml, parseNotices } from "./pages.js";
export type { AboutInfo, CrashInfo, NoticeComponent, NoticesFile } from "./pages.js";
export { installedCliShim } from "./cli-shim.js";
