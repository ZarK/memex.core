// Copied from packages/schema/test/fixture-json.ts: the one layout of the contract fixtures.
// The JSON layout of the contract fixtures, so that a test can write a fixture back and compare
// it byte for byte. An object or a list stays on one line when it fits in 100 columns; a list of
// plain values that does not fit fills its lines; everything else has one entry per line, with an
// indent of two spaces. Characters outside ASCII are written as they are. The file ends with a newline.
const WIDTH = 100;

const plain = (v: unknown) => typeof v !== 'object' || v === null;
const scalar = (v: unknown) => JSON.stringify(v);

function inline(v: unknown): string {
  if (Array.isArray(v)) return v.length === 0 ? '[]' : `[${v.map(inline).join(', ')}]`;
  if (!plain(v)) {
    const entries = Object.entries(v as Record<string, unknown>);
    return entries.length === 0 ? '{}' : `{ ${entries.map(([k, x]) => `${scalar(k)}: ${inline(x)}`).join(', ')} }`;
  }
  return scalar(v);
}

function layout(v: unknown, indent: number, prefix: number): string {
  const one = inline(v);
  const empty = Array.isArray(v) ? v.length === 0 : !plain(v) && Object.keys(v as object).length === 0;
  if (indent + prefix + one.length <= WIDTH || plain(v) || empty) return one;
  const pad = ' '.repeat(indent + 2);
  const end = ' '.repeat(indent);
  if (!Array.isArray(v)) {
    const parts = Object.entries(v as Record<string, unknown>).map(([k, x]) => {
      const key = `${scalar(k)}: `;
      return pad + key + layout(x, indent + 2, key.length + 1);
    });
    return `{\n${parts.join(',\n')}\n${end}}`;
  }
  if (v.every(plain)) {
    const lines: string[] = [];
    let line = '';
    for (const x of v) {
      const t = scalar(x);
      if (line !== '' && pad.length + line.length + 2 + t.length + 1 > WIDTH) {
        lines.push(`${line},`);
        line = t;
      } else line = line === '' ? t : `${line}, ${t}`;
    }
    lines.push(line);
    return `[\n${lines.map((l) => pad + l).join('\n')}\n${end}]`;
  }
  return `[\n${v.map((x) => pad + layout(x, indent + 2, 1)).join(',\n')}\n${end}]`;
}

export function writeFixtureJson(value: unknown): string {
  return `${layout(value, 0, 0)}\n`;
}
