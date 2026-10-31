/**
 * The shell's own pages: the crash screen and About. They are served from memory on the memex-shell: scheme with a
 * strict content security policy, so they load nothing from outside and run only their own inline script.
 */
export const SHELL_SCHEME = "memex-shell";
export const CRASH_URL = `${SHELL_SCHEME}://app/crash`;
export const ABOUT_URL = `${SHELL_SCHEME}://app/about`;
export const SHELL_CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'";

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const STYLE = `
:root { color-scheme: light dark; --bg: #f6f3ec; --fg: #1d1b18; --muted: #5d5850; --line: #d9d2c3; --accent: #2f5d50; --panel: #fffdf8; }
@media (prefers-color-scheme: dark) { :root { --bg: #181715; --fg: #ece8df; --muted: #a59e92; --line: #38342e; --accent: #8cc4b0; --panel: #22201d; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 760px; margin: 0 auto; padding: 40px 24px; }
h1 { font-size: 22px; margin: 0 0 8px; }
h2 { font-size: 16px; margin: 28px 0 8px; }
p { margin: 0 0 12px; }
.muted { color: var(--muted); }
pre { background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 12px; overflow: auto; max-height: 320px; font: 12px/1.45 ui-monospace, Consolas, monospace; white-space: pre-wrap; word-break: break-word; }
.actions { display: flex; gap: 12px; margin-top: 20px; flex-wrap: wrap; }
button { font: inherit; padding: 8px 16px; border-radius: 6px; border: 1px solid var(--line); background: var(--panel); color: var(--fg); cursor: pointer; }
button.primary { background: var(--accent); border-color: var(--accent); color: var(--bg); }
ul { padding: 0; list-style: none; margin: 0; }
li { border-top: 1px solid var(--line); padding: 8px 0; }
li .name { font-weight: 600; }
a { color: var(--accent); }
`;

