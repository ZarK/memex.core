// Text and tables for readers: decode bytes in UTF-8, UTF-16, or Windows-1252,
// repair text that was UTF-8 encoded twice, split delimited text, and read the
// first sheet of an XLSX workbook. From Finance's import (table.ts) and
// Health's import (archive.mjs).
import { isXlsx, readXlsx } from "./xlsx.js";

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

/**
 * Text from bytes: UTF-16 with a byte order mark, else UTF-8 (a byte order mark is dropped, double encoding is
 * repaired), else Windows-1252.
 */
export function decodeText(data: Uint8Array): string {
  if (data[0] === 0xff && data[1] === 0xfe) return new TextDecoder("utf-16le").decode(data.subarray(2));
  if (data[0] === 0xfe && data[1] === 0xff) return new TextDecoder("utf-16be").decode(data.subarray(2));
  try {
    return repairDoubleEncoding(strictUtf8.decode(data)).replace(/^﻿/, "");
  } catch {
    return new TextDecoder("windows-1252").decode(data);
  }
}

/**
 * Text that was UTF-8 encoded twice ('pÃ¥' for 'på'), or three times, read back the way it was written. Only runs
 * that decode cleanly as UTF-8 change, so ordinary accented text stays as it is.
 */
export function repairDoubleEncoding(text: string): string {
  for (let pass = 0; pass < 3; pass += 1) {
    const next = text.replace(/[Â-ô][\u0080-¿]+/g, (run) => {
      try {
        return strictUtf8.decode(Buffer.from(run, "latin1"));
      } catch {
        return run;
      }
    });
    if (next === text) break;
    text = next;
  }
  return text;
}

/** The delimiter that splits the first lines into the same number of fields most often: ',', ';', tab, or '|'. */
export function detectDelimiter(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .slice(0, 30);
  let best = ",";
  let bestScore = -1;
  for (const delimiter of [",", ";", "\t", "|"]) {
    const counts = lines.map((line) => {
      let n = 0;
      let quoted = false;
      for (const ch of line) {
        if (ch === '"') quoted = !quoted;
        else if (ch === delimiter && !quoted) n += 1;
      }
      return n;
    });
    const freq = new Map<number, number>();
    for (const n of counts) if (n > 0) freq.set(n, (freq.get(n) ?? 0) + 1);
    const [fields, rows] = [...freq].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0] ?? [0, 0];
    const score = rows * 1000 + fields;
    if (score > bestScore) {
      best = delimiter;
      bestScore = score;
    }
  }
  return best;
}

/** Delimited text as rows of trimmed fields. Quoted fields may hold the delimiter, quotes ("") and line breaks. */
export function parseCsv(input: string, delimiter = detectDelimiter(input)): string[][] {
  const text = input.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else field += ch;
      i += 1;
      continue;
    }
    if (ch === '"' && field.trim() === "") {
      quoted = true;
      field = "";
    } else if (ch === delimiter) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
    } else field += ch;
    i += 1;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.map((r) => r.map((v) => v.trim()));
}

/** A file as rows of strings: the first sheet of an XLSX workbook, else delimited text. */
export function readTable(data: Buffer): string[][] {
  if (isXlsx(data)) return readXlsx(data);
  return parseCsv(decodeText(data));
}

export interface TableRecord {
  /** The 1-based row number in the table, counting the header row. */
  row: number;
  /** The cells by header name. A header that repeats keeps its first column. */
  values: Record<string, string>;
}

/**
 * The rows after a header row as records by header name. Empty rows are left out, and so counted in `empty`, so a
 * reader can account for every row.
 */
export function tableRecords(rows: string[][], headerRow = 0): { header: string[]; records: TableRecord[]; empty: number } {
  const header = (rows[headerRow] ?? []).map((h) => h.trim());
  const records: TableRecord[] = [];
  let empty = 0;
  rows.slice(headerRow + 1).forEach((cells, index) => {
    if (!cells.some((v) => v.trim())) {
      empty += 1;
      return;
    }
    const values: Record<string, string> = {};
    header.forEach((name, column) => {
      if (name && !(name in values)) values[name] = cells[column] ?? "";
    });
    records.push({ row: headerRow + index + 2, values });
  });
  return { header, records, empty };
}
