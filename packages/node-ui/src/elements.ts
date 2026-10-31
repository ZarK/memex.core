import { NodeUiApi, NodeUiError, moving, type Backend, type FoundBackend, type NodeFunction, type Pack, type PackLocation, type Route } from "./api.js";
import { backendsView, licenseView, locationView, packsView, styles } from "./views.js";

const POLL_MS = 1000;

const message = (error: unknown) =>
  error instanceof NodeUiError ? [error.message, error.hint].filter(Boolean).join(" ") : "Memex Node does not answer.";

/** A field or button across a redraw: its name in a form, or its data attributes in a row. */
function keyOf(element: Element): string {
  const data = Object.entries((element as HTMLElement).dataset ?? {}).sort().join();
  return `${element.tagName}|${(element as HTMLInputElement).name ?? ""}|${element.closest("form")?.dataset.form ?? ""}|${data}`;
}

const changedByUser = (field: HTMLInputElement | HTMLSelectElement) =>
  field instanceof HTMLSelectElement ? [...field.options].some((o) => o.selected !== o.defaultSelected) : field.value !== field.defaultValue;

/**
 * The common part of the elements. Attributes: <code>base</code>, the path of the app's passage to Node (default
 * <code>/api/node</code>). Setting the <code>api</code> property replaces it, for example in tests.
 */
abstract class NodeElement extends HTMLElement {
  api: NodeUiApi | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #rendered = "";
  readonly #view: HTMLElement;

