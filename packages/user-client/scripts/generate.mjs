#!/usr/bin/env node
// Generates the clients of the two facts hubs from their OpenAPI files:
//   openapi/user.v1.yaml      -> src/generated/user-api.ts      (and UserApi.g.cs)
//   openapi/contacts.v1.yaml  -> src/generated/contacts-api.ts  (and ContactsApi.g.cs)
// The TypeScript files are part of @tjalve/memex-user-client. The C# files are part of Memex.User.Client in memex.node.
//
//   node scripts/generate.mjs                       write the TypeScript files
//   node scripts/generate.mjs --check               exit 1 when a TypeScript file is not current
//   node scripts/generate.mjs --csharp <folder>     also write the C# files into the folder
//   node scripts/generate.mjs --csharp <folder> --check
//
// The generator reads only the contract files of this repository (the OpenAPI files and the JSON Schemas they name).
// Every named type gets the prefix of its hub (UserRecord, ContactsRecord), so both hubs can be used side by side.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..", "..");

const HUBS = [
  { hub: "user", prefix: "User", spec: "openapi/user.v1.yaml", ts: "user-api.ts", cs: "UserApi.g.cs", common: "schemas/user/common.json" },
  { hub: "contacts", prefix: "Contacts", spec: "openapi/contacts.v1.yaml", ts: "contacts-api.ts", cs: "ContactsApi.g.cs", common: "schemas/contacts/common.json" },
];

// ---------- documents and references ----------

const docs = new Map();

function loadDoc(file) {
  if (!docs.has(file)) {
    const text = fs.readFileSync(file, "utf8");
    docs.set(file, file.endsWith(".yaml") ? parseYaml(text) : JSON.parse(text));
  }
  return docs.get(file);
}

