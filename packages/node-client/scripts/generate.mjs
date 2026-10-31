#!/usr/bin/env node
// Generates the Memex.Node clients from openapi/node.v1.yaml:
//   the TypeScript types and operations of @tjalve/memex-node-client (src/generated/node-api.ts), and,
//   with --csharp <file>, the C# models and operations of Memex.Node.Client (memex.node).
//
//   node scripts/generate.mjs                     write src/generated/node-api.ts
//   node scripts/generate.mjs --check             exit 1 when src/generated/node-api.ts is not current
//   node scripts/generate.mjs --csharp <file>     also write the C# file
//   node scripts/generate.mjs --csharp <file> --check
//
// The generator reads only the contract files of this repository. It has no other input.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..", "..");
const specPath = path.join(repo, "openapi", "node.v1.yaml");
const tsOut = path.join(here, "..", "src", "generated", "node-api.ts");

// ---------- the model ----------

/**
 * A type of the model:
 *   { kind: "string" | "integer" | "number" | "boolean" | "json" }   json is an object that the contract does not restate
 *   { kind: "string", values: [...] }                                an enum or a const; open in C# (string)
 *   { kind: "integer", values: [...] }
 *   { kind: "array", items }
 *   { kind: "map", values }
 *   { kind: "ref", name }                                            a named type
 *   and any of them with nullable: true
 * A named type is { name, description, type } where type is one of the above or
 *   { kind: "object", props: [{ json, type, required, description }] }
 */
const named = new Map(); // name -> { name, description, type }
const order = [];

/** Names of the C# and TypeScript types that differ from the component name (a record cannot have a member of its own name). */
const RENAME = { Error: "ErrorBody" };
const NESTED_NAME = { ErrorBodyError: "ErrorDetail" };

const text = fs.readFileSync(specPath, "utf8");
const specSha256 = createHash("sha256").update(text.replace(/\r\n/g, "\n")).digest("hex");
const spec = parseYaml(text);

function pascal(value) {
  return value
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((s) => s[0].toUpperCase() + s.slice(1))
    .join("");
}

function componentName(ref) {
  const name = ref.slice("#/components/schemas/".length);
  return RENAME[name] ?? name;
}

