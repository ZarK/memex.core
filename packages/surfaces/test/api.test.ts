import { describe, expect, it } from "vitest";
import { z } from "zod";
import * as lib from "../src/index.js";
import { AuthCodes, FileStore, MAX_JSON_BYTES, handleApiV1, openApi, type ApiRequest } from "../src/index.js";
import { demoRegistry } from "./fixtures/demo-registry.mjs";

const registry = demoRegistry(lib);

function request(method: string, url: string, body?: string | Buffer, contentType = "application/json"): ApiRequest {
  const parsed = new URL(url, "http://127.0.0.1");
  const data = body === undefined ? Buffer.alloc(0) : Buffer.from(body);
  return {
    method,
    path: parsed.pathname,
    query: parsed.searchParams,
    contentType,
    body: async (limit) => (data.length > limit ? null : data),
  };
}

describe("handleApiV1", () => {
  it("lists the capabilities", async () => {
    const answer = await handleApiV1(registry, request("GET", "/api/v1"));
    expect(answer.status).toBe(200);
    const body = (answer as { body: { app: string; version: string; capabilities: Array<{ id: string }>; openapi: string } }).body;
    expect(body.app).toBe("contacts");
    expect(body.version).toBe("1.0.0");
    expect(body.openapi).toBe("/api/v1/openapi.json");
    expect(body.capabilities.map((c) => c.id)).toContain("contacts.persons.list");
    expect(Object.keys(body.capabilities[0]!)).toEqual(["id", "title", "kind", "description"]);
  });

  it("runs a read with GET and query parameters, coercing numbers and lists", async () => {
    const answer = await handleApiV1(registry, request("GET", "/api/v1/contacts.persons.list?limit=1&ids=p2,p3"));
    expect(answer).toEqual({ status: 200, body: { items: [{ id: "p2", name: "Alan Turing" }], next: "1" } });
    const repeated = await handleApiV1(registry, request("GET", "/api/v1/contacts.persons.list?ids=p1&ids=p3&limit=5"));
    expect((repeated as { body: { items: unknown[] } }).body.items).toHaveLength(2);
  });

  it("runs a read with GET and ?input=<json>", async () => {
    const input = encodeURIComponent(JSON.stringify({ id: "p3" }));
    expect(await handleApiV1(registry, request("GET", `/api/v1/contacts.persons.get?input=${input}`))).toEqual({
      status: 200,
      body: { id: "p3", name: "Grace Hopper" },
    });
  });

  it("runs any capability with POST and a JSON body; an empty body is {}", async () => {
    const merge = await handleApiV1(registry, request("POST", "/api/v1/contacts.persons.merge", JSON.stringify({ from: "p1", into: "p2" })));
    expect(merge.status).toBe(200);
    const list = await handleApiV1(registry, request("POST", "/api/v1/contacts.persons.list"));
    expect((list as { body: { items: unknown[] } }).body.items).toHaveLength(2);
  });

  it("refuses a write over GET and other methods", async () => {
    const get = await handleApiV1(registry, request("GET", "/api/v1/contacts.persons.merge"));
    expect(get).toMatchObject({ status: 405, body: { error: { code: "method_not_allowed" } } });
    const put = await handleApiV1(registry, request("PUT", "/api/v1/contacts.persons.list", "{}"));
    expect(put.status).toBe(405);
  });

  it("answers errors with the one error body", async () => {
    expect(await handleApiV1(registry, request("GET", "/api/v1/contacts.nobody.here"))).toMatchObject({
      status: 404,
      body: { error: { code: "unknown_capability" } },
    });
    expect(await handleApiV1(registry, request("POST", "/api/v1/contacts.persons.get", "{"))).toMatchObject({
      status: 400,
      body: { error: { code: "invalid_json" } },
    });
    expect(await handleApiV1(registry, request("GET", "/api/v1/contacts.persons.get?id=zz"))).toEqual({
      status: 404,
      body: { error: { code: "not_found", message: "There is no person zz.", field: "id", hint: "contacts.persons.list lists them." } },
    });
    const query = await handleApiV1(registry, request("GET", "/api/v1/contacts.persons.get?input=%7Bbad"));
    expect(query).toMatchObject({ status: 400, body: { error: { code: "invalid_json" } } });
    const big = await handleApiV1(registry, request("POST", "/api/v1/contacts.persons.list", Buffer.alloc(MAX_JSON_BYTES + 1, 32)));
    expect(big).toMatchObject({ status: 413, body: { error: { code: "too_large" } } });
  });

  it("answers a bad object in a query parameter with invalid_json and the field", async () => {
    const reg = lib.createRegistry({
      app: "demo",
      name: "Demo",
      version: "1",
      capabilities: [
        lib.defineRead({ id: "demo.rows.list", title: "t", description: "d", input: z.object({ filter: z.object({ q: z.string() }) }), handler: (i) => i }),
      ],
    });
    expect(await handleApiV1(reg, request("GET", '/api/v1/demo.rows.list?filter={"q":"a"}'))).toEqual({ status: 200, body: { filter: { q: "a" } } });
    expect(await handleApiV1(reg, request("GET", "/api/v1/demo.rows.list?filter={bad"))).toMatchObject({
      status: 400,
      body: { error: { code: "invalid_json", field: "filter" } },
    });
  });

  it("answers bad JSON or a zod failure inside a handler with 500 internal", async () => {
    const reg = lib.createRegistry({
      app: "demo",
      name: "Demo",
      version: "1",
      capabilities: [
        lib.defineRead({ id: "demo.rows.parse", title: "t", description: "d", input: z.object({}), handler: () => JSON.parse("{corrupt") }),
        lib.defineRead({
          id: "demo.rows.check",
          title: "t",
          description: "d",
          input: z.object({}),
          handler: () => z.object({ amountMinor: z.number() }).parse({ amountMinor: "x" }),
        }),
      ],
    });
    for (const id of ["demo.rows.parse", "demo.rows.check"]) {
      expect(await handleApiV1(reg, request("GET", `/api/v1/${id}`))).toMatchObject({ status: 500, body: { error: { code: "internal" } } });
    }
  });

  it("uses the origin it is given, api by default", async () => {
    expect(await handleApiV1(registry, request("POST", "/api/v1/contacts.persons.count"))).toEqual({ status: 200, body: { count: 3, origin: "api" } });
    expect(await handleApiV1(registry, request("POST", "/api/v1/contacts.persons.count"), { origin: "agent" })).toEqual({
      status: 200,
      body: { count: 3, origin: "agent" },
    });
    expect([lib.forwardedOrigin("agent"), lib.forwardedOrigin("cli"), lib.forwardedOrigin("user"), lib.forwardedOrigin(undefined)]).toEqual([
      "agent",
      "cli",
      "api",
      "api",
    ]);
  });

  it("answers a bad %-escape in the path with 400 invalid_input, not 500", async () => {
    const files = new FileStore();
    for (const path of ["/api/v1/contacts.persons.get%E0%A4%A", "/api/v1/%zz", "/api/v1/files/f_%E0"]) {
      expect(await handleApiV1(registry, request("GET", path), { files })).toMatchObject({ status: 400, body: { error: { code: "invalid_input" } } });
    }
  });

  it("stores uploads and serves made files", async () => {
    const files = new FileStore();
    const up = await handleApiV1(registry, request("POST", "/api/v1/uploads", Buffer.from([1, 2, 3]), "image/png"), { files });
    const upload = (up as { body: { upload: { id: string; bytes: number; mediaType: string; expiresAt: string } } }).body.upload;
    expect(upload).toMatchObject({ bytes: 3, mediaType: "image/png" });
    const run = await handleApiV1(registry, request("POST", "/api/v1/contacts.photos.inspect", JSON.stringify({ uploadId: upload.id })), { files });
    const url = (run as { body: { file: { url: string } } }).body.file.url;
    const file = await handleApiV1(registry, request("GET", url), { files });
    expect(file).toMatchObject({ status: 200, mediaType: "text/plain" });
    expect((file as { data: Buffer }).data.toString()).toBe("size 3");
    expect((await handleApiV1(registry, request("GET", "/api/v1/files/f_none"), { files })).status).toBe(404);
  });

  it("issues auth codes only for an app with a UI", async () => {
    const codes = new AuthCodes();
    const answer = await handleApiV1(registry, request("POST", "/api/v1/auth/code"), { authCodes: codes });
    const code = (answer as { body: { code: string } }).body.code;
    expect(codes.redeem(code)).toBe(true);
    expect(codes.redeem(code)).toBe(false);
    expect((await handleApiV1(registry, request("POST", "/api/v1/auth/code"))).status).toBe(404);
  });
});

