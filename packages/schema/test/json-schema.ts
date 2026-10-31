// A small JSON Schema (draft 2020-12) checker for the keywords that schemas/user/,
// schemas/contacts/, schemas/facts/ and the OpenAPI components use, so that the tests
// need no validator package. It grows from packages/handles/test/schema.ts: files are
// keyed by their path from the repository root, and a $ref may point into another file
// by a relative path, including the components of an OpenAPI file.
import { posix } from 'node:path';

export type Schema = Record<string, unknown> | boolean;

/** The keywords that the checker applies, and the ones that only annotate. */
export const KEYWORDS = new Set([
  '$ref', 'type', 'const', 'enum', 'pattern', 'minLength', 'maxLength', 'format',
  'minimum', 'maximum', 'exclusiveMinimum', 'items', 'minItems', 'maxItems', 'uniqueItems',
  'required', 'properties', 'additionalProperties', 'propertyNames', 'minProperties',
  'allOf', 'anyOf', 'oneOf', 'not', 'if', 'then', 'else',
  // Annotations.
  '$schema', '$id', '$defs', 'title', 'description', 'default',
]);

const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export function makeChecker(files: Record<string, unknown>) {
  function resolve(ref: string, base: string): [Schema, string] {
    const [file = '', pointer = ''] = ref.split('#');
    const name = file === '' ? base : posix.normalize(posix.join(posix.dirname(base), file));
    let node: unknown = files[name];
    if (node === undefined) throw new Error(`unknown schema file ${name} (from ${base})`);
    for (const raw of pointer.split('/').filter(Boolean)) {
      const part = raw.replace(/~1/g, '/').replace(/~0/g, '~');
      node = (node as Record<string, unknown>)[part];
      if (node === undefined) throw new Error(`unknown ref ${ref} (from ${base})`);
    }
    return [node as Schema, name];
  }

  function typeOf(v: unknown): string {
    if (v === null) return 'null';
    if (Array.isArray(v)) return 'array';
    if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
    return typeof v;
  }

  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

  function check(s: Schema, v: unknown, base: string, at: string, errors: string[]): void {
    if (s === true) return;
    if (s === false) return void errors.push(`${at}: not allowed`);
    const passes = (sub: Schema) => {
      const e: string[] = [];
      check(sub, v, base, at, e);
      return e.length === 0;
    };
    if (typeof s.$ref === 'string') {
      const [target, file] = resolve(s.$ref, base);
      check(target, v, file, at, errors);
    }
    const t = typeOf(v);
    if (s.type !== undefined) {
      const types = Array.isArray(s.type) ? (s.type as string[]) : [s.type as string];
      if (!types.some((x) => x === t || (x === 'number' && t === 'integer'))) errors.push(`${at}: expected ${types.join(' or ')}`);
    }
    if ('const' in s && !same(s.const, v)) errors.push(`${at}: expected ${JSON.stringify(s.const)}`);
    if (Array.isArray(s.enum) && !s.enum.some((e) => same(e, v))) errors.push(`${at}: ${JSON.stringify(v)} not in enum`);
    if (typeof v === 'string') {
      if (typeof s.pattern === 'string' && !new RegExp(s.pattern, 'u').test(v)) errors.push(`${at}: '${v}' does not match ${s.pattern}`);
      if (typeof s.minLength === 'number' && [...v].length < s.minLength) errors.push(`${at}: too short`);
      if (typeof s.maxLength === 'number' && [...v].length > s.maxLength) errors.push(`${at}: too long`);
      if (s.format === 'date-time' && (!UTC.test(v) || Number.isNaN(Date.parse(v)))) errors.push(`${at}: not a date-time`);
    }
    if (typeof v === 'number') {
      if (typeof s.minimum === 'number' && v < s.minimum) errors.push(`${at}: below ${s.minimum}`);
      if (typeof s.maximum === 'number' && v > s.maximum) errors.push(`${at}: above ${s.maximum}`);
      if (typeof s.exclusiveMinimum === 'number' && v <= s.exclusiveMinimum) errors.push(`${at}: not above ${s.exclusiveMinimum}`);
    }
    if (Array.isArray(v)) {
      if (typeof s.minItems === 'number' && v.length < s.minItems) errors.push(`${at}: too few items`);
      if (typeof s.maxItems === 'number' && v.length > s.maxItems) errors.push(`${at}: too many items`);
      if (s.uniqueItems === true && new Set(v.map((x) => JSON.stringify(x))).size !== v.length) errors.push(`${at}: items not unique`);
      if (s.items !== undefined) v.forEach((item, i) => check(s.items as Schema, item, base, `${at}/${i}`, errors));
    }
    if (t === 'object') {
      const o = v as Record<string, unknown>;
      for (const key of (s.required as string[] | undefined) ?? []) if (!(key in o)) errors.push(`${at}: missing ${key}`);
      if (typeof s.minProperties === 'number' && Object.keys(o).length < s.minProperties) errors.push(`${at}: too few properties`);
      const props = (s.properties as Record<string, Schema> | undefined) ?? {};
      for (const [key, value] of Object.entries(o)) {
        if (s.propertyNames !== undefined) check(s.propertyNames as Schema, key, base, `${at}/${key} (name)`, errors);
        if (key in props) check(props[key]!, value, base, `${at}/${key}`, errors);
        else if (s.additionalProperties === false) errors.push(`${at}: unknown field ${key}`);
        else if (typeof s.additionalProperties === 'object') check(s.additionalProperties as Schema, value, base, `${at}/${key}`, errors);
      }
    }
    for (const sub of (s.allOf as Schema[] | undefined) ?? []) check(sub, v, base, at, errors);
    if (Array.isArray(s.anyOf) && !s.anyOf.some(passes)) errors.push(`${at}: no anyOf branch matches`);
    if (Array.isArray(s.oneOf)) {
      const n = (s.oneOf as Schema[]).filter(passes).length;
      if (n !== 1) errors.push(`${at}: ${n} oneOf branches match`);
    }
    if (s.not !== undefined && passes(s.not as Schema)) errors.push(`${at}: matches not`);
    if (s.if !== undefined) {
      const branch = passes(s.if as Schema) ? s.then : s.else;
      if (branch !== undefined) check(branch as Schema, v, base, at, errors);
    }
  }

  /** Check a value against '<file>' or '<file>#<pointer>'. Returns the errors; none means valid. */
  return (target: string, value: unknown): string[] => {
    const [file = '', pointer = ''] = target.split('#');
    const errors: string[] = [];
    const [schema, base] = resolve(`#${pointer}`, file);
    check(schema, value, base, '', errors);
    return errors;
  };
}

/** Every keyword that a schema uses, outside property names, $defs names, and values. */
export function keywords(node: unknown, found = new Set<string>(), asMap = false): Set<string> {
  if (Array.isArray(node)) {
    for (const n of node) keywords(n, found);
    return found;
  }
  if (typeof node !== 'object' || node === null) return found;
  for (const [key, value] of Object.entries(node)) {
    if (asMap) {
      keywords(value, found);
      continue;
    }
    found.add(key);
    if (key === 'enum' || key === 'const' || key === 'required' || key === 'default' || key === 'description') continue;
    keywords(value, found, key === 'properties' || key === '$defs');
  }
  return found;
}