/** Loads a schema that a $ref names outside this file (relative to openapi/). */
function external(ref) {
  const file = path.resolve(repo, "openapi", ref);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** The opaque external schemas: they are objects that the client passes on whole. */
const OPAQUE_EXTERNAL = new Set(["../schemas/packs/pack.json"]);

function resolveRef(schema) {
  if (!schema.$ref) return schema;
  if (schema.$ref.startsWith("#/components/schemas/")) return resolveRef(spec.components.schemas[schema.$ref.slice(21)]);
  return external(schema.$ref);
}

function isNull(schema) {
  return schema && (schema.type === "null" || (Array.isArray(schema.type) && schema.type.length === 1 && schema.type[0] === "null"));
}

function define(name, description, build) {
  if (named.has(name)) return { kind: "ref", name };
  const entry = { name, description, type: null };
  named.set(name, entry);
  order.push(name);
  entry.type = build();
  return { kind: "ref", name };
}

/** Merges object schemas (allOf, or the object branches of a oneOf) into one list of properties. */
function mergeObjects(schemas, nameHint, requiredIn) {
  const props = new Map();
  const requiredCount = new Map();
  for (const raw of schemas) {
    const s = resolveRef(raw);
    for (const [json, prop] of Object.entries(s.properties ?? {})) {
      if (!props.has(json)) props.set(json, prop);
      else props.set(json, mergeProp(props.get(json), prop));
    }
    for (const r of s.required ?? []) requiredCount.set(r, (requiredCount.get(r) ?? 0) + 1);
  }
  return [...props].map(([json, prop]) => ({
    json,
    type: toType(prop, nameHint + pascal(json)),
    required: requiredIn === "all" ? requiredCount.get(json) === schemas.length : (requiredCount.get(json) ?? 0) > 0,
    description: prop.description,
  }));
}

/** The kind const of two oneOf branches becomes one enum. */
function mergeProp(a, b) {
  const values = [...(a.enum ?? (a.const !== undefined ? [a.const] : [])), ...(b.enum ?? (b.const !== undefined ? [b.const] : []))];
  if (values.length) return { type: "string", enum: [...new Set(values)] };
  return a;
}

function objectType(schema, nameHint) {
  const props = mergeObjects([schema], nameHint, "any");
  return { kind: "object", props };
}

function toType(schema, nameHint) {
  if (schema === undefined || schema === true) return { kind: "json" };
  if (schema.$ref) {
    if (schema.$ref.startsWith("#/components/schemas/")) {
      const source = schema.$ref.slice(21);
      ensureComponent(source);
      return { kind: "ref", name: componentName(schema.$ref) };
    }
    if (OPAQUE_EXTERNAL.has(schema.$ref)) return { kind: "json" };
    return toType(external(schema.$ref), nameHint);
  }
  if (schema.oneOf) {
    const nulls = schema.oneOf.filter(isNull);
    const rest = schema.oneOf.filter((s) => !isNull(s));
    // oneOf of required lists only (ModelUsed: sha256 or fingerprint) adds no shape.
    if (rest.every((s) => !s.type && !s.properties && !s.$ref && s.required) && (schema.properties || schema.type)) {
      const { oneOf, ...plain } = schema;
      return toType(plain, nameHint);
    }
    let type;
    if (rest.length === 1) type = toType(rest[0], nameHint);
    else {
      const resolved = rest.map(resolveRef);
      if (resolved.every((s) => s.type === "object" || s.properties)) {
        type = define(nameHint, schema.description, () => ({ kind: "object", props: mergeObjects(rest, nameHint, "all") }));
      } else type = { kind: "json" };
    }
    return nulls.length ? { ...type, nullable: true } : type;
  }
  if (schema.allOf) {
    return define(nameHint, schema.description, () => ({ kind: "object", props: mergeObjects(schema.allOf, nameHint, "any") }));
  }
  let type = schema.type;
  let nullable = false;
  if (Array.isArray(type)) {
    nullable = type.includes("null");
    const others = type.filter((t) => t !== "null");
    type = others.length === 1 ? others[0] : undefined;
  }
  const withNull = (t) => (nullable ? { ...t, nullable: true } : t);
  if (typeof schema.const === "boolean") return withNull({ kind: "boolean", values: [schema.const] });
  if (schema.const !== undefined) return withNull({ kind: typeof schema.const === "number" ? "integer" : "string", values: [schema.const] });
  if (schema.enum) return withNull({ kind: schema.enum.every((v) => typeof v === "number") ? "integer" : "string", values: schema.enum });
  if (type === "array") {
    if (schema.prefixItems) return withNull({ kind: "array", items: toType(schema.prefixItems[0], nameHint + "Item") });
    return withNull({ kind: "array", items: toType(schema.items, nameHint + "Item") });
  }
  if (type === "object" || (type === undefined && schema.properties)) {
    if (schema.properties) return withNull(define(nameHint, schema.description, () => objectType(schema, nameHint)));
    if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
      return withNull({ kind: "map", values: toType(schema.additionalProperties, nameHint + "Value") });
    }
    return withNull({ kind: "json" });
  }
  if (type === "string") return withNull({ kind: "string", format: schema.format });
  if (type === "integer") return withNull({ kind: "integer" });
  if (type === "number") return withNull({ kind: "number" });
  if (type === "boolean") return withNull({ kind: "boolean" });
  return withNull({ kind: "json" });
}

/** A component schema: an object or union becomes a named object; any other schema a named alias. */
function ensureComponent(source) {
  const name = RENAME[source] ?? source;
  if (named.has(name)) return;
  let schema = spec.components.schemas[source];
  if (schema.$ref && !schema.$ref.startsWith("#")) schema = external(schema.$ref);
  const entry = { name, description: schema.description ?? schema.title, type: null };
  named.set(name, entry);
  order.push(name);
  const nestedHint = (n) => NESTED_NAME[n] ?? n;
  if (schema.allOf) entry.type = { kind: "object", props: mergeObjects(schema.allOf, name, "any") };
  else if (schema.properties && !schema.oneOf) entry.type = objectType(schema, name);
  else if (schema.oneOf && schema.oneOf.filter((s) => !isNull(s)).every((s) => resolveRef(s).type === "object" || resolveRef(s).properties)) {
    entry.type = { kind: "object", props: mergeObjects(schema.oneOf.filter((s) => !isNull(s)), name, "all") };
  } else if (schema.properties) entry.type = objectType(schema, name);
  else entry.type = toType(schema, name);
  // Nested names that would clash (ErrorBody.error -> ErrorDetail).
  for (const [from, to] of Object.entries(NESTED_NAME)) {
    if (named.has(from) && !named.has(to)) {
      const e = named.get(from);
      named.delete(from);
      e.name = to;
      named.set(to, e);
      order[order.indexOf(from)] = to;
      renameRefs(from, to);
    }
  }
  void nestedHint;
}

