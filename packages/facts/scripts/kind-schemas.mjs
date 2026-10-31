// Writes src/kind-schemas.ts: the field schemas of the Memex.User and Memex.Contacts kinds,
// taken from schemas/user/ and schemas/contacts/, so that the engine checks field values
// against the contracts at run time. Run it after a change to those schemas:
//   node packages/facts/scripts/kind-schemas.mjs
// The test kind-schemas.test.ts fails when the file is out of date.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SKIP = new Set(['claim.json', 'correction.json', 'record.json', 'change.json']);
const ANNOTATIONS = new Set(['$schema', '$id', 'title', 'description', 'default', 'examples']);

function strip(node, asMap = false) {
  if (Array.isArray(node)) return node.map((n) => strip(n));
  if (typeof node !== 'object' || node === null) return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (!asMap && ANNOTATIONS.has(k)) continue;
    out[k] = asMap ? strip(v) : k === 'enum' || k === 'const' || k === 'required' ? v : strip(v, k === 'properties' || k === '$defs');
  }
  return out;
}

export function kindSchemasSource() {
  const files = {};
  for (const dir of ['schemas/user', 'schemas/contacts']) {
    for (const name of readdirSync(join(ROOT, dir)).sort()) {
      if (!name.endsWith('.json') || SKIP.has(name)) continue;
      files[`${dir}/${name}`] = strip(JSON.parse(readFileSync(join(ROOT, dir, name), 'utf-8')));
    }
  }
  return (
    '// Made by scripts/kind-schemas.mjs from schemas/user/ and schemas/contacts/. Do not edit.\n' +
    `export const KIND_SCHEMAS: Record<string, unknown> = ${JSON.stringify(files, null, 1)};\n`
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  writeFileSync(join(ROOT, 'packages/facts/src/kind-schemas.ts'), kindSchemasSource());
}
