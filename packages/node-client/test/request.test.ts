import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { NodeClient } from "../src/index.js";

const servers: http.Server[] = [];

async function serve(handler: http.RequestListener): Promise<number> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

const endpoint = (port: number) => ({ url: `http://127.0.0.1:${port}`, token: "t" });

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

describe("NodeClient.request", () => {
  it("returns a refusal as it is", async () => {
    const port = await serve((_req, res) => void res.writeHead(409, { "content-type": "application/json" }).end(`{"error":{"code":"x"}}`));
    const answer = await new NodeClient(endpoint(port)).request({ method: "GET", path: "/v1/packs" });
    expect(answer.status).toBe(409);
    expect(answer.body.toString()).toContain(`"x"`);
  });

  it("follows Node to a new endpoint after an idle stop and after a drain", async () => {
    const live = await serve((_req, res) => void res.writeHead(200).end("ok"));
    const stopped = await serve(() => {});
    servers[1]!.close();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const afterStop = new NodeClient(endpoint(stopped), { reconnect: async () => endpoint(live) });
    expect((await afterStop.request({ method: "GET", path: "/v1/packs" })).status).toBe(200);

    const draining = await serve((_req, res) => void res.writeHead(503, { "content-type": "application/json" }).end(`{"error":{"code":"draining","message":"d"}}`));
    const afterDrain = new NodeClient(endpoint(draining), { reconnect: async () => endpoint(live) });
    expect((await afterDrain.request({ method: "GET", path: "/v1/packs" })).status).toBe(200);
  });
});