function renameRefs(from, to) {
  const visit = (t) => {
    if (!t) return;
    if (t.kind === "ref" && t.name === from) t.name = to;
    if (t.kind === "array") visit(t.items);
    if (t.kind === "map") visit(t.values);
    if (t.kind === "object") t.props.forEach((p) => visit(p.type));
  };
  for (const e of named.values()) visit(e.type);
}

for (const source of Object.keys(spec.components.schemas)) ensureComponent(source);

// ---------- operations ----------

const METHODS = ["get", "put", "post", "patch", "delete"];
const operations = [];

function resolveParam(p) {
  return p.$ref ? spec.components.parameters[p.$ref.slice("#/components/parameters/".length)] : p;
}

function bodyOf(op, opName) {
  const body = op.requestBody;
  if (!body) return null;
  const [contentType, media] = Object.entries(body.content)[0];
  if (contentType === "application/json") return { kind: "json", required: body.required === true, type: toType(media.schema, pascal(opName) + "Request") };
  if (contentType === "multipart/form-data") return { kind: "multipart", required: true };
  return { kind: "bytes", required: true };
}

function responseOf(op, opName) {
  const codes = Object.keys(op.responses).filter((c) => /^2\d\d$|^101$/.test(c));
  const code = codes[0];
  const response = op.responses[code];
  if (code === "101") return { kind: "websocket", status: 101 };
  if (!response.content) return { kind: "none", status: Number(code) };
  const types = Object.keys(response.content);
  const first = types[0];
  const media = response.content[first];
  const stream = types.includes("text/event-stream");
  if (first === "application/json") return { kind: "json", status: Number(code), type: toType(media.schema, pascal(opName) + "Response"), stream };
  if (first === "text/event-stream") return { kind: "events", status: Number(code) };
  if (first === "text/plain") return { kind: "text", status: Number(code) };
  return { kind: "bytes", status: Number(code), headers: Object.keys(response.headers ?? {}) };
}

for (const [route, item] of Object.entries(spec.paths)) {
  const shared = (item.parameters ?? []).map(resolveParam);
  for (const method of METHODS) {
    const op = item[method];
    if (!op) continue;
    const params = [...shared, ...(op.parameters ?? []).map(resolveParam)];
    operations.push({
      id: op.operationId,
      method: method.toUpperCase(),
      route,
      summary: op.summary,
      path: params.filter((p) => p.in === "path").map((p) => ({ name: p.name, type: toType(p.schema, "") })),
      query: params.filter((p) => p.in === "query").map((p) => ({ name: p.name, required: p.required === true, type: toType(p.schema, "") })),
      headers: params.filter((p) => p.in === "header").map((p) => ({ name: p.name, required: p.required === true, type: toType(p.schema, "") })),
      body: bodyOf(op, op.operationId),
      response: responseOf(op, op.operationId),
    });
  }
}

// ---------- TypeScript ----------

function tsType(t) {
  let out;
  switch (t.kind) {
    case "string":
    case "integer":
      out = t.values ? t.values.map((v) => JSON.stringify(v)).join(" | ") : t.kind === "integer" ? "number" : "string";
      break;
    case "number":
      out = "number";
      break;
    case "boolean":
      out = t.values ? t.values.map((v) => JSON.stringify(v)).join(" | ") : "boolean";
      break;
    case "json":
      out = "Record<string, unknown>";
      break;
    case "array": {
      const inner = tsType(t.items);
      out = /[ |]/.test(inner) ? `Array<${inner}>` : `${inner}[]`;
      break;
    }
    case "map":
      out = `Record<string, ${tsType(t.values)}>`;
      break;
    case "ref":
      out = t.name;
      break;
    default:
      throw new Error(`No TypeScript type for ${JSON.stringify(t)}`);
  }
  return t.nullable ? `${out} | null` : out;
}