describe("openApi", () => {
  const doc = openApi(registry) as unknown as {
    openapi: string;
    info: { title: string; version: string };
    paths: Record<string, Record<string, { requestBody?: { content: Record<string, { schema: Record<string, unknown> }> }; responses: Record<string, unknown> }>>;
    components: { securitySchemes: Record<string, unknown> };
  };

  it("is OpenAPI 3.1 with a bearer scheme", () => {
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info).toMatchObject({ title: "Memex Contacts", version: "1.0.0" });
    expect(doc.components.securitySchemes.bearer).toMatchObject({ type: "http", scheme: "bearer" });
    expect(doc.paths["/health"]).toBeDefined();
  });

  it("has GET and POST for reads and POST only for writes", () => {
    expect(Object.keys(doc.paths["/api/v1/contacts.persons.list"]!)).toEqual(["get", "post"]);
    expect(Object.keys(doc.paths["/api/v1/contacts.persons.merge"]!)).toEqual(["post"]);
  });

  it("converts the zod input to JSON Schema with no unknown fields", () => {
    const schema = doc.paths["/api/v1/contacts.persons.merge"]!.post!.requestBody!.content["application/json"]!.schema;
    expect(schema).toMatchObject({
      type: "object",
      required: ["from", "into"],
      additionalProperties: false,
      properties: { from: { type: "string" }, dryRun: { type: "boolean" }, idempotencyKey: { type: "string" } },
    });
    const list = doc.paths["/api/v1/contacts.persons.list"]!.post!.requestBody!.content["application/json"]!.schema;
    expect(list).toMatchObject({ properties: { limit: { type: "integer", default: 2, maximum: 10 } } });
    expect(doc.paths["/api/v1/contacts.persons.list"]!.get!.responses["200"]).toMatchObject({
      content: { "application/json": { schema: { properties: { next: { type: ["string", "null"] } } } } },
    });
  });
});
