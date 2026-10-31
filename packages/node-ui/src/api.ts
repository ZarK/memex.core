/** What the elements read of Node (openapi/node.v1.yaml). The browser bundle imports no Node code. */
export interface PackVersion {
  version: string;
  digest: string;
  bytes: number;
  installed: boolean;
}

export interface Pack {
  id: string;
  title: string;
  kind: string;
  state: "not-installed" | "installing" | "installed" | "needs-acceptance" | "refused";
  active: string | null;
  versions: PackVersion[];
  license: { spdx?: string; attribution?: string; url?: string };
  acceptance?: { needed: boolean; textSha256: string | null };
  install: { version: string; phase?: string; bytesDone: number; bytesTotal: number; error?: { code: string; message: string } | null } | null;
  path: string | null;
  usedBy: string[];
  manifest?: { version: string };
}

export interface PackLocation {
  path: string;
  move: { to: string; phase?: string; bytesDone: number; bytesTotal: number; error?: { code: string; message: string } | null } | null;
  warning: { client: string; text?: string } | null;
  target?: { path?: string; warning?: { client: string; text?: string } | null };
}

/** A move that still works: Node keeps the last move after it ends. */
export const moving = (location: PackLocation | null): boolean =>
  location?.move != null && (location.move.phase === undefined || ["copying", "checking", "removing"].includes(location.move.phase));

export interface BackendModel {
  id: string;
  capabilities: string[];
}

export interface Backend {
  id: string;
  type: string;
  url: string;
  label: string;
  local: boolean;
  state: "available" | "unavailable";
  models: BackendModel[];
  concurrency: number;
  concurrencyFrom?: "set" | "reported" | "learned";
  hasKey: boolean;
  warning?: string;
}

export interface FoundBackend {
  url: string;
  type: string;
  models: BackendModel[];
}

export interface RouteTarget {
  backend: string;
  model: string;
  concurrency?: number;
}

export interface Route {
  kind: "auto" | "url";
  backend?: string;
  model?: string;
  concurrency?: number;
  also?: RouteTarget[];
}

export interface Routes {
  default: Route;
  functions: Record<string, Route>;
}

export interface NodeFunction {
  id: string;
  app: string;
  capabilities: string[];
  runsIn: string;
  route: Route;
  state: string;
  reason?: string;
}

/** A refusal of Node, with the message of its error body. */
export class NodeUiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly hint?: string) {
    super(message);
    this.name = "NodeUiError";
  }
}

/** The settings calls of the elements, through the app's own server (see the <code>./server</code> entry). */
export class NodeUiApi {
  constructor(private readonly base = "/api/node", private readonly fetcher: typeof fetch = (input, init) => fetch(input, init)) {}

  async #call(method: string, path: string, body?: unknown): Promise<Response> {
    const response = await this.fetcher(`${this.base}${path}`, {
      method,
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    if (response.ok) return response;
    const answer = (await response.json().catch(() => null)) as { error?: { code?: string; message?: string; hint?: string } } | null;
    throw new NodeUiError(response.status, answer?.error?.code ?? "unavailable", answer?.error?.message ?? `Memex Node answered ${response.status}.`, answer?.error?.hint);
  }

  async #json<T>(method: string, path: string, body?: unknown): Promise<T> {
    return (await (await this.#call(method, path, body)).json()) as T;
  }

  async packs(): Promise<Pack[]> {
    return (await this.#json<{ items: Pack[] }>("GET", "/v1/packs")).items;
  }

  pack(id: string): Promise<Pack> {
    return this.#json("GET", `/v1/packs/${encodeURIComponent(id)}`);
  }

  /** The license as Node has it: the text for the person, and the hash of these very bytes for the acceptance. */
  async license(id: string): Promise<{ text: string; sha256: string }> {
    const bytes = await (await this.#call("GET", `/v1/packs/${encodeURIComponent(id)}/license`)).arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return {
      text: new TextDecoder().decode(bytes),
      sha256: [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join(""),
    };
  }

  async accept(id: string, body: { app: string; version: string; textSha256: string }): Promise<void> {
    await this.#call("POST", `/v1/packs/${encodeURIComponent(id)}/accept`, body);
  }

  async install(id: string, version?: string): Promise<void> {
    await this.#call("POST", `/v1/packs/${encodeURIComponent(id)}/install`, version ? { version } : {});
  }

  async removePack(id: string): Promise<void> {
    await this.#call("DELETE", `/v1/packs/${encodeURIComponent(id)}`);
  }

  location(): Promise<PackLocation> {
    return this.#json("GET", "/v1/packs/location");
  }

  move(path: string): Promise<PackLocation> {
    return this.#json("PUT", "/v1/packs/location", { path });
  }

  async backends(): Promise<Backend[]> {
    return (await this.#json<{ items: Backend[] }>("GET", "/v1/backends")).items;
  }

  addBackend(body: { url: string; type: "openai"; label?: string; apiKey?: string; concurrency?: number }): Promise<Backend> {
    return this.#json("POST", "/v1/backends", body);
  }

  async patchBackend(id: string, body: { concurrency?: number | null }): Promise<void> {
    await this.#call("PATCH", `/v1/backends/${encodeURIComponent(id)}`, body);
  }

  async removeBackend(id: string): Promise<void> {
    await this.#call("DELETE", `/v1/backends/${encodeURIComponent(id)}`);
  }

  async discover(): Promise<FoundBackend[]> {
    return (await this.#json<{ items: FoundBackend[] }>("POST", "/v1/backends/discover", {})).items;
  }

  async functions(): Promise<NodeFunction[]> {
    return (await this.#json<{ items: NodeFunction[] }>("GET", "/v1/functions")).items;
  }

  routes(): Promise<Routes> {
    return this.#json("GET", "/v1/routes");
  }

  putRoutes(routes: Routes): Promise<Routes> {
    return this.#json("PUT", "/v1/routes", routes);
  }
}