  constructor() {
    super();
    const root = this.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = styles;
    this.#view = document.createElement("div");
    root.append(style, this.#view);
    root.addEventListener("click", (event) => {
      const button = (event.target as Element).closest<HTMLElement>("[data-action]");
      if (button?.dataset.action) void this.#act(() => this.onAction(button.dataset.action!, button));
    });
    root.addEventListener("submit", (event) => {
      event.preventDefault();
      const form = event.target as HTMLFormElement;
      void this.#act(() => this.onSubmit(form.dataset.form ?? "", new FormData(form), form));
    });
  }

  connectedCallback(): void {
    void this.#act(() => this.load());
  }

  disconnectedCallback(): void {
    clearTimeout(this.#timer);
  }

  protected get client(): NodeUiApi {
    return (this.api ??= new NodeUiApi(this.getAttribute("base") ?? "/api/node"));
  }

  protected abstract load(): Promise<void>;
  protected abstract view(): string;
  protected abstract showError(text: string | null): void;
  /** What changes the view without a call: a question on a row, closed by any other action. */
  protected settle(): void {}
  protected abstract busy(): boolean;
  protected async onAction(_action: string, _button: HTMLElement): Promise<void> {}
  protected async onSubmit(_form: string, _data: FormData, _element: HTMLFormElement): Promise<void> {}

  protected input(selector: string): HTMLInputElement | null {
    return this.shadowRoot!.querySelector<HTMLInputElement>(selector);
  }

  async #act(work: () => Promise<void>): Promise<void> {
    clearTimeout(this.#timer);
    this.showError(null);
    try {
      await work();
    } catch (error) {
      this.showError(message(error));
      // A step may have worked before the one that failed, so the view shows what is true now.
      await this.load().catch(() => {});
    }
    this.render();
    if (this.busy() && this.isConnected) this.#timer = setTimeout(() => void this.#poll(), POLL_MS);
  }

  async #poll(): Promise<void> {
    try {
      await this.load();
      this.showError(null);
    } catch (error) {
      this.showError(message(error));
    }
    this.render();
    if (this.busy() && this.isConnected) this.#timer = setTimeout(() => void this.#poll(), POLL_MS);
  }

  /** Draws the view. What the user typed and where the focus is stay across a redraw. */
  protected render(): void {
    const html = this.view();
    if (html === this.#rendered) return;
    this.#rendered = html;
    const typed = new Map<string, string>();
    for (const field of this.#view.querySelectorAll<HTMLInputElement | HTMLSelectElement>("input, select"))
      if (changedByUser(field)) typed.set(keyOf(field), field.value);
    const active = this.shadowRoot!.activeElement;
    const focused = active && this.#view.contains(active) ? keyOf(active) : null;
    this.#view.innerHTML = html;
    for (const field of this.#view.querySelectorAll<HTMLInputElement | HTMLSelectElement>("input, select")) {
      const value = typed.get(keyOf(field));
      if (value !== undefined) field.value = value;
    }
    if (focused) [...this.#view.querySelectorAll<HTMLElement>("input, select, button")].find((element) => keyOf(element) === focused)?.focus();
  }
}

/**
 * <code>&lt;memex-node-packs&gt;</code>: the packs of Node, to install, accept, and remove. Attributes: <code>app</code>,
 * the app id recorded with an acceptance; <code>only</code>, pack ids with commas to show only those.
 */
export class MemexNodePacks extends NodeElement {
  #packs: Pack[] = [];
  #error: string | null = null;
  #confirming: string | null = null;
  #license: { id: string; version: string; sha256: string } | null = null;
  #dialog: HTMLDialogElement | null = null;

  protected async load(): Promise<void> {
    const only = this.getAttribute("only")?.split(",").map((id) => id.trim());
    const packs = await this.client.packs();
    this.#packs = only ? packs.filter((pack) => only.includes(pack.id)) : packs;
  }

  protected view(): string {
    return packsView({ packs: this.#packs, error: this.#error, confirming: this.#confirming });
  }

  protected showError(text: string | null): void {
    this.#error = text;
  }

  protected busy(): boolean {
    return this.#packs.some((pack) => pack.state === "installing");
  }

  /** The dialog is one element outside the drawn view: a refresh keeps its scroll and focus, and it is modal. */
  #open(html: string): void {
    if (!this.#dialog) {
      this.#dialog = document.createElement("dialog");
      this.#dialog.addEventListener("close", () => this.#closed());
      this.shadowRoot!.append(this.#dialog);
    }
    this.#dialog.innerHTML = html;
    this.#dialog.showModal();
  }

  #closed(): void {
    const id = this.#license?.id;
    this.#license = null;
    if (id) this.shadowRoot!.querySelector<HTMLElement>(`[data-action="license"][data-id="${CSS.escape(id)}"]`)?.focus();
  }

  protected override async onAction(action: string, button: HTMLElement): Promise<void> {
    const id = button.dataset.id ?? "";
    const asked = this.#confirming;
    this.#confirming = null;
    switch (action) {
      case "install":
        await this.client.install(id);
        break;
      case "ask-remove":
        this.#confirming = id;
        return;
      case "keep":
        return;
      case "remove":
        if (asked !== id) return;
        await this.client.removePack(id);
        break;
      case "license": {
        // The version and the hash are those of the text that the person reads now.
        const [pack, license] = await Promise.all([this.client.pack(id), this.client.license(id)]);
        if (pack.acceptance?.textSha256 && pack.acceptance.textSha256 !== license.sha256)
          throw new NodeUiError(409, "license_changed", "The license changed while it loaded. Open it again.");
        this.#license = { id, version: pack.manifest?.version ?? pack.versions.at(-1)?.version ?? "", sha256: license.sha256 };
        this.#open(licenseView({ id, title: pack.title, text: license.text }));
        return;
      }
      case "accept": {
        const license = this.#license;
        if (!license) return;
        this.#dialog?.close();
        await this.client.accept(id, { app: this.getAttribute("app") ?? "memex", version: license.version, textSha256: license.sha256 });
        await this.client.install(id);
        break;
      }
      case "close":
        this.#dialog?.close();
        return;
    }
    await this.load();
  }
}

/**
 * <code>&lt;memex-node-backends&gt;</code>: the model servers that the user adds, how many calls each takes at once, and
 * where each function runs.
 */
export class MemexNodeBackends extends NodeElement {
  #backends: Backend[] = [];
  #functions: NodeFunction[] = [];
  #found: FoundBackend[] | null = null;
  #error: string | null = null;
  #confirming: string | null = null;

  protected async load(): Promise<void> {
    [this.#backends, this.#functions] = await Promise.all([this.client.backends(), this.client.functions()]);
  }

  protected view(): string {
    return backendsView({ backends: this.#backends, functions: this.#functions, found: this.#found, error: this.#error, confirming: this.#confirming });
  }

  protected showError(text: string | null): void {
    this.#error = text;
  }

  protected busy(): boolean {
    return false;
  }

  protected override async onAction(action: string, button: HTMLElement): Promise<void> {
    const id = button.dataset.id ?? "";
    const asked = this.#confirming;
    this.#confirming = null;
    switch (action) {
      case "ask-remove":
        this.#confirming = id;
        return;
      case "keep":
        return;
      case "remove":
        if (asked !== id) return;
        await this.client.removeBackend(id);
        break;
      case "limit": {
        const value = this.input(`[data-limit="${CSS.escape(id)}"]`)?.value;
        await this.client.patchBackend(id, { concurrency: value ? Number(value) : null });
        break;
      }
      case "discover":
        this.#found = await this.client.discover();
        return;
      case "add-found":
        await this.client.addBackend({ url: button.dataset.url ?? "", type: "openai" });
        this.#found = null;
        break;
      case "route":
        await this.#saveRoute(id, true);
        break;
      case "one-server":
        await this.#saveRoute(id, false);
        break;
    }
    await this.load();
  }

  protected override async onSubmit(form: string, data: FormData, element: HTMLFormElement): Promise<void> {
    if (form !== "add") return;
    const text = (name: string) => String(data.get(name) ?? "").trim();
    await this.client.addBackend({
      url: text("url"),
      type: "openai",
      ...(text("label") ? { label: text("label") } : {}),
      ...(text("apiKey") ? { apiKey: text("apiKey") } : {}),
      ...(text("concurrency") ? { concurrency: Number(text("concurrency")) } : {}),
    });
    element.reset();
    await this.load();
  }

  async #saveRoute(id: string, keepOthers: boolean): Promise<void> {
    const backend = this.input(`[data-route="${CSS.escape(id)}"]`)?.value ?? "";
    const model = this.input(`[data-model="${CSS.escape(id)}"]`)?.value.trim() ?? "";
    const limit = this.input(`[data-route-limit="${CSS.escape(id)}"]`)?.value;
    const routes = await this.client.routes();
    if (backend) {
      // /v1/functions shows the route that holds, also when it comes from the default.
      const also = this.#functions.find((fn) => fn.id === id)?.route.also;
      const route: Route = { kind: "url", backend, model, ...(limit ? { concurrency: Number(limit) } : {}) };
      if (keepOthers && also?.length) route.also = also;
      routes.functions[id] = route;
    } else if (routes.default.kind === "auto") {
      delete routes.functions[id];
    } else {
      routes.functions[id] = { kind: "auto" };
    }
    await this.client.putRoutes(routes);
  }
}

/** <code>&lt;memex-node-location&gt;</code>: where the pack store is, and the move to another folder with its sync warning. */
export class MemexNodeLocation extends NodeElement {
  #location: PackLocation | null = null;
  #error: string | null = null;

  protected async load(): Promise<void> {
    this.#location = await this.client.location();
  }

  protected view(): string {
    return locationView({ location: this.#location, error: this.#error });
  }

  protected showError(text: string | null): void {
    this.#error = text;
  }

  protected busy(): boolean {
    return moving(this.#location);
  }

  protected override async onSubmit(form: string, data: FormData): Promise<void> {
    if (form !== "move") return;
    this.#location = await this.client.move(String(data.get("path") ?? "").trim());
  }
}

/** Defines the three elements once. */
export function defineMemexNodeElements(registry: CustomElementRegistry = customElements): void {
  for (const [name, element] of [["memex-node-packs", MemexNodePacks], ["memex-node-backends", MemexNodeBackends], ["memex-node-location", MemexNodeLocation]] as const) {
    if (!registry.get(name)) registry.define(name, element);
  }
}
