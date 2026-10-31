// A reader for the YAML subset that pnpm writes in pnpm-lock.yaml: block mappings,
// block sequences, flow mappings and sequences (also over several lines), and plain,
// single-quoted and double-quoted scalars. Every scalar stays a string.

export type YamlValue = string | null | YamlValue[] | { [key: string]: YamlValue };

export class YamlError extends Error {}

interface Line {
  indent: number;
  text: string;
  no: number;
}

function stripComment(text: string): string {
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote !== null) {
      if (c === quote) {
        if (quote === "'" && text[i + 1] === "'") i++;
        else quote = null;
      } else if (c === "\\" && quote === '"') i++;
    } else if (c === "'" || c === '"') {
      quote = c;
    } else if (c === "#" && (i === 0 || text[i - 1] === " " || text[i - 1] === "\t")) {
      return text.slice(0, i).trimEnd();
    }
  }
  return text.trimEnd();
}

function depth(text: string): number {
  let d = 0;
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote !== null) {
      if (c === quote) {
        if (quote === "'" && text[i + 1] === "'") i++;
        else quote = null;
      } else if (c === "\\" && quote === '"') i++;
    } else if (c === "'" || c === '"') quote = c;
    else if (c === "{" || c === "[") d++;
    else if (c === "}" || c === "]") d--;
  }
  return d;
}

function unquote(raw: string): string {
  const s = raw.trim();
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1).replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_m, e: string) => {
      if (e.startsWith("u") && e.length === 5) return String.fromCharCode(parseInt(e.slice(1), 16));
      return ({ n: "\n", t: "\t", r: "\r", "0": "\0", '"': '"', "\\": "\\", "/": "/" } as Record<string, string>)[e] ?? e;
    });
  }
  return s;
}

/** Splits `key: rest` at the first colon outside quotes that a space or the end follows. */
function splitKey(text: string): [string, string] | null {
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote !== null) {
      if (c === quote) {
        if (quote === "'" && text[i + 1] === "'") i++;
        else quote = null;
      } else if (c === "\\" && quote === '"') i++;
    } else if ((c === "'" || c === '"') && i === 0) quote = c;
    else if (c === ":" && (i + 1 === text.length || text[i + 1] === " " || text[i + 1] === "\t")) {
      return [unquote(text.slice(0, i)), text.slice(i + 1).trim()];
    }
  }
  return null;
}

function parseFlow(text: string): YamlValue {
  let pos = 0;
  const ws = () => {
    while (pos < text.length && /\s/.test(text[pos]!)) pos++;
  };
  function scalar(stop: string): string {
    ws();
    const c = text[pos];
    if (c === "'" || c === '"') {
      const start = pos++;
      while (pos < text.length) {
        if (text[pos] === "\\" && c === '"') pos += 2;
        else if (text[pos] === c) {
          if (c === "'" && text[pos + 1] === "'") pos += 2;
          else {
            pos++;
            break;
          }
        } else pos++;
      }
      return unquote(text.slice(start, pos));
    }
    const start = pos;
    while (pos < text.length && !stop.includes(text[pos]!)) {
      if (text[pos] === ":" && stop.includes(":") && (text[pos + 1] === " " || text[pos + 1] === undefined || stop.includes(text[pos + 1]!))) break;
      pos++;
    }
    return text.slice(start, pos).trim();
  }
  function value(stop: string): YamlValue {
    ws();
    if (text[pos] === "{") return map();
    if (text[pos] === "[") return seq();
    return scalar(stop);
  }
  function map(): YamlValue {
    pos++;
    const out: Record<string, YamlValue> = {};
    for (;;) {
      ws();
      if (text[pos] === "}") {
        pos++;
        return out;
      }
      const key = scalar(":,}");
      ws();
      let v: YamlValue = null;
      if (text[pos] === ":") {
        pos++;
        v = value(",}");
      }
      if (key !== "") out[key] = v;
      ws();
      if (text[pos] === ",") pos++;
      else if (text[pos] !== "}") throw new YamlError(`bad flow mapping: ${text}`);
    }
  }
  function seq(): YamlValue {
    pos++;
    const out: YamlValue[] = [];
    for (;;) {
      ws();
      if (text[pos] === "]") {
        pos++;
        return out;
      }
      out.push(value(",]"));
      ws();
      if (text[pos] === ",") pos++;
      else if (text[pos] !== "]") throw new YamlError(`bad flow sequence: ${text}`);
    }
  }
  return value("");
}

export function parseYaml(source: string): YamlValue {
  const lines: Line[] = [];
  const raw = source.replace(/^﻿/, "").split(/\r?\n/);
  for (let i = 0; i < raw.length; i++) {
    const text = stripComment(raw[i]!);
    if (text.trim() === "" || text.trim() === "---") continue;
    const indent = text.length - text.trimStart().length;
    lines.push({ indent, text: text.trim(), no: i + 1 });
  }
  let idx = 0;

  /** Reads a value that starts on the current line after the key, and joins a flow value over lines. */
  function inlineValue(rest: string): YamlValue {
    if (rest.startsWith("{") || rest.startsWith("[")) {
      let text = rest;
      while (depth(text) > 0) {
        const next = lines[idx++];
        if (next === undefined) throw new YamlError("unclosed flow value");
        text += " " + next.text;
      }
      return parseFlow(text);
    }
    if (rest === "|" || rest === ">" || rest.startsWith("|") || rest.startsWith(">")) {
      throw new YamlError("block scalars are not supported");
    }
    return unquote(rest);
  }

  function block(indent: number): YamlValue {
    const first = lines[idx];
    if (first === undefined || first.indent < indent) return null;
    const ind = first.indent;
    if (first.text.startsWith("{") || first.text.startsWith("[")) {
      // A flow value on the lines after its key, as Prettier writes pnpm-lock.yaml.
      idx++;
      return inlineValue(first.text);
    }
    if (first.text.startsWith("- ") || first.text === "-") {
      const out: YamlValue[] = [];
      while (idx < lines.length && lines[idx]!.indent === ind && (lines[idx]!.text.startsWith("- ") || lines[idx]!.text === "-")) {
        const line = lines[idx++]!;
        const rest = line.text.slice(1).trim();
        if (rest === "") out.push(block(ind + 1));
        else if (splitKey(rest) !== null && !rest.startsWith("{") && !rest.startsWith("[")) {
          // "- key: value" opens a mapping whose other keys sit at the column after "- ".
          lines.splice(idx, 0, { indent: ind + 2, text: rest, no: line.no });
          out.push(mapping(ind + 2));
        } else out.push(inlineValue(rest));
      }
      return out;
    }
    return mapping(ind);
  }

  function mapping(ind: number): YamlValue {
    const out: Record<string, YamlValue> = {};
    while (idx < lines.length && lines[idx]!.indent === ind) {
      const line = lines[idx]!;
      if (line.text.startsWith("- ")) break;
      const kv = splitKey(line.text);
      if (kv === null) throw new YamlError(`line ${line.no}: expected "key: value"`);
      idx++;
      const [key, rest] = kv;
      if (rest === "") {
        const next = lines[idx];
        if (next !== undefined && (next.indent > ind || (next.indent === ind && next.text.startsWith("- ")))) {
          out[key] = block(next.indent);
        } else out[key] = null;
      } else out[key] = inlineValue(rest);
    }
    if (idx < lines.length && lines[idx]!.indent > ind) {
      throw new YamlError(`line ${lines[idx]!.no}: unexpected indentation`);
    }
    return out;
  }

  const result = block(0);
  if (idx < lines.length) throw new YamlError(`line ${lines[idx]!.no}: unexpected content`);
  return result;
}