function doc(description, indent = "") {
  if (!description) return "";
  const line = description.replace(/\s+/g, " ").trim().replace(/\*\//g, "*\\/");
  return `${indent}/** ${line} */\n`;
}

function headerParamName(name) {
  // Memex-App -> memexApp
  const p = pascal(name);
  return p[0].toLowerCase() + p.slice(1);
}

function generateTs() {
  const lines = [];
  lines.push(`// Generated from openapi/node.v1.yaml by scripts/generate.mjs. Do not edit.`);
  lines.push(`// The sha256 of the contract file (LF line ends): ${specSha256}`);
  lines.push(``);
  lines.push(`export const NODE_CONTRACT_SHA256 = ${JSON.stringify(specSha256)};`);
  lines.push(``);
  for (const name of order) {
    const e = named.get(name);
    lines.push(doc(e.description).trimEnd());
    if (e.type.kind === "object") {
      lines.push(`export interface ${name} {`);
      for (const p of e.type.props) {
        if (p.description) lines.push(doc(p.description, "  ").trimEnd());
        const key = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(p.json) ? p.json : JSON.stringify(p.json);
        lines.push(`  ${key}${p.required ? "" : "?"}: ${tsType(p.type)};`);
      }
      lines.push(`}`);
    } else {
      lines.push(`export type ${name} = ${tsType(e.type)};`);
    }
    lines.push(``);
  }
  // Operations
  lines.push(`/** How a response body is read. */`);
  lines.push(`export type ResponseKind = "json" | "events" | "text" | "bytes" | "none" | "websocket";`);
  lines.push(``);
  lines.push(`/** One request of an operation, for NodeApiBase.send. */`);
  lines.push(`export interface OperationRequest {`);
  lines.push(`  operation: string;`);
  lines.push(`  method: "GET" | "PUT" | "POST" | "PATCH" | "DELETE";`);
  lines.push(`  path: string;`);
  lines.push(`  query?: Record<string, string | undefined>;`);
  lines.push(`  headers?: Record<string, string | undefined>;`);
  lines.push(`  body?: { kind: "json"; value: unknown } | { kind: "bytes"; value: Uint8Array; mediaType: string };`);
  lines.push(`  response: ResponseKind;`);
  lines.push(`  /** The status of success. */`);
  lines.push(`  status: number;`);
  lines.push(`}`);
  lines.push(``);
  lines.push(`/** A server-sent event. data is the parsed JSON when it is JSON, else the text. */`);
  lines.push(`export interface NodeEvent {`);
  lines.push(`  event: string;`);
  lines.push(`  data: unknown;`);
  lines.push(`}`);
  lines.push(``);
  lines.push(`/** A binary response: the bytes, their media type, and the response headers. */`);
  lines.push(`export interface NodeBinary {`);
  lines.push(`  mediaType: string;`);
  lines.push(`  bytes: Uint8Array;`);
  lines.push(`  headers: Record<string, string>;`);
  lines.push(`}`);
  lines.push(``);
  lines.push(`/** Every operation of the contract: method, path, and how its response is read. */`);
  lines.push(`export const NODE_OPERATIONS = {`);
  for (const op of operations) {
    lines.push(`  ${op.id}: { method: ${JSON.stringify(op.method)}, path: ${JSON.stringify(op.route)}, response: ${JSON.stringify(op.response.kind)} },`);
  }
  lines.push(`} as const;`);
  lines.push(``);
  lines.push(`export type NodeOperation = keyof typeof NODE_OPERATIONS;`);
  lines.push(``);
  lines.push(`/**`);
  lines.push(` * The operations of the Memex.Node API as methods. A subclass sends the requests (NodeClient: over the pipe or socket`);
  lines.push(` * of the app record). The realtime WebSocket is not a method: open realtimePath(session) on the same transport.`);
  lines.push(` */`);
  lines.push(`export abstract class NodeApiBase {`);
  lines.push(`  protected abstract send(request: OperationRequest): Promise<unknown>;`);
  lines.push(``);
  for (const op of operations) {
    if (op.response.kind === "websocket") {
      lines.push(`  /** ${op.summary ?? op.id}. The path to open as a WebSocket. */`);
      lines.push(`  ${op.id}Path(session: string): string {`);
      lines.push(`    return \`${op.route}?session=\${encodeURIComponent(session)}\`;`);
      lines.push(`  }`);
      lines.push(``);
      continue;
    }
    const args = [];
    for (const p of op.path) args.push(`${p.name}: string`);
    if (op.headers.length) {
      const required = op.headers.some((h) => h.required);
      args.push(`headers${required ? "" : "?"}: { ${op.headers.map((h) => `${headerParamName(h.name)}${h.required ? "" : "?"}: ${tsType(h.type)}`).join("; ")} }`);
    }
    if (op.query.length) {
      const required = op.query.some((q) => q.required);
      args.push(`query${required ? "" : "?"}: { ${op.query.map((q) => `${q.name}${q.required ? "" : "?"}: ${tsType(q.type)}`).join("; ")} }`);
    }
    if (op.body?.kind === "json") args.push(`body${op.body.required ? "" : "?"}: ${tsType(op.body.type)}`);
    if (op.body?.kind === "bytes") args.push(`body: Uint8Array`, `mediaType: string`);
    if (op.body?.kind === "multipart") args.push(`body: Uint8Array`, `contentType: string`);
    const result =
      op.response.kind === "json" ? tsType(op.response.type)
      : op.response.kind === "events" ? "AsyncIterable<NodeEvent>"
      : op.response.kind === "text" ? "string"
      : op.response.kind === "bytes" ? "NodeBinary"
      : "void";
    const returns = op.response.kind === "events" ? `Promise<${result}>` : `Promise<${result}>`;
    const pathExpr = "`" + op.route.replace(/\{(\w+)\}/g, (_, n) => `\${encodeURIComponent(${n})}`) + "`";
    lines.push(`  /** ${(op.summary ?? op.id).replace(/\*\//g, "")} (${op.method} ${op.route}) */`);
    lines.push(`  ${op.id}(${args.join(", ")}): ${returns} {`);
    const fields = [`operation: ${JSON.stringify(op.id)}`, `method: ${JSON.stringify(op.method)}`, `path: ${pathExpr}`];
    if (op.query.length) fields.push(`query: { ${op.query.map((q) => `${JSON.stringify(q.name)}: query?.${q.name} === undefined ? undefined : String(query.${q.name})`).join(", ")} }`);
    if (op.headers.length) fields.push(`headers: { ${op.headers.map((h) => `${JSON.stringify(h.name)}: headers?.${headerParamName(h.name)}`).join(", ")} }`);
    if (op.body?.kind === "json") fields.push(op.body.required ? `body: { kind: "json", value: body }` : `body: body === undefined ? undefined : { kind: "json", value: body }`);
    if (op.body?.kind === "bytes") fields.push(`body: { kind: "bytes", value: body, mediaType }`);
    if (op.body?.kind === "multipart") fields.push(`body: { kind: "bytes", value: body, mediaType: contentType }`);
    fields.push(`response: ${JSON.stringify(op.response.kind)}`, `status: ${op.response.status}`);
    lines.push(`    return this.send({ ${fields.join(", ")} }) as ${returns};`);
    lines.push(`  }`);
    lines.push(``);
  }
  while (lines[lines.length - 1] === "") lines.pop();
  lines.push(`}`);
  return lines.filter((l, i, all) => !(l === "" && all[i - 1] === "")).join("\n");
}

// ---------- C# ----------

const CS_KEYWORDS = new Set(["default", "event", "object", "string", "base", "params", "namespace", "class", "operator", "checked", "lock"]);

function csType(t, { forProp = true } = {}) {
  let out;
  switch (t.kind) {
    case "string":
      out = t.format === "date-time" ? "DateTimeOffset" : "string";
      break;
    case "integer":
      out = "long";
      break;
    case "number":
      out = "double";
      break;
    case "boolean":
      out = "bool";
      break;
    case "json":
      out = "JsonObject";
      break;
    case "array":
      out = `IReadOnlyList<${csType(t.items, { forProp: false })}>`;
      break;
    case "map":
      out = `IReadOnlyDictionary<string, ${csType(t.values, { forProp: false })}>`;
      break;
    case "ref": {
      const target = named.get(t.name);
      out = target.type.kind === "object" ? t.name : csType(target.type, { forProp: false }).replace(/\?$/, "");
      break;
    }
    default:
      throw new Error(`No C# type for ${JSON.stringify(t)}`);
  }
  void forProp;
  return t.nullable ? `${out}?` : out;
}

function csDoc(description, indent) {
  if (!description) return [];
  const line = description.replace(/\s+/g, " ").trim().replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return [`${indent}/// <summary>${line}</summary>`];
}

function csString(value) {
  return JSON.stringify(value);
}

function generateCs() {
  const L = [];
  L.push(`// <auto-generated>`);
  L.push(`// Generated from memex.core openapi/node.v1.yaml by packages/node-client/scripts/generate.mjs. Do not edit.`);
  L.push(`// The sha256 of the contract file (LF line ends): ${specSha256}`);
  L.push(`// </auto-generated>`);
  L.push(`#nullable enable`);
  L.push(`using System.Net.Http;`);
  L.push(`using System.Text.Json;`);
  L.push(`using System.Text.Json.Nodes;`);
  L.push(`using System.Text.Json.Serialization;`);
  L.push(``);
  L.push(`namespace Memex.Node.Client;`);
  L.push(``);
  L.push(`/// <summary>The contract file that this code was generated from.</summary>`);
  L.push(`public static partial class NodeContract`);
  L.push(`{`);
  L.push(`    /// <summary>The sha256 of openapi/node.v1.yaml (LF line ends).</summary>`);
  L.push(`    public const string Sha256 = ${csString(specSha256)};`);
  L.push(``);
  L.push(`    /// <summary>The C# type of each component schema that is an object, by its name in the contract.</summary>`);
  L.push(`    public static readonly IReadOnlyDictionary<string, Type> Types = new Dictionary<string, Type>`);
  L.push(`    {`);
  for (const source of Object.keys(spec.components.schemas)) {
    const name = RENAME[source] ?? source;
    if (named.get(name).type.kind === "object") L.push(`        [${csString(source)}] = typeof(${name}),`);
  }
  L.push(`    };`);
  L.push(`}`);
  L.push(``);
  // Constants for named enums.
  for (const name of order) {
    const e = named.get(name);
    if (e.type.kind === "string" && e.type.values && e.type.values.length > 1) {
      L.push(...csDoc(e.description ?? `The values of ${name}.`, ""));
      L.push(`public static class ${name}Values`);
      L.push(`{`);
      for (const v of e.type.values) L.push(`    public const string ${pascal(String(v))} = ${csString(v)};`);
      L.push(`}`);
      L.push(``);
    }
  }
  for (const name of order) {
    const e = named.get(name);
    if (e.type.kind !== "object") continue;
    L.push(...csDoc(e.description, ""));
    L.push(`public sealed partial record ${name}`);
    L.push(`{`);
    for (const p of e.type.props) {
      let prop = pascal(p.json);
      if (prop === name) prop = `${prop}Value`;
      const nullable = p.type.nullable === true;
      let type = csType(p.type);
      L.push(...csDoc(p.description, "    "));
      L.push(`    [JsonPropertyName(${csString(p.json)})]`);
      if (p.required) {
        L.push(`    [JsonRequired]`);
        if (nullable) L.push(`    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]`);
        L.push(`    public required ${type} ${prop} { get; init; }`);
      } else if (nullable) {
        // Optional and nullable: absent and null differ (BackendPatch.apiKey: null removes the key), so Optional<T>.
        L.push(`    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)]`);
        L.push(`    public Optional<${type}> ${prop} { get; init; }`);
      } else {
        if (!type.endsWith("?")) type += "?";
        L.push(`    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]`);
        L.push(`    public ${type} ${prop} { get; init; }`);
      }
      L.push(``);
    }
    L.push(`    /// <summary>Fields that this version of the client does not know. They are written back unchanged.</summary>`);
    L.push(`    [JsonExtensionData]`);
    L.push(`    public IDictionary<string, JsonElement>? Extra { get; set; }`);
    L.push(`}`);
    L.push(``);
  }
  // Operations
  L.push(`/// <summary>The operations of the Memex.Node API. The transport is in the other part of this class.</summary>`);
  L.push(`public sealed partial class NodeApi`);
  L.push(`{`);
  for (const op of operations) {
    const name = pascal(op.id);
    if (op.response.kind === "websocket") {
      L.push(`    /// <summary>${op.summary ?? op.id}. The path to open as a WebSocket.</summary>`);
      L.push(`    public static string ${name}Path(string session) => "${op.route}?session=" + Uri.EscapeDataString(session);`);
      L.push(``);
      continue;
    }
    const args = [];
    for (const p of op.path) args.push(`string ${p.name}`);
    for (const h of op.headers.filter((h) => h.required)) args.push(`${csType(h.type)} ${headerParamName(h.name)}`);
    if (op.body?.kind === "json" && op.body.required) args.push(`${csType(op.body.type)} body`);
    if (op.body?.kind === "bytes" || op.body?.kind === "multipart") args.push(`HttpContent body`);
    for (const q of op.query.filter((q) => q.required)) args.push(`${csType(q.type)} ${q.name}`);
    for (const h of op.headers.filter((h) => !h.required)) args.push(`${csType(h.type).replace(/\?$/, "")}? ${headerParamName(h.name)} = null`);
    for (const q of op.query.filter((q) => !q.required)) args.push(`${csType(q.type).replace(/\?$/, "")}? ${CS_KEYWORDS.has(q.name) ? "@" + q.name : q.name} = null`);
    if (op.body?.kind === "json" && !op.body.required) args.push(`${csType(op.body.type).replace(/\?$/, "")}? body = null`);
    args.push(`CancellationToken cancellationToken = default`);
    const pathExpr = '$"' + op.route.replace(/\{(\w+)\}/g, (_, n) => `{Uri.EscapeDataString(${n})}`) + '"';
    const query = op.query.length
      ? `Query(${op.query.map((q) => `(${csString(q.name)}, ${CS_KEYWORDS.has(q.name) ? "@" + q.name : q.name}?.ToString())`).join(", ")})`
      : "null";
    const headers = op.headers.length ? `Headers(${op.headers.map((h) => `(${csString(h.name)}, ${headerParamName(h.name)}?.ToString())`).join(", ")})` : "null";
    const content =
      op.body?.kind === "json" ? (op.body.required ? "Json(body)" : "body is null ? null : Json(body)")
      : op.body ? "body"
      : "null";
    const method = `HttpMethod.${op.method[0] + op.method.slice(1).toLowerCase()}`;
    L.push(`    /// <summary>${(op.summary ?? op.id).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")} (${op.method} ${op.route})</summary>`);
    const call = `${method}, ${pathExpr}, ${query}, ${headers}, ${content}, ${op.response.status}, cancellationToken`;
    switch (op.response.kind) {
      case "json": {
        const type = csType(op.response.type);
        L.push(`    public Task<${type}> ${name}Async(${args.join(", ")}) =>`);
        L.push(`        SendJsonAsync<${type}>(${call});`);
        break;
      }
      case "events":
        L.push(`    public IAsyncEnumerable<NodeEvent> ${name}Async(${args.join(", ")}) =>`);
        L.push(`        ReadEventsAsync(${call});`);
        break;
      case "text":
        L.push(`    public Task<string> ${name}Async(${args.join(", ")}) =>`);
        L.push(`        SendTextAsync(${call});`);
        break;
      case "bytes":
        L.push(`    public Task<NodeBinary> ${name}Async(${args.join(", ")}) =>`);
        L.push(`        SendBinaryAsync(${call});`);
        break;
      default:
        L.push(`    public Task ${name}Async(${args.join(", ")}) =>`);
        L.push(`        SendEmptyAsync(${call});`);
    }
    L.push(``);
  }
  L.push(`}`);
  L.push(``);
  return L.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\n\n}/g, "\n}");
}

// ---------- write or check ----------

const args = process.argv.slice(2);
const check = args.includes("--check");
const csIndex = args.indexOf("--csharp");
const outputs = [[tsOut, generateTs() + "\n"]];
if (csIndex >= 0) {
  const file = args[csIndex + 1];
  if (!file) {
    console.error("--csharp needs a file.");
    process.exit(2);
  }
  outputs.push([path.resolve(file), generateCs().replace(/\n*$/, "\n")]);
}
let stale = 0;
for (const [file, content] of outputs) {
  if (check) {
    const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n") : null;
    if (current !== content) {
      console.error(`${path.relative(process.cwd(), file)} is not current. Run node packages/node-client/scripts/generate.mjs.`);
      stale++;
    }
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    console.log(`Wrote ${path.relative(process.cwd(), file)} (${content.split("\n").length} lines).`);
  }
}
process.exit(stale ? 1 : 0);
