import type { IncomingMessage } from "node:http";
import { SurfaceError, errorFromBody } from "@tjalve/memex-surfaces";
import { NodeApiBase, type NodeBinary, type NodeEvent, type OperationRequest } from "./generated/node-api.js";
import type { Launch } from "./launcher.js";
import { isConnectError, openRequest, readEvents, sendRequest, type Endpoint, type RawRequest, type RawResponse } from "./transport.js";

export interface NodeClientOptions {
  /**
   * Finds the endpoint again: after a connection fails, or when Node answers 503 draining (a newer copy takes over).
   * ensureNode passes itself here, so a client follows Node across restarts. Without it, such a request fails.
   */
  reconnect?: () => Promise<Endpoint>;
  /** Gives up when no answer starts in this time. Default 60 s. */
  timeoutMs?: number;
  /** What the launcher did to reach Node (ensureNode sets it). */
  launch?: Launch;
}

/**
 * The Memex.Node API over the pipe or socket of the app record. Every operation of openapi/node.v1.yaml is a method
 * (NodeApiBase is generated from it). A failed call throws a SurfaceError with Node's error body.
 */
export class NodeClient extends NodeApiBase {
  #endpoint: Endpoint;
  readonly #options: NodeClientOptions;
  /**
   * The endpoint of the Node that granted each lease. A lease lives in that Node only, and a draining Node still serves
   * it (node-api.md, Drain), so the calls on a lease (getLease, renewLease, releaseLease, leaseEvents) stay there after
   * the client follows a newer copy.
   */
  readonly #leases = new Map<string, Endpoint>();

  constructor(endpoint: Endpoint, options: NodeClientOptions = {}) {
    super();
    this.#endpoint = endpoint;
    this.#options = options;
  }

  /** What the launcher did to reach Node, when ensureNode made this client. */
  get launch(): Launch | undefined {
    return this.#options.launch;
  }

  /** The endpoint that the client uses now. */
  get endpoint(): Endpoint {
    return this.#endpoint;
  }

  /**
   * Sends one request as it is and returns the answer whatever its status, and follows Node like the operations do: to
   * a new endpoint after an idle stop or a drain. For a passage to Node, such as the settings of an app's page.
   */
  async request(request: RawRequest): Promise<RawResponse> {
    const { ok } = await this.#retry(async (endpoint) => {
      const answer = await sendRequest(endpoint, { timeoutMs: this.#options.timeoutMs, ...request });
      return answer.status >= 400 ? { ok: answer, failed: { status: answer.status, body: answer.body } } : { ok: answer };
    });
    return ok;
  }