function pointer(doc, frag) {
  if (!frag || frag === "/") return doc;
  let node = doc;
  for (const raw of frag.replace(/^\//, "").split("/")) {
    const part = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    node = node?.[part];
    if (node === undefined) throw new Error(`No ${frag}`);
  }
  return node;
}

/** Resolves a $ref against the file that holds it: { schema, file, frag, key }. */
function deref(ref, file) {
  const [target, frag = ""] = ref.split("#");
  const abs = target ? path.resolve(path.dirname(file), target) : file;
  return { schema: pointer(loadDoc(abs), frag), file: abs, frag, key: `${path.relative(repo, abs).replace(/\\/g, "/")}#${frag}` };
}

function pascal(value) {
  return String(value)
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((s) => s[0].toUpperCase() + s.slice(1))
    .join("");
}

function isNull(schema) {
  return schema && (schema.type === "null" || (Array.isArray(schema.type) && schema.type.length === 1 && schema.type[0] === "null"));
}

// ---------- the model of one hub ----------

/**
 * A type: { kind: "string" | "integer" | "number" | "boolean" | "object" (an open object) | "any" (any JSON) }, with
 * values for an enum or const and format for a string; { kind: "array", items }; { kind: "map", values };
 * { kind: "union", of } (TypeScript writes the union, C# a JsonNode); { kind: "ref", name }; any of them nullable.
 * A named type is { name, description, props: [{ json, type, required, description }] }.
 */
function buildModel(hub) {
  const specFile = path.join(repo, hub.spec);
  const specText = fs.readFileSync(specFile, "utf8");
  const sha256 = createHash("sha256").update(specText.replace(/\r\n/g, "\n")).digest("hex");
  const spec = loadDoc(specFile);
  const named = new Map();
  const order = [];
  const byKey = new Map(); // schema location -> type name
  const componentTypes = []; // [component name, type name] for the fixture index

  const nameFor = (base) => {
    let name = hub.prefix + base;
    if (name === hub.prefix + "Error") name = hub.prefix + "ErrorBody";
    if (name === hub.prefix + "ErrorBodyError") name = hub.prefix + "ErrorDetail";
    return name;
  };

  function define(name, description, build) {
    if (named.has(name)) return { kind: "ref", name };
    const entry = { name, description, props: null };
    named.set(name, entry);
    order.push(name);
    entry.props = build();
    return { kind: "ref", name };
  }

  /** The properties of an object schema, with the plain object members of its allOf (conditionals add no shape). */
  function propsOf(schema, file, hint) {
    const props = new Map();
    const required = new Set(schema.required ?? []);
    const add = (s, f) => {
      for (const [json, prop] of Object.entries(s.properties ?? {})) if (!props.has(json)) props.set(json, { prop, file: f });
    };
    add(schema, file);
    for (const part of schema.allOf ?? []) {
      if (part.properties && !part.if) {
        add(part, file);
        for (const r of part.required ?? []) required.add(r);
      }
    }
    return [...props].map(([json, { prop, file: f }]) => ({
      json,
      type: toType(prop, f, hint + pascal(json)),
      required: required.has(json),
      description: prop.description ?? (prop.$ref ? refDescription(prop, f) : undefined),
    }));
  }

  function refDescription(prop, file) {
    try {
      return deref(prop.$ref, file).schema.description;
    } catch {
      return undefined;
    }
  }

  function isObjectSchema(s) {
    return s && (s.type === "object" || (s.type === undefined && s.properties)) && s.properties;
  }

  function toType(schema, file, hint) {
    if (schema === undefined || schema === true) return { kind: "any" };
    if (schema.$ref) {
      const r = deref(schema.$ref, file);
      if (byKey.has(r.key)) return { kind: "ref", name: byKey.get(r.key) };
      const target = r.schema;
      if (isObjectSchema(target) || (target.oneOf && target.oneOf.every((s) => isObjectSchema(s.$ref ? deref(s.$ref, r.file).schema : s)))) {
        const base = r.frag ? pascal(r.frag.split("/").pop()) : pascal(path.basename(r.file, ".json"));
        const name = nameFor(base);
        if (named.has(name)) throw new Error(`Two schemas give the type name ${name}: ${r.key} and another one.`);
        byKey.set(r.key, name);
        return toType(target, r.file, name.slice(hub.prefix.length));
      }
      return toType(target, r.file, hint);
    }
    if (schema.oneOf || schema.anyOf) {
      const list = schema.oneOf ?? schema.anyOf;
      // anyOf / oneOf of required lists only adds no shape.
      if (list.every((s) => !s.type && !s.properties && !s.$ref && (s.required || s.not)) && (schema.properties || schema.type)) {
        const { oneOf, anyOf, ...plain } = schema;
        return toType(plain, file, hint);
      }
      const nulls = list.filter(isNull);
      const rest = list.filter((s) => !isNull(s));
      let type;
      if (rest.length === 1) type = toType(rest[0], file, hint);
      else {
        const resolved = rest.map((s) => (s.$ref ? deref(s.$ref, file) : { schema: s, file }));
        if (resolved.every((r) => isObjectSchema(r.schema))) {
          // One object with the properties of every branch; a property is required when every branch requires it.
          const name = nameFor(hint);
          type = define(name, schema.description, () => {
            const props = new Map();
            const count = new Map();
            for (const r of resolved) {
              for (const p of propsOf(r.schema, r.file, hint)) {
                if (!props.has(p.json)) props.set(p.json, p);
                if (p.required) count.set(p.json, (count.get(p.json) ?? 0) + 1);
              }
            }
            return [...props.values()].map((p) => ({ ...p, required: count.get(p.json) === resolved.length }));
          });
        } else type = { kind: "union", of: rest.map((s, i) => toType(s, file, hint + "Option" + (i + 1))) };
      }
      return nulls.length ? { ...type, nullable: true } : type;
    }
    let t = schema.type;
    let nullable = false;
    if (Array.isArray(t)) {
      nullable = t.includes("null");
      const others = t.filter((x) => x !== "null");
      t = others.length === 1 ? others[0] : undefined;
    }
    const withNull = (x) => (nullable ? { ...x, nullable: true } : x);
    if (typeof schema.const === "boolean") return withNull({ kind: "boolean", values: [schema.const] });
    if (schema.const !== undefined) return withNull({ kind: typeof schema.const === "number" ? "integer" : "string", values: [schema.const] });
    if (schema.enum) return withNull({ kind: schema.enum.every((v) => typeof v === "number") ? "integer" : "string", values: schema.enum });
    if (t === "array") return withNull({ kind: "array", items: toType(schema.items, file, hint + "Item") });
    if (t === "object" || (t === undefined && schema.properties)) {
      if (schema.properties) {
        const name = nameFor(hint);
        return withNull(define(name, schema.description ?? schema.title, () => propsOf(schema, file, hint)));
      }
      if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        return withNull({ kind: "map", values: toType(schema.additionalProperties, file, hint + "Value") });
      }
      return withNull({ kind: "object" });
    }
    if (t === "string") return withNull({ kind: "string", format: schema.format });
    if (t === "integer") return withNull({ kind: "integer" });
    if (t === "number") return withNull({ kind: "number" });
    if (t === "boolean") return withNull({ kind: "boolean" });
    return withNull({ kind: "any" });
  }

  // Component schemas first, in contract order; the component name is the base of the type name.
  for (const [source, schema] of Object.entries(spec.components.schemas)) {
    const name = nameFor(source);
    let target = schema;
    let file = specFile;
    if (schema.$ref) {
      const r = deref(schema.$ref, specFile);
      byKey.set(r.key, name);
      target = r.schema;
      file = r.file;
    }
    byKey.set(`${hub.spec}#/components/schemas/${source}`, name);
    if (target.oneOf && !target.properties) {
      toType({ $ref: `#/components/schemas/${source}` }, specFile, source);
    } else {
      define(name, target.description ?? target.title, () => propsOf(target, file, name.slice(hub.prefix.length)));
    }
    componentTypes.push([source, name]);
  }

  // The fields of each kind (kindFields of the hub's common.json): <Hub><Kind>Fields.
  const commonFile = path.join(repo, hub.common);
  const kindFields = loadDoc(commonFile).$defs.kindFields.allOf;
  const kinds = [];
  for (const branch of kindFields) {
    const kind = branch.if.properties.kind.const;
    const ref = branch.then.properties.fields.$ref;
    const r = deref(ref, commonFile);
    const name = nameFor(pascal(kind) + "Fields");
    byKey.set(r.key, name);
    define(name, r.schema.description ?? r.schema.title, () => propsOf(r.schema, r.file, pascal(kind) + "Fields"));
    kinds.push({ kind, name });
  }

  // Operations.
  const operations = [];
  for (const [route, item] of Object.entries(spec.paths)) {
    for (const method of ["get", "post"]) {
      const op = item[method];
      if (!op) continue;
      const body = op.requestBody ? toType(op.requestBody.content["application/json"].schema, specFile, pascal(op.operationId) + "Request") : null;
      const ok = op.responses["200"];
      // An operation without a 200 answer (POST /v1/drain, 202) is for the service launcher only: no client method.
      if (!ok) continue;
      const response = toType(ok.content["application/json"].schema, specFile, pascal(op.operationId) + "Response");
      operations.push({ id: op.operationId, method: method.toUpperCase(), route, summary: op.summary, body, response, auth: op.security === undefined || op.security.length > 0 });
    }
  }
  return { hub, sha256, named, order, operations, componentTypes, kinds };
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
    case "object":
      out = "Record<string, unknown>";
      break;
    case "any":
      out = "unknown";
      break;
    case "array": {
      const inner = tsType(t.items);
      out = /[ |]/.test(inner) ? `Array<${inner}>` : `${inner}[]`;
      break;
    }
    case "map":
      out = `Record<string, ${tsType(t.values)}>`;
      break;
    case "union":
      out = t.of.map(tsType).join(" | ");
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
  if (!description) return null;
  const line = description.replace(/\s+/g, " ").trim().replace(/\*\//g, "*\\/");
  return `${indent}/** ${line} */`;
}

function generateTs(model) {
  const { hub, sha256, named, order, operations, componentTypes, kinds } = model;
  const P = hub.prefix;
  const L = [];
  L.push(`// Generated from ${hub.spec} by scripts/generate.mjs. Do not edit.`);
  L.push(`// The sha256 of the contract file (LF line ends): ${sha256}`);
  L.push(``);
  L.push(`export const ${hub.hub.toUpperCase()}_CONTRACT_SHA256 = ${JSON.stringify(sha256)};`);
  L.push(``);
  for (const name of order) {
    const e = named.get(name);
    const d = doc(e.description);
    if (d) L.push(d);
    L.push(`export interface ${name} {`);
    for (const p of e.props) {
      const pd = doc(p.description, "  ");
      if (pd) L.push(pd);
      const key = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(p.json) ? p.json : JSON.stringify(p.json);
      L.push(`  ${key}${p.required ? "" : "?"}: ${tsType(p.type)};`);
    }
    L.push(`}`);
    L.push(``);
  }
  L.push(`/** The type name of each component schema of the contract. */`);
  L.push(`export const ${P.toUpperCase()}_COMPONENT_TYPES = {`);
  for (const [source, name] of componentTypes) L.push(`  ${source}: ${JSON.stringify(name)},`);
  L.push(`} as const;`);
  L.push(``);
  L.push(`/** The fields type of each record kind. */`);
  L.push(`export interface ${P}KindFields {`);
  for (const k of kinds) L.push(`  ${k.kind}: ${k.name};`);
  L.push(`}`);
  L.push(``);
  L.push(`/** The record kinds of the hub. */`);
  L.push(`export type ${P}Kind = keyof ${P}KindFields;`);
  L.push(``);
  L.push(`export const ${P.toUpperCase()}_KINDS: readonly ${P}Kind[] = [${kinds.map((k) => JSON.stringify(k.kind)).join(", ")}];`);
  L.push(``);
  L.push(`/** One request of an operation, for ${P}ApiBase.send. */`);
  L.push(`export interface ${P}OperationRequest {`);
  L.push(`  operation: string;`);
  L.push(`  method: "GET" | "POST";`);
  L.push(`  path: string;`);
  L.push(`  body?: unknown;`);
  L.push(`  /** false for /health, which takes no token. */`);
  L.push(`  auth: boolean;`);
  L.push(`}`);
  L.push(``);
  L.push(`/** Every operation of the contract: method and path. */`);
  L.push(`export const ${P.toUpperCase()}_OPERATIONS = {`);
  for (const op of operations) L.push(`  ${op.id}: { method: ${JSON.stringify(op.method)}, path: ${JSON.stringify(op.route)} },`);
  L.push(`} as const;`);
  L.push(``);
  L.push(`export type ${P}Operation = keyof typeof ${P.toUpperCase()}_OPERATIONS;`);
  L.push(``);
  L.push(`/** The operations of the ${hub.hub === "user" ? "Memex.User" : "Memex.Contacts"} API as methods. A subclass sends the requests. */`);
  L.push(`export abstract class ${P}ApiBase {`);
  L.push(`  protected abstract send(request: ${P}OperationRequest): Promise<unknown>;`);
  L.push(``);
  for (const op of operations) {
    const args = op.body ? `body: ${tsType(op.body)}` : "";
    const result = tsType(op.response);
    L.push(`  /** ${(op.summary ?? op.id).replace(/\*\//g, "")} (${op.method} ${op.route}) */`);
    L.push(`  ${op.id}(${args}): Promise<${result}> {`);
    const fields = [`operation: ${JSON.stringify(op.id)}`, `method: ${JSON.stringify(op.method)}`, `path: ${JSON.stringify(op.route)}`];
    if (op.body) fields.push(`body`);
    fields.push(`auth: ${op.auth}`);
    L.push(`    return this.send({ ${fields.join(", ")} }) as Promise<${result}>;`);
    L.push(`  }`);
    L.push(``);
  }
  while (L[L.length - 1] === "") L.pop();
  L.push(`}`);
  return L.join("\n") + "\n";
}

// ---------- C# ----------

function csType(t, named) {
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
    case "object":
      out = "JsonObject";
      break;
    case "any":
    case "union":
      out = "JsonNode";
      break;
    case "array":
      out = `IReadOnlyList<${csType(t.items, named)}>`;
      break;
    case "map":
      out = `IReadOnlyDictionary<string, ${csType(t.values, named)}>`;
      break;
    case "ref":
      out = t.name;
      break;
    default:
      throw new Error(`No C# type for ${JSON.stringify(t)}`);
  }
  // Any JSON may be null, so its C# type always takes null.
  return t.nullable || t.kind === "any" || t.kind === "union" ? `${out}?` : out;
}

