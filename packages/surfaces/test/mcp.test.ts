import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as lib from "../src/index.js";
import { createMcpServer } from "../src/index.js";
import { demoRegistry } from "./fixtures/demo-registry.mjs";

const registry = demoRegistry(lib);
let client: Client;
let calls: Array<[string, unknown]>;

beforeEach(async () => {
  calls = [];
  const server = createMcpServer(registry, {
    invoke: (id, input) => {
      calls.push([id, input]);
      return registry.invoke(id, input, { origin: "agent" });
    },
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  client = new Client({ name: "test", version: "1" });
  await client.connect(b);
});
afterEach(async () => {
  await client.close();
});

const text = (result: Awaited<ReturnType<Client["callTool"]>>) => JSON.parse((result.content as Array<{ text: string }>)[0]!.text);

describe("createMcpServer", () => {
  it("names the server memex-<app> and lists capabilities left out of MCP", () => {
    expect(client.getServerVersion()).toMatchObject({ name: "memex-contacts", version: "1.0.0" });
    expect(client.getInstructions()).toContain("Not served over MCP: contacts.secrets.list.");
  });

  it("has one tool per capability, named with underscores, with annotations", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      "contacts_persons_list",
      "contacts_persons_get",
      "contacts_persons_count",
      "contacts_persons_merge",
      "contacts_photos_inspect",
      "contacts_notes_add",
      "contacts_jobs_run",
    ]);
    const list = tools.find((t) => t.name === "contacts_persons_list")!;
    expect(list.title).toBe("List persons");
    expect(list.description).toMatch(/^Lists persons/);
    expect(list.inputSchema).toMatchObject({ type: "object", additionalProperties: false, properties: { limit: { type: "integer" } } });
    expect(list.annotations).toEqual({ title: "List persons", readOnlyHint: true, idempotentHint: true, openWorldHint: false });
    const merge = tools.find((t) => t.name === "contacts_persons_merge")!;
    expect(merge.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true });
  });

  it("runs a call through invoke", async () => {
    const result = await client.callTool({ name: "contacts_persons_get", arguments: { id: "p1" } });
    expect(result.isError).toBeFalsy();
    expect(text(result)).toEqual({ id: "p1", name: "Ada Lovelace" });
    expect(calls).toEqual([["contacts.persons.get", { id: "p1" }]]);
  });

  it("answers a bad input, an app error, and an unknown or hidden tool with isError and the error body", async () => {
    const bad = await client.callTool({ name: "contacts_persons_get", arguments: { nope: 1 } });
    expect(bad.isError).toBe(true);
    expect(text(bad).error).toMatchObject({ code: "invalid_input", field: "nope" });
    const missing = await client.callTool({ name: "contacts_persons_get", arguments: { id: "zz" } });
    expect(text(missing)).toEqual({ error: { code: "not_found", message: "There is no person zz.", field: "id", hint: "contacts.persons.list lists them." } });
    for (const name of ["contacts_nothing_here", "contacts_secrets_list"]) {
      const unknown = await client.callTool({ name, arguments: {} });
      expect(unknown.isError).toBe(true);
      expect(text(unknown).error.code).toBe("unknown_capability");
    }
  });
});
