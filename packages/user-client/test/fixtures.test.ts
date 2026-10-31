// Every fixture of contracts/fixtures/user/ and contracts/fixtures/contacts/ against its schema, read and written back
// byte for byte in the one fixture layout, and a generated type for each schema that the fixtures name.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { makeChecker } from "../../schema/test/json-schema.js";
import {
  CONTACTS_COMPONENT_TYPES,
  CONTACTS_CONTRACT_SHA256,
  CONTACTS_OPERATIONS,
  USER_COMPONENT_TYPES,
  USER_CONTRACT_SHA256,
  USER_OPERATIONS,
  type UserChangesListOutput,
  type UserCorrectionsWriteOutput,
  type UserTripFields,
} from "../src/index.js";
import { writeFixtureJson } from "./fixture-json.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const text = (path: string) => readFileSync(join(ROOT, path), "utf8").replace(/\r\n/g, "\n");

const files: Record<string, unknown> = { "schemas/surfaces/error.json": JSON.parse(text("schemas/surfaces/error.json")) };
for (const dir of ["schemas/user", "schemas/contacts", "schemas/facts"]) {
  for (const name of readdirSync(join(ROOT, dir))) files[`${dir}/${name}`] = JSON.parse(text(`${dir}/${name}`));
}
for (const path of ["openapi/user.v1.yaml", "openapi/contacts.v1.yaml"]) files[path] = parseYaml(text(path));
const check = makeChecker(files);

const HUBS = [
  { hub: "user", types: USER_COMPONENT_TYPES as Record<string, string>, sha: USER_CONTRACT_SHA256, ops: USER_OPERATIONS, spec: "openapi/user.v1.yaml" },
  { hub: "contacts", types: CONTACTS_COMPONENT_TYPES as Record<string, string>, sha: CONTACTS_CONTRACT_SHA256, ops: CONTACTS_OPERATIONS, spec: "openapi/contacts.v1.yaml" },
] as const;

/** The component name of a fixture's schema: a component of the OpenAPI file, or a schema file that one names. */
function componentOf(schema: string, hub: string): string {
  if (schema.includes("#/components/schemas/")) return schema.split("#/components/schemas/")[1]!;
  const spec = files[`openapi/${hub}.v1.yaml`] as { components: { schemas: Record<string, { $ref?: string }> } };
  const found = Object.entries(spec.components.schemas).find(([, s]) => s.$ref === `../${schema}`);
  if (!found) throw new Error(`No component names ${schema}.`);
  return found[0];
}

for (const { hub, types, sha, ops, spec } of HUBS) {
  describe(`${hub} fixtures`, () => {
    const index = JSON.parse(text(`contracts/fixtures/${hub}/index.json`)) as { fixtures: Record<string, string> };

    it("lists every fixture file", () => {
      const listed = Object.keys(index.fixtures).sort();
      const present = readdirSync(join(ROOT, "contracts", "fixtures", hub)).filter((f) => f !== "index.json").sort();
      expect(listed).toEqual(present);
    });

    for (const [file, schema] of Object.entries(index.fixtures)) {
      it(`${file} follows its schema, has a generated type, and reads back byte for byte`, () => {
        const raw = text(`contracts/fixtures/${hub}/${file}`);
        const value = JSON.parse(raw);
        expect(check(schema, value)).toEqual([]);
        expect(types[componentOf(schema, hub)]).toBeDefined();
        expect(writeFixtureJson(value)).toBe(raw);
      });
    }

    it("is generated from the current contract", () => {
      expect(sha).toBe(createHash("sha256").update(text(spec)).digest("hex"));
    });

    it("has one method for each operation of the contract that answers 200", () => {
      // POST /v1/drain answers 202 and is for the service launcher only.
      const doc = files[spec] as { paths: Record<string, Record<string, { operationId: string; responses: Record<string, unknown> }>> };
      const ids = Object.values(doc.paths).flatMap((item) => Object.values(item).filter((op) => op.responses["200"]).map((op) => op.operationId));
      expect(Object.keys(ops).sort()).toEqual(ids.sort());
    });
  });
}

describe("generated types", () => {
  it("type the fixtures", () => {
    const write = JSON.parse(text("contracts/fixtures/user/corrections-write.response.json")) as UserCorrectionsWriteOutput;
    expect(write.results.every((r) => ["applied", "superseded", "held"].includes(r.status))).toBe(true);
    const changes = JSON.parse(text("contracts/fixtures/user/changes-list.response.json")) as UserChangesListOutput;
    const trip = changes.items.find((c) => c.kind === "trip")!.record!.fields as unknown as UserTripFields;
    expect(typeof trip.firstDay).toBe("string");
  });
});
