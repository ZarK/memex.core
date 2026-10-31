import { describe, expect, it } from "vitest";
import { NodeUiApi, NodeUiError, type Backend, type NodeFunction, type Pack } from "../src/api.js";
import { backendsView, escapeHtml, formatBytes, licenseView, locationView, packsView } from "../src/views.js";
import { isNodeUiRoute } from "../src/server.js";

const pack = (fields: Partial<Pack>): Pack => ({
  id: "yunet-2023mar", title: "YuNet", kind: "model", state: "not-installed", active: null,
  versions: [{ version: "1", digest: "a".repeat(64), bytes: 232_000, installed: false }],
  license: { spdx: "MIT" }, install: null, path: null, usedBy: [], ...fields,
});

const backend = (fields: Partial<Backend> = {}): Backend => ({
  id: "bk_1", type: "openai", url: "http://127.0.0.1:8080/v1", label: "Reader", local: true, state: "available",
  models: [{ id: "reader", capabilities: ["chat", "vision"] }], concurrency: 2, concurrencyFrom: "reported", hasKey: false, ...fields,
});

const fn = (fields: Partial<NodeFunction> = {}): NodeFunction => ({
  id: "photos.food-reading", app: "photos", capabilities: ["food.recognize"], runsIn: "node", route: { kind: "auto" }, state: "ready", ...fields,
});

describe("views", () => {
  it("escapes what comes from Node", () => {
    expect(escapeHtml(`<img src=x onerror="a">`)).toBe("&#60;img src=x onerror=&#34;a&#34;&#62;");
    const html = packsView({ packs: [pack({ title: "<b>x</b>", license: { spdx: "<i>" } })], error: "<script>" });
    expect(html).not.toContain("<b>x");
    expect(html).not.toContain("<i>");
    expect(html).not.toContain("<script>");
    expect(backendsView({ backends: [backend({ label: `"><img>` })], functions: [] })).not.toContain("<img>");
  });

  it("shows bytes for people", () => {
    expect(formatBytes(999)).toBe("999 bytes");
    expect(formatBytes(1_500_000)).toBe("1.5 MB");
    expect(formatBytes(376_080_700)).toBe("376 MB");
  });

  it("offers what each pack state allows", () => {
    expect(packsView({ packs: [pack({})] })).toContain(`data-action="install"`);
    expect(packsView({ packs: [pack({ state: "needs-acceptance" })] })).toContain(`data-action="license"`);
    expect(packsView({ packs: [pack({ state: "installed", usedBy: ["photos"] })] })).toContain(`data-action="ask-remove"`);
    const asked = packsView({ packs: [pack({ state: "installed" })], confirming: "yunet-2023mar" });
    expect(asked).toContain("to download again");
    expect(asked).toContain(`data-action="remove"`);
    const failed = packsView({ packs: [pack({ install: { version: "1", phase: "failed", bytesDone: 0, bytesTotal: 0, error: { code: "x", message: "No space." } } })] });
    expect(failed).toContain("No space.");
    const refused = packsView({ packs: [pack({ state: "refused" })] });
    expect(refused).toContain("License not known");
    expect(refused).not.toContain("<button");
    expect(packsView({ packs: [pack({ state: "installing", install: { version: "1", bytesDone: 5, bytesTotal: 10 } })] })).toContain("<progress");
    expect(packsView({ packs: [pack({ state: "installed", install: { version: "1", bytesDone: 10, bytesTotal: 10 } })] })).not.toContain("<progress");
  });

  it("shows a license before it can be accepted", () => {
    const html = licenseView({ id: "yunet-2023mar", title: "YuNet", text: "Terms & more" });
    expect(html).toContain("Terms &#38; more");
    expect(html).toContain(`data-action="accept"`);
  });

  it("says where the limit of a server comes from", () => {
    expect(backendsView({ backends: [backend()], functions: [] })).toContain("2 at once (reported by the server)");
    expect(backendsView({ backends: [backend({ concurrencyFrom: "learned" })], functions: [] })).toContain("learned by Memex Node");
    expect(backendsView({ backends: [backend({ hasKey: true })], functions: [], confirming: "bk_1" })).toContain("Its stored key is deleted too.");
    const set = backendsView({ backends: [backend({ concurrencyFrom: "set" })], functions: [] });
    expect(set).toContain(`data-limit="bk_1" value="2"`);
  });

  it("lists functions with their route, and keeps more servers", () => {
    const html = backendsView({
      backends: [backend()],
      functions: [fn({ route: { kind: "url", backend: "bk_1", model: "reader", also: [{ backend: "bk_2", model: "reader" }] } }), fn({ id: "photos.library-analysis", runsIn: "app" })],
    });
    expect(html).toContain("photos.food-reading");
    expect(html).not.toContain("library-analysis");
    expect(html).toContain(`<option value="bk_1" selected>`);
    expect(html).toContain("and 1 more server");
    expect(html).toContain(`data-action="one-server"`);
    const inNode = backendsView({ backends: [backend()], functions: [fn({ id: "photos.tools", capabilities: ["image.upscale"] })] });
    expect(inNode).toContain("Runs in Memex Node");
    expect(inNode).not.toContain("data-route=");
  });

  it("shows the store, a move, and a sync warning", () => {
    const html = locationView({ location: { path: "/old/packs", move: { to: "/new/packs", bytesDone: 1, bytesTotal: 2 }, warning: { client: "OneDrive" } } });
    expect(html).toContain("/old/packs");
    expect(html).toContain("Moving to /new/packs");
    expect(html).toContain("OneDrive synchronizes this folder.");
    expect(html).toContain("disabled");
    const ended = locationView({ location: { path: "/new/packs", move: { to: "/new/packs", phase: "done", bytesDone: 2, bytesTotal: 2 }, warning: null } });
    expect(ended).not.toContain("Moving to");
    expect(ended).not.toContain("disabled");
    const failed = locationView({ location: { path: "/old/packs", move: { to: "/new/packs", phase: "failed", bytesDone: 0, bytesTotal: 0, error: { code: "x", message: "No space on D." } }, warning: null } });
    expect(failed).toContain("No space on D.");
    const started = locationView({ location: { path: "/old/packs", move: null, warning: null, target: { warning: { client: "OneDrive", text: "OneDrive will upload 4 GB." } } } });
    expect(started).toContain("OneDrive will upload 4 GB.");
  });
});

