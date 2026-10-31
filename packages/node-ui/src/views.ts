import { moving, type Backend, type FoundBackend, type NodeFunction, type Pack, type PackLocation } from "./api.js";

/** The elements draw these strings. Every value from Node or the user goes through escapeHtml. */
export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const e = escapeHtml;

export function formatBytes(bytes: number): string {
  const units = ["bytes", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return `${unit === 0 ? value : value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

const bar = (done: number, total: number, label: string) =>
  `<progress part="progress" value="${e(done)}" max="${e(Math.max(total, 1))}" aria-label="${e(label)}"></progress><span class="sub">${formatBytes(done)} of ${formatBytes(total)}</span>`;

const notice = (message: string | null | undefined) => (message ? `<p class="notice" role="alert">${e(message)}</p>` : "");

export function packSize(pack: Pack): number {
  const version = pack.versions.find((v) => v.version === pack.active) ?? pack.versions.at(-1);
  return version?.bytes ?? 0;
}

const packStates: Record<Pack["state"], string> = {
  "not-installed": "Not installed",
  installing: "Installing",
  installed: "Installed",
  "needs-acceptance": "Needs your acceptance",
  refused: "License not known",
};

const confirmRow = (id: string, question: string) =>
  `<span class="sub">${e(question)}</span><button data-action="remove" data-id="${e(id)}">Yes, remove</button><button data-action="keep">Keep</button>`;

function packActions(pack: Pack, confirming: string | null | undefined): string {
  const id = e(pack.id);
  if (confirming === pack.id) return confirmRow(pack.id, `Remove it? It takes ${formatBytes(packSize(pack))} to download again.`);
  switch (pack.state) {
    case "not-installed":
      return `<button data-action="install" data-id="${id}">Install</button>`;
    case "needs-acceptance":
      return `<button data-action="license" data-id="${id}">Read the license</button>`;
    case "installed":
      return `<button data-action="ask-remove" data-id="${id}" ${pack.usedBy.length ? `title="Used by ${e(pack.usedBy.join(", "))}"` : ""}>Remove</button>`;
    default:
      return "";
  }
}

export interface PacksState {
  packs: Pack[];
  error?: string | null;
  confirming?: string | null;
}

export function packsView(state: PacksState): string {
  const rows = state.packs.map((pack) => `
    <li part="row">
      <div class="main">
        <strong>${e(pack.title)}</strong>
        <span class="sub">${e(pack.kind)} · ${formatBytes(packSize(pack))} · ${e(pack.license.spdx ?? "license not known")}${pack.usedBy.length ? ` · used by ${e(pack.usedBy.join(", "))}` : ""}</span>
        ${pack.state === "installing" && pack.install ? bar(pack.install.bytesDone, pack.install.bytesTotal, `Installing ${pack.title}`) : ""}
        ${pack.install?.phase === "failed" && pack.install.error ? `<span class="notice">${e(pack.install.error.message)}</span>` : ""}
      </div>
      <span class="state" data-state="${e(pack.state)}">${packStates[pack.state] ?? e(pack.state)}</span>
      <div class="actions">${packActions(pack, state.confirming)}</div>
    </li>`).join("");
  return `${notice(state.error)}<ul>${rows}</ul>${state.packs.length ? "" : `<p class="sub">No packs.</p>`}`;
}

/** What the license dialog holds. It lives outside the drawn view, so a refresh leaves it alone. */
export function licenseView(license: { id: string; title: string; text: string }): string {
  return `<h3>License of ${e(license.title)}</h3>
    <pre tabindex="0">${e(license.text)}</pre>
    <div class="actions"><button data-action="accept" data-id="${e(license.id)}">Accept and install</button><button data-action="close">Cancel</button></div>`;
}

const limitFrom = { set: "your limit", reported: "reported by the server", learned: "learned by Memex Node" } as const;

export interface BackendsState {
  backends: Backend[];
  functions: NodeFunction[];
  found?: FoundBackend[] | null;
  error?: string | null;
  confirming?: string | null;
}

/** Capabilities that a model server can serve. The others run in Node, and no route changes that. */
const SERVED = ["chat", "vision", "embed.text", "stt", "tts", "food.recognize"];

function backendRow(backend: Backend, confirming: string | null | undefined): string {
  const id = e(backend.id);
  const { local: nearby } = backend;
  return `
    <li part="row">
      <div class="main">
        <strong>${e(backend.label)}</strong>
        <span class="sub">${e(backend.url)}${nearby ? "" : " · outside this network"}${backend.hasKey ? " · key stored" : ""}</span>
        <span class="sub">${backend.models.length} models · ${e(backend.concurrency)} at once${backend.concurrencyFrom ? ` (${limitFrom[backend.concurrencyFrom]})` : ""}</span>
      </div>
      <span class="state" data-state="${backend.state === "available" ? "installed" : "refused"}">${backend.state === "available" ? "Available" : "Not answering"}</span>
      <div class="actions">
        <label>Limit <input type="number" min="1" data-limit="${id}" value="${backend.concurrencyFrom === "set" ? e(backend.concurrency) : ""}" placeholder="auto" aria-label="Limit of calls at once for ${e(backend.label)}"></label>
        <button data-action="limit" data-id="${id}">Save</button>
        ${confirming === backend.id
          ? confirmRow(backend.id, backend.hasKey ? "Remove it? Its stored key is deleted too." : "Remove it?")
          : `<button data-action="ask-remove" data-id="${id}">Remove</button>`}
      </div>
    </li>`;
}

function functionRow(fn: NodeFunction, backends: Backend[]): string {
  const id = e(fn.id);
  const options = backends.map((b) => `<option value="${e(b.id)}"${fn.route.backend === b.id ? " selected" : ""}>${e(b.label)}</option>`).join("");
  const models = [...new Set(backends.flatMap((b) => b.models.map((m) => m.id)))];
  const others = fn.route.also?.length
    ? `<span class="sub">and ${fn.route.also.length} more ${fn.route.also.length === 1 ? "server" : "servers"}, kept while a server is chosen</span>`
    : "";
  if (!fn.capabilities.some((capability) => SERVED.includes(capability))) {
    return `
    <li part="row">
      <div class="main"><strong>${id}</strong><span class="sub">${e(fn.capabilities.join(", "))} · ${e(fn.state)}${fn.reason ? ` · ${e(fn.reason)}` : ""}</span></div>
      <span class="state">Runs in Memex Node</span>
    </li>`;
  }
  return `
    <li part="row">
      <div class="main">
        <strong>${id}</strong>
        <span class="sub">${e(fn.capabilities.join(", "))} · ${e(fn.state)}${fn.reason ? ` · ${e(fn.reason)}` : ""}</span>
        ${others}
      </div>
      <div class="actions">
        <label>Server <select data-route="${id}" aria-label="Server of ${id}"><option value="">Automatic</option>${options}</select></label>
        <label>Model <input data-model="${id}" list="models-${id}" value="${e(fn.route.model)}" aria-label="Model of ${id}"></label>
        <datalist id="models-${id}">${models.map((m) => `<option value="${e(m)}"></option>`).join("")}</datalist>
        <label>Limit <input type="number" min="1" data-route-limit="${id}" value="${e(fn.route.concurrency)}" placeholder="none" aria-label="Limit of calls at once for ${id}"></label>
        <button data-action="route" data-id="${id}">Save</button>
        ${fn.route.also?.length ? `<button data-action="one-server" data-id="${id}">Use one server</button>` : ""}
      </div>
    </li>`;
}

export function backendsView(state: BackendsState): string {
  const found = state.found?.length
    ? `<ul>${state.found.map((f) => `<li part="row"><div class="main"><strong>${e(f.url)}</strong><span class="sub">${f.models.length} models</span></div><div class="actions"><button data-action="add-found" data-url="${e(f.url)}">Add</button></div></li>`).join("")}</ul>`
    : state.found ? `<p class="sub">Found no model server on this computer.</p>` : "";
  const functions = state.functions.filter((f) => f.runsIn === "node");
  return `${notice(state.error)}
    <h3>Model servers</h3>
    <ul>${state.backends.map((backend) => backendRow(backend, state.confirming)).join("")}</ul>
    ${state.backends.length ? "" : `<p class="sub">No model servers.</p>`}
    <form data-form="add">
      <label>URL <input name="url" type="url" required placeholder="http://127.0.0.1:8080/v1"></label>
      <label>Name <input name="label"></label>
      <label>Key <input name="apiKey" type="password" autocomplete="off"></label>
      <label>Limit <input name="concurrency" type="number" min="1" placeholder="auto"></label>
      <button type="submit">Add</button>
      <button type="button" data-action="discover">Find on this computer</button>
    </form>
    ${found}
    <h3>Functions</h3>
    <ul>${functions.map((f) => functionRow(f, state.backends)).join("")}</ul>
    ${functions.length ? "" : `<p class="sub">No app has registered a function yet.</p>`}`;
}

export interface LocationState {
  location: PackLocation | null;
  error?: string | null;
}

export function locationView(state: LocationState): string {
  const { location } = state;
  if (!location) return notice(state.error);
  const busy = moving(location);
  const warning = location.warning ?? location.target?.warning;
  return `${notice(state.error)}
    <p class="main"><span class="sub">Packs are in</span> <strong>${e(location.path)}</strong></p>
    ${busy ? `<p><span class="sub">Moving to ${e(location.move!.to)}</span> ${bar(location.move!.bytesDone, location.move!.bytesTotal, "Moving the packs")}</p>` : ""}
    ${location.move?.phase === "failed" ? notice(location.move.error?.message ?? "The move stopped. The packs stay where they were.") : ""}
    ${warning ? `<p class="notice" role="status">${e(warning.text ?? `${warning.client} synchronizes this folder.`)}</p>` : ""}
    <form data-form="move">
      <label>New folder <input name="path" required ${busy ? "disabled" : ""}></label>
      <button type="submit" ${busy ? "disabled" : ""}>Move</button>
    </form>`;
}

export const styles = `
  :host { display: block; font: 400 0.875rem/1.45 var(--sans, system-ui, sans-serif); color: var(--ink, #1f1d1a); }
  h3 { margin: 1rem 0 0.25rem; font: 500 0.9375rem/1.3 var(--sans, system-ui, sans-serif); }
  ul { list-style: none; margin: 0; padding: 0; }
  li { display: flex; flex-wrap: wrap; gap: 0.25rem 1rem; align-items: center; padding: 0.625rem 0; border-bottom: 1px solid var(--line, #0002); }
  .main { flex: 1 1 16rem; min-width: 0; display: flex; flex-direction: column; overflow-wrap: anywhere; }
  .sub { color: var(--ink-3, #6b665e); font-size: 0.8125rem; }
  .state { color: var(--ink-2, #47433c); font-size: 0.8125rem; white-space: nowrap; }
  .actions { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; }
  form { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: end; padding: 0.75rem 0; }
  label { display: inline-flex; flex-direction: column; font-size: 0.75rem; color: var(--ink-3, #6b665e); }
  label { max-width: 100%; }
  input, select { max-width: 100%; box-sizing: border-box; }
  input, select, button { font: inherit; color: inherit; background: transparent; border: 1px solid var(--line-2, #0003); border-radius: 0.25rem; padding: 0.25rem 0.5rem; }
  input[type="number"] { width: 4.5rem; }
  button { cursor: pointer; color: var(--ink, #1f1d1a); }
  button:disabled { cursor: default; opacity: 0.5; }
  button:focus-visible, input:focus-visible, select:focus-visible { outline: 2px solid var(--accent, #47433c); outline-offset: 1px; }
  progress { width: 100%; height: 0.375rem; margin-top: 0.25rem; }
  .notice { margin: 0.5rem 0; padding: 0.5rem 0.75rem; border-left: 2px solid var(--accent, #47433c); }
  dialog { max-width: min(40rem, 90vw); border: 1px solid var(--line-2, #0003); border-radius: 0.375rem; color: inherit; background: var(--card, #fff); }
  dialog pre { max-height: 50vh; overflow: auto; white-space: pre-wrap; font-size: 0.8125rem; }
`;
