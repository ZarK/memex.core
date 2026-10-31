import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as lib from "../src/index.js";
import { AuthCodes, checkRequest, cookieName, localRequest, newToken, routeKind, startServer, tokenCookie, type SurfaceServer } from "../src/index.js";
import { demoRegistry } from "./fixtures/demo-registry.mjs";

const registry = demoRegistry(lib);
const token = newToken();
const guard = { app: "contacts", port: 5000, token };
const host = "127.0.0.1:5000";

describe("checkRequest", () => {
  const check = (method: string, kind: lib.RouteKind, headers: Record<string, string>) => checkRequest({ method, headers }, kind, guard)?.body.error.code ?? null;

  it("makes a token of 32 bytes in base64url without padding", () => {
    expect(newToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newToken()).not.toBe(newToken());
  });

  it("knows the kind of each path", () => {
    expect(routeKind("/health")).toBe("health");
    expect(routeKind("/auth")).toBe("auth");
    expect(routeKind("/api/v1")).toBe("api");
    expect(routeKind("/api/v1/contacts.persons.list")).toBe("api");
    expect(routeKind("/api/v1/uploads")).toBe("upload");
    expect(routeKind("/api/v1x")).toBe("ui");
    expect(routeKind("/")).toBe("ui");
  });

  it("checks Host first, also on /health", () => {
    expect(check("GET", "health", { host })).toBeNull();
    expect(check("GET", "health", { host: "localhost:5000" })).toBeNull();
    expect(check("GET", "health", { host: "LOCALHOST:5000" })).toBeNull();
    expect(check("GET", "health", { host: "127.0.0.1:5001" })).toBe("invalid_host");
    expect(check("GET", "health", { host: "evil.example" })).toBe("invalid_host");
    expect(check("GET", "health", {})).toBe("invalid_host");
    // Host comes before the token.
    expect(check("GET", "api", { host: "evil.example" })).toBe("invalid_host");
    expect(checkRequest({ method: "GET", headers: { host: "evil.example" } }, "health", guard)?.status).toBe(421);
  });

  it("needs the bearer token on /api/v1 and never takes the cookie there", () => {
    expect(check("GET", "api", { host })).toBe("unauthorized");
    expect(check("GET", "api", { host, authorization: `Bearer ${token}` })).toBeNull();
    expect(check("GET", "api", { host, authorization: `bearer ${token}` })).toBeNull();
    expect(check("GET", "api", { host, authorization: `Bearer ${token}x` })).toBe("unauthorized");
    expect(check("GET", "api", { host, authorization: token })).toBe("unauthorized");
    expect(check("GET", "api", { host, cookie: `${cookieName("contacts")}=${token}` })).toBe("unauthorized");
  });

  it("needs the app's own cookie on UI routes", () => {
    expect(cookieName("photos")).toBe("memex_photos_token");
    expect(check("GET", "ui", { host })).toBe("unauthorized");
    expect(check("GET", "ui", { host, cookie: `memex_photos_token=${token}` })).toBe("unauthorized");
    expect(check("GET", "ui", { host, cookie: `a=b; memex_contacts_token=${token}` })).toBeNull();
    expect(check("GET", "ui", { host, authorization: `Bearer ${token}` })).toBe("unauthorized");
    expect(tokenCookie("contacts", "t")).toBe("memex_contacts_token=t; HttpOnly; SameSite=Strict; Path=/");
  });

  it("checks Origin after the token: any Origin must be the app's, and a UI mutation must have one", () => {
    const auth = { host, authorization: `Bearer ${token}` };
    expect(check("POST", "api", { ...auth, origin: "http://evil.example" })).toBe("invalid_origin");
    expect(check("POST", "api", { ...auth, origin: "http://localhost:5000" })).toBe("invalid_origin");
    expect(check("POST", "api", { ...auth, origin: `http://${host}` })).toBeNull();
    expect(check("POST", "api", auth)).toBeNull();
    expect(check("GET", "health", { host, origin: "http://evil.example" })).toBe("invalid_origin");
    const ui = { host, cookie: `memex_contacts_token=${token}` };
    expect(check("POST", "ui", ui)).toBe("invalid_origin");
    expect(check("DELETE", "ui", ui)).toBe("invalid_origin");
    expect(check("GET", "ui", ui)).toBeNull();
    expect(check("PUT", "ui", { ...ui, origin: `http://${host}` })).toBeNull();
    expect(check("POST", "ui", { host, origin: "http://evil.example" })).toBe("unauthorized");
  });

  it("needs application/json for a body, except on uploads", () => {
    const auth = { host, authorization: `Bearer ${token}` };
    expect(check("POST", "api", { ...auth, "content-length": "2", "content-type": "text/plain" })).toBe("unsupported_media_type");
    expect(check("POST", "api", { ...auth, "content-length": "2" })).toBe("unsupported_media_type");
    expect(check("POST", "api", { ...auth, "transfer-encoding": "chunked", "content-type": "application/json; charset=utf-8" })).toBeNull();
    expect(check("POST", "api", { ...auth, "content-length": "0" })).toBeNull();
    expect(check("POST", "upload", { ...auth, "content-length": "2", "content-type": "image/jpeg" })).toBeNull();
    expect(check("POST", "upload", { host, "content-length": "2" })).toBe("unauthorized");
  });
});

