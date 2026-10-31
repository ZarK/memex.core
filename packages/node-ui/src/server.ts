import type { NodeClient } from "@tjalve/memex-node-client";

/**
 * A browser cannot reach the pipe or socket of Memex.Node, so the app's own server passes the settings calls on. Only
 * these routes pass: the settings of Node (node-api.md), and no work, leases, or drain.
 */
const ID = "[a-z0-9][a-z0-9._-]*";

const ALLOWED: ReadonlyArray<readonly [string, RegExp]> = [
  ["GET", /^\/v1\/packs$/],
  ["GET", /^\/v1\/packs\/location$/],
  ["PUT", /^\/v1\/packs\/location$/],
  ["GET", new RegExp(`^/v1/packs/${ID}$`)],
  ["DELETE", new RegExp(`^/v1/packs/${ID}$`)],
  ["POST", new RegExp(`^/v1/packs/${ID}/install$`)],
  ["GET", new RegExp(`^/v1/packs/${ID}/license$`)],
  ["POST", new RegExp(`^/v1/packs/${ID}/accept$`)],
  ["GET", /^\/v1\/backends$/],
  ["POST", /^\/v1\/backends$/],
  ["POST", /^\/v1\/backends\/discover$/],
  ["PATCH", new RegExp(`^/v1/backends/${ID}$`)],
  ["DELETE", new RegExp(`^/v1/backends/${ID}$`)],
  ["GET", /^\/v1\/functions$/],
  ["GET", /^\/v1\/routes$/],
  ["PUT", /^\/v1\/routes$/],
];

export interface NodeUiRequest {
  method: string;
  /** The Node path, for example /v1/packs, with no query. */
  path: string;
  body?: Uint8Array;
}

export interface NodeUiResponse {
  status: number;
  contentType: string;
  body: Uint8Array;
}

export function isNodeUiRoute(method: string, path: string): boolean {
  return ALLOWED.some(([m, pattern]) => m === method && pattern.test(path));
}

/**
 * Passes one call of the elements to Node. Mount it behind the app's own session check, under the path that the
 * elements use (<code>base</code>, default <code>/api/node</code>), and hand it the rest of the path.
 */
export async function nodeUiCall(client: NodeClient, request: NodeUiRequest): Promise<NodeUiResponse> {
  if (!isNodeUiRoute(request.method, request.path)) {
    const refused = { error: { code: "not_found", message: `The Node settings have no ${request.method} ${request.path}.` } };
    return { status: 404, contentType: "application/json", body: Buffer.from(JSON.stringify(refused)) };
  }
  try {
    const answer = await client.request({
      method: request.method,
      path: request.path,
      headers: request.body?.length ? { "content-type": "application/json" } : {},
      body: request.body?.length ? request.body : undefined,
    });
    return { status: answer.status, contentType: answer.headers["content-type"] ?? "application/json", body: answer.body };
  } catch {
    const unavailable = { error: { code: "unavailable", message: "Memex Node does not answer." } };
    return { status: 503, contentType: "application/json", body: Buffer.from(JSON.stringify(unavailable)) };
  }
}