describe("the passage to Node", () => {
  it("passes the settings and nothing else", () => {
    for (const [method, path] of [["GET", "/v1/packs"], ["POST", "/v1/packs/x/install"], ["PUT", "/v1/routes"], ["PATCH", "/v1/backends/bk_1"], ["GET", "/v1/packs/location"]] as const)
      expect(isNodeUiRoute(method, path), `${method} ${path}`).toBe(true);
    for (const [method, path] of [["POST", "/v1/run"], ["POST", "/v1/drain"], ["POST", "/v1/leases"], ["GET", "/v1/packs/x/y/z"], ["PUT", "/v1/packs"], ["POST", "/v1/chat/completions"], ["GET", "/v1/packs/x?a=/install"], ["POST", "/v1/packs/../drain/install"], ["GET", "/v1/packs/..%2Fdrain"]] as const)
      expect(isNodeUiRoute(method, path), `${method} ${path}`).toBe(false);
  });
});

describe("the api of the elements", () => {
  it("gives a refusal of Node with its message and hint", async () => {
    const api = new NodeUiApi("/api/node", async () => new Response(JSON.stringify({ error: { code: "backend_in_use", message: "A route uses it.", hint: "Change the route." } }), { status: 409 }));
    const failed = await api.removeBackend("bk_1").catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(NodeUiError);
    expect((failed as NodeUiError).code).toBe("backend_in_use");
    expect((failed as NodeUiError).hint).toBe("Change the route.");
  });

  it("calls the path under its base and sends JSON", async () => {
    const calls: [string, RequestInit | undefined][] = [];
    const api = new NodeUiApi("/settings/node", async (input, init) => {
      calls.push([String(input), init]);
      return new Response("{}", { status: 200 });
    });
    await api.patchBackend("bk 1", { concurrency: null });
    expect(calls[0]![0]).toBe("/settings/node/v1/backends/bk%201");
    expect(calls[0]![1]?.body).toBe(`{"concurrency":null}`);
  });
});