describe("AuthCodes", () => {
  it("redeems a code once within 60 seconds", () => {
    let now = 0;
    const codes = new AuthCodes({ now: () => now });
    const a = codes.issue();
    const b = codes.issue();
    expect(a.expiresAt).toBe(new Date(60_000).toISOString());
    expect(codes.redeem(a.code)).toBe(true);
    expect(codes.redeem(a.code)).toBe(false);
    now = 60_000;
    expect(codes.redeem(b.code)).toBe(false);
    expect(codes.redeem("made-up")).toBe(false);
  });
});

describe("startServer", () => {
  let server: SurfaceServer;
  let headless: SurfaceServer;
  const auth = () => ({ authorization: `Bearer ${server.token}` });

  beforeAll(async () => {
    server = await startServer({
      registry,
      ui: (req, res) => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(`ui ${req.method} ${req.url}`);
      },
    });
    headless = await startServer({ registry });
  });
  afterAll(async () => {
    await server.close();
    await headless.close();
  });

  it("listens on 127.0.0.1 with a port from the OS", () => {
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(server.port).toBeGreaterThan(0);
    expect(server.server.address()).toMatchObject({ address: "127.0.0.1" });
    expect(server.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("answers /health with status, app, and version only", async () => {
    const answer = await localRequest(`${server.url}/health`);
    expect(answer.status).toBe(200);
    expect(JSON.parse(answer.text)).toEqual({ status: "ok", app: "contacts", version: "1.0.0" });
    expect(answer.headers["access-control-allow-origin"]).toBeUndefined();
    expect(answer.headers["cache-control"]).toBe("no-store");
  });

  it("refuses another Host with 421 on every route", async () => {
    for (const route of ["/health", "/api/v1", "/", "/auth"]) {
      const answer = await localRequest(`${server.url}${route}`, { headers: { host: "rebind.example" } });
      expect(answer.status).toBe(421);
      expect(JSON.parse(answer.text).error.code).toBe("invalid_host");
    }
    const localhost = await localRequest(`${server.url}/health`, { headers: { host: `localhost:${server.port}` } });
    expect(localhost.status).toBe(200);
  });

  it("serves /api/v1 with the token", async () => {
    expect((await localRequest(`${server.url}/api/v1`)).status).toBe(401);
    const list = await localRequest(`${server.url}/api/v1`, { headers: auth() });
    expect(list.status).toBe(200);
    expect(JSON.parse(list.text).capabilities).toHaveLength(registry.capabilities.length);
    const openapi = await localRequest(`${server.url}/api/v1/openapi.json`, { headers: auth() });
    expect(JSON.parse(openapi.text).openapi).toBe("3.1.0");
    const body = JSON.stringify({ id: "p1" });
    const post = await localRequest(`${server.url}/api/v1/contacts.persons.get`, {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json", "content-length": String(body.length) },
      body,
    });
    expect(JSON.parse(post.text)).toEqual({ id: "p1", name: "Ada Lovelace" });
  });

  it("takes the origin agent or cli from x-memex-origin after the token check, and api otherwise", async () => {
    const count = (headers: Record<string, string>) => localRequest(`${server.url}/api/v1/contacts.persons.count`, { headers });
    for (const [value, origin] of [
      ["agent", "agent"],
      ["cli", "cli"],
      ["user", "api"],
      ["", "api"],
    ]) {
      const answer = await count({ ...auth(), "x-memex-origin": value! });
      expect(JSON.parse(answer.text)).toEqual({ count: 3, origin });
    }
    expect((await count({ "x-memex-origin": "agent" })).status).toBe(401);
  });

  it("refuses another Origin and a body that is not JSON", async () => {
    const origin = await localRequest(`${server.url}/api/v1/contacts.persons.list`, {
      method: "POST",
      headers: { ...auth(), origin: "http://evil.example", "content-type": "application/json", "content-length": "2" },
      body: "{}",
    });
    expect(origin.status).toBe(403);
    const text = await localRequest(`${server.url}/api/v1/contacts.persons.list`, {
      method: "POST",
      headers: { ...auth(), "content-type": "text/plain", "content-length": "2" },
      body: "{}",
    });
    expect(text.status).toBe(415);
    expect(JSON.parse(text.text).error.code).toBe("unsupported_media_type");
  });

  it("takes an upload, runs a capability on it, and serves the made file", async () => {
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    const up = await localRequest(`${server.url}/api/v1/uploads`, {
      method: "POST",
      headers: { ...auth(), "content-type": "image/jpeg", "content-length": String(bytes.length) },
      body: bytes,
    });
    const { upload } = JSON.parse(up.text);
    expect(upload).toMatchObject({ bytes: 4, mediaType: "image/jpeg" });
    const body = JSON.stringify({ uploadId: upload.id });
    const run = await localRequest(`${server.url}/api/v1/contacts.photos.inspect`, {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json", "content-length": String(body.length) },
      body,
    });
    const out = JSON.parse(run.text);
    expect(out).toMatchObject({ bytes: 4, mediaType: "image/jpeg" });
    const file = await localRequest(`${server.url}${out.file.url}`, { headers: auth() });
    expect(file.headers["content-type"]).toBe("text/plain");
    expect(file.text).toBe("size 4");
    expect((await localRequest(`${server.url}${out.file.url}`)).status).toBe(401);
  });

  it("opens the UI with a one-use code: /auth sets the cookie and redirects", async () => {
    expect((await localRequest(`${server.url}/`)).status).toBe(401);
    const issued = await localRequest(`${server.url}/api/v1/auth/code`, { method: "POST", headers: auth() });
    const { code } = JSON.parse(issued.text);
    const redirect = await localRequest(`${server.url}/auth?code=${code}`);
    expect(redirect.status).toBe(302);
    expect(redirect.headers.location).toBe("/");
    const cookie = String(redirect.headers["set-cookie"]);
    expect(cookie).toBe(`memex_contacts_token=${server.token}; HttpOnly; SameSite=Strict; Path=/`);
    expect((await localRequest(`${server.url}/auth?code=${code}`)).status).toBe(401);

    const jar = { cookie: `memex_contacts_token=${server.token}` };
    const page = await localRequest(`${server.url}/notes`, { headers: jar });
    expect(page.text).toBe("ui GET /notes");
    const noOrigin = await localRequest(`${server.url}/notes`, { method: "POST", headers: jar });
    expect(noOrigin.status).toBe(403);
    const same = await localRequest(`${server.url}/notes`, { method: "POST", headers: { ...jar, origin: server.url } });
    expect(same.text).toBe("ui POST /notes");
  });

  it("answers 404 on other paths of a headless tool, after the Host check", async () => {
    const answer = await localRequest(`${headless.url}/`);
    expect(answer.status).toBe(404);
    expect(JSON.parse(answer.text).error.code).toBe("not_found");
    expect((await localRequest(`${headless.url}/`, { headers: { host: "evil.example" } })).status).toBe(421);
    const code = await localRequest(`${headless.url}/api/v1/auth/code`, { method: "POST", headers: { authorization: `Bearer ${headless.token}` } });
    expect(code.status).toBe(404);
    expect((await localRequest(`${headless.url}/auth?code=x`)).status).toBe(404);
  });
});
