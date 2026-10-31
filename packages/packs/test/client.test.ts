import { createHash } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { NodeClient } from "@tjalve/memex-node-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PacksClient } from "../src/index.js";

// A stand-in for the pack routes of Memex.Node over loopback with a token, as `memex-node --dev-loopback` serves them.
// The proof against the real Node build is in the step report; this keeps the client's protocol covered in CI.
const TOKEN = "test-token";
const LICENSE = "You may use this model for testing.\n";
const LICENSE_SHA = createHash("sha256").update(LICENSE, "utf8").digest("hex");

interface FakePack {
  id: string;
  title: string;
  kind: "model";
  state: string;
  active: string | null;
  versions: unknown[];
  license: Record<string, unknown>;
  acceptance: { needed: boolean; textSha256: string | null };
  install: Record<string, unknown> | null;
  path: string | null;
  usedBy: string[];
}
const packs = new Map<string, FakePack>();
const accepted: unknown[] = [];
let failNext = false;

function pack(id: string, gated: boolean): FakePack {
  return { id, title: id, kind: "model", state: gated ? "needs-acceptance" : "not-installed", active: null, versions: [], license: { spdx: "MIT" }, acceptance: { needed: gated, textSha256: gated ? LICENSE_SHA : null }, install: null, path: null, usedBy: [] };
}

let server: http.Server;
let url: string;
beforeAll(async () => {
  packs.set("small", pack("small", false));
  packs.set("gated", pack("gated", true));
  server = http.createServer(async (req, res) => {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(401, { error: { code: "unauthorized", message: "no token" } });
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
    const m = /^\/v1\/packs(?:\/([^/]+))?(?:\/([a-z]+))?$/.exec(req.url ?? "");
    if (!m) return json(404, { error: { code: "not_found", message: "no route" } });
    const [, id, action] = m;
    if (id === undefined) return json(200, { items: [...packs.values()] });
    const p = packs.get(id);
    if (p === undefined) return json(404, { error: { code: "not_found", message: `No pack ${id}.` } });
    if (action === undefined && req.method === "GET") return json(200, p);
    if (action === "license") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      return res.end(LICENSE);
    }
    if (action === "accept") {
      if (body.textSha256 !== LICENSE_SHA) return json(409, { error: { code: "license_changed", message: "other text" } });
      accepted.push(body);
      p.acceptance.needed = false;
      p.state = "not-installed";
      return json(200, p);
    }
    if (action === "install") {
      if (p.acceptance.needed) return json(409, { error: { code: "acceptance_required", message: "accept first", hint: "Show the license." } });
      p.state = "installing";
      p.install = { version: "1", phase: "downloading", file: "model.onnx", bytesDone: 0, bytesTotal: 300, resumedAt: 0, startedAt: "2026-10-26T00:00:00Z", error: null };
      return json(202, p);
    }
    if (action === "events") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = () => res.write(`event: pack\ndata: ${JSON.stringify(p)}\n\n`);
      send();
      for (const done of [100, 200, 300]) {
        await new Promise((r) => setTimeout(r, 10));
        p.install = { ...p.install, bytesDone: done };
        send();
      }
      if (failNext) {
        failNext = false;
        p.state = "not-installed";
        p.install = { ...p.install, phase: "failed", error: { code: "checksum_mismatch", message: "model.onnx does not match twice" } };
      } else {
        p.state = "installed";
        p.active = "1";
        p.path = `C:\\Packs\\${id}\\1-abcdef12`;
        p.install = { ...p.install, phase: "done" };
      }
      send();
      return res.end();
    }
    return json(404, { error: { code: "not_found", message: "no route" } });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const client = () => new PacksClient(new NodeClient({ url, token: TOKEN }));

describe("PacksClient", () => {
  it("lists the catalog and the state of a pack", async () => {
    const c = client();
    expect((await c.catalog()).map((p) => p.id)).toEqual(["small", "gated"]);
    expect((await c.status("small")).state).toBe("not-installed");
    expect(await c.activePath("small")).toBeNull();
    expect(await c.activePath("nothing-here")).toBeNull();
  });
  it("installs with progress until the pack is installed", async () => {
    const c = client();
    const seen: number[] = [];
    const done = await c.install("small", { onProgress: (_p, i) => seen.push(Number(i?.bytesDone ?? -1)) });
    expect(done.state).toBe("installed");
    expect(seen).toEqual([0, 0, 100, 200, 300, 300]);
    expect(await c.activePath("small")).toBe("C:\\Packs\\small\\1-abcdef12");
  });
  it("accepts a license by the hash of the text the user read", async () => {
    const c = client();
    await expect(c.install("gated")).rejects.toMatchObject({ code: "acceptance_required", status: 409 });
    const license = await c.license("gated");
    expect(license).toEqual({ text: LICENSE, textSha256: LICENSE_SHA });
    await expect(c.accept("gated", { app: "photos", version: "1", text: "another text" })).rejects.toMatchObject({ code: "license_changed" });
    const after = await c.accept("gated", { app: "photos", version: "1", text: license.text });
    expect(after.acceptance.needed).toBe(false);
    expect(accepted).toEqual([{ app: "photos", version: "1", textSha256: LICENSE_SHA }]);
    failNext = true;
    await expect(c.install("gated")).rejects.toMatchObject({ code: "checksum_mismatch" });
    expect((await c.install("gated")).state).toBe("installed");
  });
});