  protected async send(op: OperationRequest): Promise<unknown> {
    const raw = this.#raw(op);
    const leaseId = leaseIdOf(op.path);
    const pinned = leaseId === undefined ? undefined : this.#leases.get(leaseId);
    let used: Endpoint = this.#endpoint;
    const run = <T extends { failed?: { status: number; body: Buffer } }>(attempt: (endpoint: Endpoint) => Promise<T>): Promise<T> => {
      if (pinned) return attempt(pinned);
      return this.#retry((endpoint) => {
        used = endpoint;
        return attempt(endpoint);
      });
    };
    if (op.response === "events") {
      const res = await run(async (endpoint) => {
        const r = await openRequest(endpoint, { ...raw, timeoutMs: this.#options.timeoutMs });
        if (r.statusCode !== op.status) {
          const chunks: Buffer[] = [];
          for await (const c of r) chunks.push(c as Buffer);
          return { failed: { status: r.statusCode ?? 0, body: Buffer.concat(chunks) } } as { ok?: IncomingMessage; failed?: { status: number; body: Buffer } };
        }
        return { ok: r };
      });
      if (res.failed) throw toError(res.failed.status, res.failed.body);
      return readEvents(res.ok!) as AsyncIterable<NodeEvent>;
    }
    let answer: { ok?: RawResponse; failed?: { status: number; body: Buffer } };
    try {
      answer = await run(async (endpoint) => {
        const r = await sendRequest(endpoint, { ...raw, timeoutMs: this.#options.timeoutMs });
        return r.status === op.status ? { ok: r } : { failed: { status: r.status, body: r.body } };
      });
    } catch (error) {
      // The Node that held the lease is gone, and the lease with it.
      if (leaseId !== undefined && pinned && isConnectError(error)) this.#leases.delete(leaseId);
      throw error;
    }
    if (answer.failed) {
      if (leaseId !== undefined && answer.failed.status === 404) this.#leases.delete(leaseId);
      throw toError(answer.failed.status, answer.failed.body);
    }
    const res = answer.ok!;
    if (op.operation === "createLease") {
      const id = (JSON.parse(res.body.toString("utf8")) as { lease?: { id?: unknown } }).lease?.id;
      if (typeof id === "string") this.#leases.set(id, used);
    } else if (op.operation === "releaseLease" && leaseId !== undefined) {
      this.#leases.delete(leaseId);
    }
    switch (op.response) {
      case "json":
        return res.body.length ? JSON.parse(res.body.toString("utf8")) : null;
      case "text":
        return res.body.toString("utf8");
      case "bytes":
        return { mediaType: res.headers["content-type"] ?? "application/octet-stream", bytes: new Uint8Array(res.body), headers: res.headers } satisfies NodeBinary;
      default:
        return undefined;
    }
  }

  #raw(op: OperationRequest): RawRequest {
    const query = Object.entries(op.query ?? {}).filter((e): e is [string, string] => e[1] !== undefined);
    const path = query.length ? `${op.path}?${new URLSearchParams(query).toString()}` : op.path;
    const headers: Record<string, string> = { accept: op.response === "events" ? "text/event-stream" : "application/json" };
    for (const [k, v] of Object.entries(op.headers ?? {})) if (v !== undefined) headers[k.toLowerCase()] = v;
    let body: Uint8Array | undefined;
    if (op.body?.kind === "json") {
      body = Buffer.from(JSON.stringify(op.body.value), "utf8");
      headers["content-type"] = "application/json";
    } else if (op.body?.kind === "bytes") {
      body = op.body.value;
      headers["content-type"] = op.body.mediaType;
    }
    return { method: op.method, path, headers, body };
  }

  /**
   * Runs a request; when the connection certainly did not reach Node (isConnectError), or Node answers 503 draining, it
   * finds Node again through reconnect and sends the request once more. A draining Node refuses work before it starts
   * it, and a failure after the request may have reached Node is not retried, so nothing runs twice.
   */
  async #retry<T extends { failed?: { status: number; body: Buffer } }>(attempt: (endpoint: Endpoint) => Promise<T>): Promise<T> {
    let result: T;
    try {
      result = await attempt(this.#endpoint);
    } catch (error) {
      if (!this.#options.reconnect || !isConnectError(error)) throw error;
      this.#endpoint = await this.#options.reconnect();
      return attempt(this.#endpoint);
    }
    if (result.failed && this.#options.reconnect && isDraining(result.failed.status, result.failed.body)) {
      this.#endpoint = await this.#options.reconnect();
      return attempt(this.#endpoint);
    }
    return result;
  }
}

/** The lease id of a call on one lease: /v1/leases/{id} and the paths under it. */
function leaseIdOf(path: string): string | undefined {
  const match = /^\/v1\/leases\/([^/?]+)/.exec(path);
  return match ? decodeURIComponent(match[1]!) : undefined;
}

function isDraining(status: number, body: Buffer): boolean {
  if (status !== 503) return false;
  try {
    return (JSON.parse(body.toString("utf8")) as { error?: { code?: string } }).error?.code === "draining";
  } catch {
    return false;
  }
}

function toError(status: number, body: Buffer): SurfaceError {
  let value: unknown = null;
  try {
    value = body.length ? JSON.parse(body.toString("utf8")) : null;
  } catch {
    return new SurfaceError(status >= 500 ? "internal" : "rejected", `Memex Node answered with status ${status} and a body that is not JSON.`, { status });
  }
  return errorFromBody(value, status);
}

