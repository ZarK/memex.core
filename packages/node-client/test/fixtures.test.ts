import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { writeFixtureJson } from "./fixture-json.js";
import { NODE_CONTRACT_SHA256, NODE_OPERATIONS, type JobEnvelope, type LeaseEnvelope, type Registration, type RegistrationResult, type Routes, type RunRequest, type RunResult } from "../src/index.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (p: string) => fs.readFileSync(path.join(repo, p), "utf8");
const BASE = "https://github.com/ZarK/memex.core/openapi/node.v1.yaml";

const spec = parseYaml(read("openapi/node.v1.yaml")) as { paths: Record<string, Record<string, { operationId?: string }>> };
const ajv = new Ajv2020.default({ strict: false, allErrors: true });
addFormats.default(ajv);
ajv.addSchema(JSON.parse(read("schemas/surfaces/error.json")));
ajv.addSchema(JSON.parse(read("schemas/packs/pack.json")));
ajv.addSchema({ ...spec, $id: BASE });

const index = JSON.parse(read("contracts/fixtures/node/index.json")) as { fixtures: Record<string, string> };

describe("node fixtures", () => {
  const entries = Object.entries(index.fixtures);

  it("lists every fixture file", () => {
    const files = fs.readdirSync(path.join(repo, "contracts/fixtures/node")).filter((f) => f !== "index.json");
    expect(files.sort()).toEqual(Object.keys(index.fixtures).sort());
  });

  for (const [file, schema] of entries) {
    it(`${file} follows ${schema.split("#")[1]} and reads back byte for byte`, () => {
      const text = read(`contracts/fixtures/node/${file}`).replace(/\r\n/g, "\n");
      const value = JSON.parse(text);
      const validate = ajv.getSchema(`${BASE}#${schema.split("#")[1]}`);
      expect(validate, schema).toBeDefined();
      const ok = validate!(value);
      expect(validate!.errors ?? [], file).toEqual([]);
      expect(ok).toBe(true);
      expect(writeFixtureJson(value)).toBe(text);
    });
  }

  it("types the fixtures with the generated types", () => {
    const load = <T>(file: string) => JSON.parse(read(`contracts/fixtures/node/${file}`)) as T;
    const registration = load<Registration>("register.request.json");
    const result = load<RegistrationResult>("register.response.json");
    const routes = load<Routes>("routes.json");
    const run = load<RunRequest>("run-embed-text.request.json");
    const ran = load<RunResult>("run-embed-text.response.json");
    const job = load<JobEnvelope>("job-food-waiting.json");
    const lease = load<LeaseEnvelope>("lease-yielding.json");
    expect(registration.functions.length).toBeGreaterThan(0);
    expect(result.functions.every((f) => typeof f.state === "string")).toBe(true);
    expect(routes.default.kind).toBe("auto");
    expect(run.function).toMatch(/\./);
    expect(ran.record.models.length).toBeGreaterThan(0);
    expect(job.job.wait?.reason).toBe("backend-down");
    expect(lease.lease.state).toBe("yielding");
  });
});

describe("generated code", () => {
  it("is generated from the current contract", () => {
    const { createHash } = crypto;
    const sha = createHash("sha256").update(read("openapi/node.v1.yaml").replace(/\r\n/g, "\n")).digest("hex");
    expect(NODE_CONTRACT_SHA256).toBe(sha);
  });

  it("has one operation for each operation of the contract", () => {
    const ids = Object.values(spec.paths).flatMap((item) => Object.values(item).map((op) => op.operationId).filter(Boolean));
    expect(Object.keys(NODE_OPERATIONS).sort()).toEqual((ids as string[]).sort());
  });
});
