import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type Handle, HandlesError, type NormalizeOptions, normalizeEmail, normalizeHandle, normalizePhone } from "../src/index.js";
import { makeChecker } from "./schema.js";

const root = new URL("../../../", import.meta.url);
function load<T>(path: string): T {
  return JSON.parse(readFileSync(fileURLToPath(new URL(path, root)), "utf8")) as T;
}

interface HandleCase {
  name: string;
  raw: string;
  options: NormalizeOptions;
  expected?: Handle;
  error?: string;
}

describe("normalizeHandle fixtures", () => {
  const { cases } = load<{ cases: HandleCase[] }>("contracts/fixtures/handles/normalize.json");
  it("has cases", () => expect(cases.length).toBeGreaterThan(20));
  for (const c of cases) {
    it(c.name, () => {
      if (c.error !== undefined) {
        let caught: unknown;
        try {
          normalizeHandle(c.raw, c.options);
        } catch (e) {
          caught = e;
        }
        expect(caught).toBeInstanceOf(HandlesError);
        expect((caught as HandlesError).code).toBe(c.error);
      } else {
        expect(normalizeHandle(c.raw, c.options)).toEqual(c.expected);
      }
    });
  }
});

describe("normalizePhone and normalizeEmail", () => {
  it("returns undefined for text that is not a number or an address", () => {
    expect(normalizePhone("PAKKE", "NO")).toBeUndefined();
    expect(normalizePhone("+1 201-555-0100")).toBe("+12015550100");
    expect(normalizeEmail("not an address")).toBeUndefined();
    expect(normalizeEmail(" Ada@Example.com ")).toBe("ada@example.com");
  });
});

type Json = Record<string, unknown>;
interface Records {
  region: string;
  messages: Json[];
  calls: Json[];
  invalid: Array<{ name: string; at: string; schema: "message" | "call"; patch?: Json; remove?: string[] }>;
}

const SCHEMAS = {
  message: "memex.message-1.schema.json",
  call: "memex.call-1.schema.json",
} as const;

const KEYWORDS = new Set([
  "$schema", "$id", "$ref", "$defs", "title", "description", "type", "const", "enum", "pattern", "minLength", "maxLength",
  "minimum", "items", "minItems", "required", "properties", "additionalProperties", "allOf", "anyOf", "not", "if", "then", "else",
]);

function keywords(node: unknown, inProperties: boolean, found: Set<string>): void {
  if (node === null || typeof node !== "object" || Array.isArray(node)) {
    if (Array.isArray(node)) for (const n of node) keywords(n, false, found);
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    if (!inProperties) found.add(key);
    if (key === "enum" || key === "const" || key === "required") continue;
    keywords(value, !inProperties && (key === "properties" || key === "$defs"), found);
  }
}

describe("memex.message/1 and memex.call/1 fixtures", () => {
  const files = {
    [SCHEMAS.message]: load<Json>(`schemas/message/${SCHEMAS.message}`),
    [SCHEMAS.call]: load<Json>(`schemas/message/${SCHEMAS.call}`),
  };
  const check = makeChecker(files);
  const records = load<Records>("contracts/fixtures/message/records.json");

  it("schemas use only the keywords that the test checker knows", () => {
    const found = new Set<string>();
    keywords(files, true, found);
    expect([...found].filter((k) => !KEYWORDS.has(k))).toEqual([]);
  });

  for (const [kind, list] of [["message", records.messages], ["call", records.calls]] as const) {
    for (const record of list) {
      it(`${kind} ${String(record.id)} matches the schema`, () => {
        expect(check(SCHEMAS[kind], record)).toEqual([]);
      });
      it(`${kind} ${String(record.id)} has handles as normalizeHandle makes them`, () => {
        const handles = [record.sender, ...((record.recipients ?? []) as Handle[]), ...((record.cc ?? []) as Handle[]), ...((record.handles ?? []) as Handle[])]
          .filter((h): h is Handle => h !== undefined);
        expect(handles.length).toBeGreaterThan(0);
        for (const h of handles) {
          expect(normalizeHandle(h.raw, { region: records.region, service: record.service as string })).toEqual(h);
        }
      });
    }
  }

  for (const c of records.invalid) {
    it(`rejects: ${c.name}`, () => {
      const base = structuredClone(c.schema === "message" ? records.messages[0]! : records.calls[0]!);
      const record: Json = { ...base, ...c.patch };
      for (const key of c.remove ?? []) delete record[key];
      const errors = check(SCHEMAS[c.schema], record);
      expect(errors.some((e) => e.startsWith(`${c.at}: `)), errors.join("; ")).toBe(true);
    });
  }
});
