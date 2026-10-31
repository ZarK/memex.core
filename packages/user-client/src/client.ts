import { isConnectError, sendRequest, type Endpoint, type Launch, type RawRequest } from "@tjalve/memex-node-client";
import { SurfaceError, errorFromBody } from "@tjalve/memex-surfaces";
import { ContactsApiBase, type ContactsOperationRequest } from "./generated/contacts-api.js";
import { UserApiBase, type UserOperationRequest } from "./generated/user-api.js";
import type { Hub } from "./corrections.js";

export interface HubClientOptions {
  /**
   * Finds the endpoint again after a connection fails (the hub stopped at its idle exit, or started on a new port), or
   * when the hub answers 503 draining (a newer copy takes over).
   * ensureUser passes itself here, so a client follows the hub across restarts. Without it, such a request fails.
   */
  reconnect?: () => Promise<Endpoint>;
  /** Gives up when no answer starts in this time. Default 30 s. */
  timeoutMs?: number;
  /** What the launcher did to reach the hub (ensureUser sets it). */
  launch?: Launch;
}

type AnyRequest = UserOperationRequest | ContactsOperationRequest;

/** The transport that both hub clients share: loopback HTTP with the token of the app record. */
class Transport {
  constructor(
    readonly hub: Hub,
    public endpoint: Endpoint,
    readonly options: HubClientOptions,
  ) {}

  async send(op: AnyRequest): Promise<unknown> {
    const raw: RawRequest = { method: op.method, path: op.path, headers: { accept: "application/json" }, timeoutMs: this.options.timeoutMs ?? 30_000 };
    if (op.body !== undefined) {
      raw.body = Buffer.from(JSON.stringify(op.body), "utf8");
      raw.headers!["content-type"] = "application/json";
    }
    let answer;
    try {
      answer = await sendRequest(this.endpoint, raw);
    } catch (error) {
      // Only when the request certainly did not reach the hub (surfaces.md, Service launcher): it is sent once more.
      if (!this.options.reconnect || !isConnectError(error)) throw error;
      this.endpoint = await this.options.reconnect();
      answer = await sendRequest(this.endpoint, raw);
    }
    // A draining hub refuses the call before it starts it (503 draining): it is sent once more to the newer copy.
    if (this.options.reconnect && isDraining(answer.status, answer.body)) {
      this.endpoint = await this.options.reconnect();
      answer = await sendRequest(this.endpoint, raw);
    }
    let value: unknown = null;
    if (answer.body.length) {
      try {
        value = JSON.parse(answer.body.toString("utf8"));
      } catch {
        throw new SurfaceError(answer.status >= 500 ? "internal" : "rejected", `Memex ${this.hub} answered with status ${answer.status} and a body that is not JSON.`, {
          status: answer.status,
        });
      }
    }
    if (answer.status !== 200) throw errorFromBody(value, answer.status);
    return value;
  }
}

/** The Memex.User API over the loopback URL and token of the app record user.json. A failed call throws a SurfaceError. */
export class UserClient extends UserApiBase {
  readonly hub = "user" as const;
  readonly #transport: Transport;

  constructor(endpoint: Endpoint, readonly options: HubClientOptions = {}) {
    super();
    this.#transport = new Transport("user", endpoint, options);
  }

  get endpoint(): Endpoint {
    return this.#transport.endpoint;
  }

  get launch(): Launch | undefined {
    return this.options.launch;
  }

  protected send(request: UserOperationRequest): Promise<unknown> {
    return this.#transport.send(request);
  }
}

/** The facts API of Memex.Contacts over the loopback URL and token of the app record contacts.json. */
export class ContactsClient extends ContactsApiBase {
  readonly hub = "contacts" as const;
  readonly #transport: Transport;

  constructor(endpoint: Endpoint, readonly options: HubClientOptions = {}) {
    super();
    this.#transport = new Transport("contacts", endpoint, options);
  }

  get endpoint(): Endpoint {
    return this.#transport.endpoint;
  }

  get launch(): Launch | undefined {
    return this.options.launch;
  }

  protected send(request: ContactsOperationRequest): Promise<unknown> {
    return this.#transport.send(request);
  }
}

export type HubClient = UserClient | ContactsClient;

function isDraining(status: number, body: Buffer): boolean {
  if (status !== 503) return false;
  try {
    return (JSON.parse(body.toString("utf8")) as { error?: { code?: string } }).error?.code === "draining";
  } catch {
    return false;
  }
}