function csDoc(description, indent) {
  if (!description) return [];
  const line = description.replace(/\s+/g, " ").trim().replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return [`${indent}/// <summary>${line}</summary>`];
}

function generateCs(model) {
  const { hub, sha256, named, order, operations, componentTypes, kinds } = model;
  const P = hub.prefix;
  const L = [];
  L.push(`// <auto-generated>`);
  L.push(`// Generated from memex.core ${hub.spec} by packages/user-client/scripts/generate.mjs. Do not edit.`);
  L.push(`// The sha256 of the contract file (LF line ends): ${sha256}`);
  L.push(`// </auto-generated>`);
  L.push(`#nullable enable`);
  L.push(`using System.Net.Http;`);
  L.push(`using System.Text.Json;`);
  L.push(`using System.Text.Json.Nodes;`);
  L.push(`using System.Text.Json.Serialization;`);
  L.push(``);
  L.push(`namespace Memex.User.Client;`);
  L.push(``);
  L.push(`/// <summary>The contract file that this code was generated from.</summary>`);
  L.push(`public static partial class ${P}Contract`);
  L.push(`{`);
  L.push(`    /// <summary>The sha256 of ${hub.spec} (LF line ends).</summary>`);
  L.push(`    public const string Sha256 = ${JSON.stringify(sha256)};`);
  L.push(``);
  L.push(`    /// <summary>The C# type of each component schema, by its name in the contract.</summary>`);
  L.push(`    public static readonly IReadOnlyDictionary<string, Type> Types = new Dictionary<string, Type>`);
  L.push(`    {`);
  for (const [source, name] of componentTypes) L.push(`        [${JSON.stringify(source)}] = typeof(${name}),`);
  L.push(`    };`);
  L.push(``);
  L.push(`    /// <summary>The fields type of each record kind.</summary>`);
  L.push(`    public static readonly IReadOnlyDictionary<string, Type> KindFields = new Dictionary<string, Type>`);
  L.push(`    {`);
  for (const k of kinds) L.push(`        [${JSON.stringify(k.kind)}] = typeof(${k.name}),`);
  L.push(`    };`);
  L.push(`}`);
  L.push(``);
  for (const name of order) {
    const e = named.get(name);
    L.push(...csDoc(e.description, ""));
    L.push(`public sealed partial record ${name}`);
    L.push(`{`);
    for (const p of e.props) {
      let prop = pascal(p.json);
      if (prop === name) prop = `${prop}Value`;
      let type = csType(p.type, named);
      L.push(...csDoc(p.description, "    "));
      L.push(`    [JsonPropertyName(${JSON.stringify(p.json)})]`);
      if (p.required) {
        L.push(`    [JsonRequired]`);
        if (type.endsWith("?")) L.push(`    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]`);
        L.push(`    public required ${type} ${prop} { get; init; }`);
      } else {
        if (p.type.nullable) throw new Error(`${name}.${p.json} is optional and nullable; the C# model has no type for it.`);
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
  L.push(`/// <summary>The operations of the ${hub.hub === "user" ? "Memex.User" : "Memex.Contacts"} API. The transport is in the other part of this class.</summary>`);
  L.push(`public sealed partial class ${P}Api`);
  L.push(`{`);
  for (const op of operations) {
    const name = pascal(op.id);
    const args = [];
    if (op.body) args.push(`${csType(op.body, named)} body`);
    args.push(`CancellationToken cancellationToken = default`);
    const type = csType(op.response, named);
    L.push(`    /// <summary>${(op.summary ?? op.id).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")} (${op.method} ${op.route})</summary>`);
    L.push(`    public Task<${type}> ${name}Async(${args.join(", ")}) =>`);
    L.push(`        SendJsonAsync<${type}>(HttpMethod.${op.method === "GET" ? "Get" : "Post"}, ${JSON.stringify(op.route)}, ${op.body ? "body" : "null"}, ${op.auth ? "true" : "false"}, cancellationToken);`);
    L.push(``);
  }
  while (L[L.length - 1] === "") L.pop();
  L.push(`}`);
  return L.join("\n") + "\n";
}

// ---------- write or check ----------

const args = process.argv.slice(2);
const check = args.includes("--check");
const csIndex = args.indexOf("--csharp");
const outputs = [];
for (const hub of HUBS) {
  const model = buildModel(hub);
  outputs.push([path.join(here, "..", "src", "generated", hub.ts), generateTs(model)]);
  if (csIndex >= 0) {
    const folder = args[csIndex + 1];
    if (!folder) {
      console.error("--csharp needs a folder.");
      process.exit(2);
    }
    outputs.push([path.resolve(folder, hub.cs), generateCs(model)]);
  }
}
let stale = 0;
for (const [file, content] of outputs) {
  if (check) {
    const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n") : null;
    if (current !== content) {
      console.error(`${path.relative(process.cwd(), file)} is not current. Run node packages/user-client/scripts/generate.mjs.`);
      stale++;
    }
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    console.log(`Wrote ${path.relative(process.cwd(), file)} (${content.split("\n").length} lines).`);
  }
}
process.exit(stale ? 1 : 0);