function page(title: string, body: string, script: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${escapeHtml(SHELL_CSP)}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title><style>${STYLE}</style></head>
<body><main>${body}</main><script>${script}</script></body></html>
`;
}

export const STARTING_URL = `${SHELL_SCHEME}://app/starting`;

/** The page the window shows while the server starts. */
export function startingPageHtml(productName: string): string {
  return page(productName, `<h1>${escapeHtml(productName)}</h1><p class="muted">Starting...</p>`, "");
}

export interface CrashInfo {
  productName: string;
  /** What happened, in one sentence. */
  reason: string;
  /** The exit code of the server, when it exited. */
  code?: number | null;
  /** The last lines the server wrote. */
  output?: string[];
  /** The log file the shell writes. */
  logFile?: string;
}

/** The crash screen: what stopped, the last lines of output, and Restart and Quit. */
export function crashPageHtml(info: CrashInfo): string {
  const output = (info.output ?? []).join("\n");
  const body = `
<h1>${escapeHtml(info.productName)} stopped working</h1>
<p>${escapeHtml(info.reason)}${info.code === undefined || info.code === null ? "" : ` Exit code ${escapeHtml(info.code)}.`}</p>
<p class="muted">Restart to start it again. If it stops again, the log file has the details.</p>
${output ? `<h2>Last output</h2><pre>${escapeHtml(output)}</pre>` : ""}
${info.logFile ? `<p class="muted">Log file: ${escapeHtml(info.logFile)}</p>` : ""}
<div class="actions"><button class="primary" id="restart" autofocus>Restart</button><button id="quit">Quit</button></div>`;
  const script = `
document.getElementById('restart').addEventListener('click', () => window.memexShell.restart());
document.getElementById('quit').addEventListener('click', () => window.memexShell.quit());`;
  return page(`${info.productName} stopped working`, body, script);
}

/** One entry of notices.json (memex.notices/1, written by @tjalve/memex-licenses). */
export interface NoticeComponent {
  name: string;
  version?: string;
  license?: string | null;
  homepage?: string;
  copyright?: string[];
  attribution?: string | null;
  ecosystem?: string;
}

export interface NoticesFile {
  format: "memex.notices/1";
  product?: string;
  components: NoticeComponent[];
}

/** Parses notices.json. Throws when it is not memex.notices/1. */
export function parseNotices(text: string): NoticesFile {
  const value: unknown = JSON.parse(text);
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("notices.json is not an object.");
  const record = value as Record<string, unknown>;
  if (record.format !== "memex.notices/1") throw new Error("notices.json is not memex.notices/1.");
  if (!Array.isArray(record.components)) throw new Error("notices.json has no components.");
  const components: NoticeComponent[] = [];
  for (const item of record.components) {
    if (item === null || typeof item !== "object") continue;
    const c = item as Record<string, unknown>;
    if (typeof c.name !== "string") continue;
    components.push({
      name: c.name,
      version: typeof c.version === "string" ? c.version : undefined,
      license: typeof c.license === "string" ? c.license : null,
      homepage: typeof c.homepage === "string" ? c.homepage : undefined,
      copyright: Array.isArray(c.copyright) ? c.copyright.filter((x): x is string => typeof x === "string") : [],
      attribution: typeof c.attribution === "string" ? c.attribution : null,
      ecosystem: typeof c.ecosystem === "string" ? c.ecosystem : undefined,
    });
  }
  return { format: "memex.notices/1", product: typeof record.product === "string" ? record.product : undefined, components };
}

export interface AboutInfo {
  productName: string;
  version: string;
  /** The SPDX id of the app's own license. */
  license?: string;
  copyright?: string;
  homepage?: string;
  /** Electron, Chromium and Node.js versions. */
  runtime?: { electron?: string; chrome?: string; node?: string };
  notices?: NoticesFile | null;
  /** Why notices.json could not be read, when it could not. */
  noticesError?: string;
  /** Whether the notices folder can be opened. */
  canOpenNotices?: boolean;
}

function externalLink(url: string | undefined, label: string): string {
  if (!url || !/^https:\/\//.test(url)) return escapeHtml(label);
  return `<a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${escapeHtml(label)}</a>`;
}

/** About: the app, its license, the runtime, and every third-party component from notices.json. */
export function aboutPageHtml(info: AboutInfo): string {
  const runtime = info.runtime ?? {};
  const parts = [
    runtime.electron ? `Electron ${runtime.electron}` : "",
    runtime.chrome ? `Chromium ${runtime.chrome}` : "",
    runtime.node ? `Node.js ${runtime.node}` : "",
  ].filter(Boolean);
  const components = info.notices?.components ?? [];
  const list = components
    .map((c) => {
      const credit = [...(c.copyright ?? []), c.attribution ?? ""].filter(Boolean).map((line) => `<div class="muted">${escapeHtml(line)}</div>`).join("");
      return `<li><span class="name">${externalLink(c.homepage, c.name)}</span>${c.version ? ` ${escapeHtml(c.version)}` : ""} <span class="muted">${escapeHtml(c.license ?? "license unknown")}</span>${credit}</li>`;
    })
    .join("");
  const body = `
<h1>${escapeHtml(info.productName)}</h1>
<p>Version ${escapeHtml(info.version)}${info.license ? `. License: ${escapeHtml(info.license)}` : ""}.</p>
${info.copyright ? `<p>${escapeHtml(info.copyright)}</p>` : ""}
${info.homepage ? `<p>${externalLink(info.homepage, info.homepage)}</p>` : ""}
${parts.length > 0 ? `<p class="muted">${escapeHtml(parts.join(", "))}</p>` : ""}
<h2>Third-party software and content</h2>
${info.noticesError ? `<p class="muted">${escapeHtml(info.noticesError)}</p>` : ""}
${components.length > 0 ? `<p class="muted">${components.length} components. The full license texts are in the notices folder.</p><ul id="components">${list}</ul>` : info.noticesError ? "" : `<p class="muted">No third-party components are listed.</p>`}
<div class="actions">${info.canOpenNotices ? `<button id="notices">Open the notices folder</button>` : ""}</div>`;
  const script = info.canOpenNotices ? `document.getElementById('notices').addEventListener('click', () => window.memexShell.openNotices());` : "";
  return page(`About ${info.productName}`, body, script);
}
