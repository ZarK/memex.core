import { describe, expect, it } from "vitest";
import { z } from "zod";
import * as lib from "../src/index.js";
import { FileStore, SurfaceError, createRegistry, defineRead, defineWrite, errorBody, isCapabilityId, parseInputJson, toolName } from "../src/index.js";
import { demoRegistry } from "./fixtures/demo-registry.mjs";

const registry = demoRegistry(lib);
const read = (id: string) => defineRead({ id, title: "t", description: "d", input: z.object({}), handler: () => ({}) });

describe("createRegistry", () => {
  it("takes ids of the form <app>.<noun>.<verb>", () => {
    expect(isCapabilityId("contacts.persons.list", "contacts")).toBe(true);
    expect(isCapabilityId("photos.persons.list", "contacts")).toBe(false);
    expect(isCapabilityId("contacts.list", "contacts")).toBe(false);
    expect(isCapabilityId("contacts.persons.list.all", "contacts")).toBe(false);
    expect(isCapabilityId("contacts.Persons.list", "contacts")).toBe(false);
    expect(isCapabilityId("contacts.person_s.list", "contacts")).toBe(false);
    expect(toolName("contacts.persons.list")).toBe("contacts_persons_list");
  });

  it("refuses wrong ids, a second definition, a long description, and a bad app id", () => {
    const make = (capabilities: lib.Capability[], app = "contacts") => () => createRegistry({ app, name: "C", version: "1", capabilities });
    expect(make([read("finance.persons.list")])).toThrow(/contacts.<noun>.<verb>/);
    expect(make([read("contacts.persons.list"), read("contacts.persons.list")])).toThrow(/twice/);
    expect(make([{ ...read("contacts.persons.list"), description: "x".repeat(601) }])).toThrow(/600/);
    expect(make([], "My-App")).toThrow(/app id/);
  });

  it("parses the input, applies defaults, and runs the handler", async () => {
    expect(await registry.invoke("contacts.persons.list", {}, { origin: "api" })).toEqual({
      items: [
        { id: "p1", name: "Ada Lovelace" },
        { id: "p2", name: "Alan Turing" },
      ],
      next: "2",
    });
    expect(await registry.invoke("contacts.persons.list", { cursor: "2" }, { origin: "api" })).toEqual({
      items: [{ id: "p3", name: "Grace Hopper" }],
      next: null,
    });
  });

  it("names an unknown field and the fields there are", async () => {
    const error = await registry.invoke("contacts.persons.get", { id: "p1", name: "x" }, { origin: "api" }).catch((e: unknown) => e);
    expect(errorBody(error)).toEqual({
      status: 400,
      body: { error: { code: "invalid_input", message: 'contacts.persons.get has no field "name".', field: "name", hint: "Fields: id." } },
    });
  });

  it("gives a zod failure as invalid_input with the field", async () => {
    const error = await registry.invoke("contacts.persons.list", { limit: 99 }, { origin: "api" }).catch((e: unknown) => e);
    const { status, body } = errorBody(error);
    expect(status).toBe(400);
    expect(body.error.code).toBe("invalid_input");
    expect(body.error.field).toBe("limit");
    expect(error).toBeInstanceOf(SurfaceError);
    expect(body.error.hint).toMatch(/input schema/);
  });

  it("gives a zod failure inside a handler as 500 internal, not as the caller's input", async () => {
    const row = z.object({ amountMinor: z.number().int() });
    const reg = createRegistry({
      app: "demo",
      name: "Demo",
      version: "1",
      capabilities: [
        defineRead({ id: "demo.rows.list", title: "t", description: "d", input: z.object({}), handler: () => row.parse({ amountMinor: "12" }) }),
        defineRead({ id: "demo.rows.parse", title: "t", description: "d", input: z.object({}), handler: () => JSON.parse("{corrupt") }),
      ],
    });
    for (const id of ["demo.rows.list", "demo.rows.parse"]) {
      const error = await reg.invoke(id, {}, { origin: "api" }).catch((e: unknown) => e);
      expect(errorBody(error)).toMatchObject({ status: 500, body: { error: { code: "internal" } } });
    }
  });

  it("gives unknown_capability with 404", async () => {
    const error = await registry.invoke("contacts.nothing.here", {}, { origin: "api" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SurfaceError);
    expect(errorBody(error).status).toBe(404);
    expect(errorBody(error).body.error.code).toBe("unknown_capability");
  });

  it("adds dryRun and idempotencyKey to a write", async () => {
    const merge = registry.get("contacts.persons.merge")!;
    expect(Object.keys(merge.input.shape)).toEqual(["from", "into", "dryRun", "idempotencyKey"]);
    const first = await registry.invoke("contacts.persons.merge", { from: "p1", into: "p2", idempotencyKey: "k" }, { origin: "api" });
    const again = await registry.invoke("contacts.persons.merge", { from: "p1", into: "p2", idempotencyKey: "k" }, { origin: "api" });
    expect(again).toEqual(first);
    const dry = await registry.invoke("contacts.persons.merge", { from: "p1", into: "p3", dryRun: true }, { origin: "api" });
    expect(dry).toMatchObject({ changeId: null, summary: "Merged p1 into p3." });
  });

  it("lets a capability call another with the same origin", async () => {
    expect(await registry.invoke("contacts.persons.count", {}, { origin: "agent" })).toEqual({ count: 3, origin: "agent" });
  });

  it("removes an upload when the call that used it ends, and keeps made files", async () => {
    const files = new FileStore();
    const upload = files.addUpload(Buffer.from("hello"), "image/jpeg");
    expect(upload.id).toMatch(/^up_/);
    expect(upload.sha256).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
    const out = (await registry.invoke("contacts.photos.inspect", { uploadId: upload.id }, { origin: "api", files })) as {
      bytes: number;
      file: lib.FileRef;
    };
    expect(out.bytes).toBe(5);
    expect(out.file.url).toMatch(/^\/api\/v1\/files\/f_/);
    expect(files.getUpload(upload.id)).toBeUndefined();
    expect(files.getFile(out.file.url.split("/").pop()!)?.data.toString()).toBe("size 5");
    const again = await registry.invoke("contacts.photos.inspect", { uploadId: upload.id }, { origin: "api", files }).catch((e: unknown) => e);
    expect(errorBody(again).body.error).toMatchObject({ code: "invalid_input", field: "uploadId" });
  });

  it("fails a file capability with unavailable outside the running app", async () => {
    const error = await registry.invoke("contacts.photos.inspect", { uploadId: "up_x" }, { origin: "cli" }).catch((e: unknown) => e);
    expect(errorBody(error)).toMatchObject({ status: 503, body: { error: { code: "unavailable" } } });
  });

  it("expires uploads and files after the TTL", () => {
    let now = 0;
    const files = new FileStore({ ttlMs: 1000, now: () => now });
    const upload = files.addUpload(Buffer.from("a"), "text/plain");
    const file = files.addFile(Buffer.from("b"), "text/plain");
    now = 999;
    expect(files.getUpload(upload.id)).toBeDefined();
    now = 1000;
    expect(files.getUpload(upload.id)).toBeUndefined();
    expect(files.getFile(file.url.split("/").pop()!)).toBeUndefined();
  });
});

describe("errorBody", () => {
  it("uses the status of the code and keeps field and hint", () => {
    expect(errorBody(new SurfaceError("conflict", "Taken.", { field: "name", hint: "Pick another." }))).toEqual({
      status: 409,
      body: { error: { code: "conflict", message: "Taken.", field: "name", hint: "Pick another." } },
    });
    expect(errorBody(new SurfaceError("over_budget", "No.")).status).toBe(422);
  });

  it("maps every error that is not a SurfaceError to 500 internal, also a SyntaxError or a ZodError", () => {
    let syntax: unknown;
    try {
      JSON.parse("{");
    } catch (error) {
      syntax = error;
    }
    expect(errorBody(syntax).status).toBe(500);
    expect(errorBody(syntax).body.error.code).toBe("internal");
    const zod = z.object({ amountMinor: z.number() }).safeParse({ amountMinor: "x" }).error;
    expect(errorBody(zod)).toMatchObject({ status: 500, body: { error: { code: "internal" } } });
    expect(errorBody(new Error("boom"))).toEqual({ status: 500, body: { error: { code: "internal", message: "boom" } } });
  });

  it("parses the caller's JSON as invalid_json, with the field when there is one", () => {
    expect(parseInputJson('{"a":1}')).toEqual({ a: 1 });
    const error = (() => {
      try {
        parseInputJson("{bad", "filter");
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(SurfaceError);
    expect(errorBody(error)).toMatchObject({ status: 400, body: { error: { code: "invalid_json", field: "filter" } } });
  });
});

describe("defineWrite", () => {
  it("keeps the handler's input type", async () => {
    const reg = createRegistry({
      app: "demo",
      name: "Demo",
      version: "1",
      capabilities: [
        defineWrite({
          id: "demo.notes.add",
          title: "Add a note",
          description: "Adds a note.",
          input: z.object({ text: z.string() }),
          handler: (input) => ({ changeId: "c1", summary: `Added ${input.text}.` }),
        }),
      ],
    });
    expect(await reg.invoke("demo.notes.add", { text: "hi" }, { origin: "user" })).toEqual({ changeId: "c1", summary: "Added hi." });
  });
});
