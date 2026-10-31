// Normalizing helpers for readers: dates to ISO 8601, amounts to numbers and
// minor units, and header rows. From Finance's import (detect.ts); the column
// roles of bank exports stay in Finance.
import { createHash } from "node:crypto";

export type DateFormat = "ymd" | "dmy" | "mdy";

const ISO = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T ].*)?$/;
const COMPACT = /^(\d{4})(\d{2})(\d{2})$/;
const SHORT = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4}|\d{2})(?:[T ,].*)?$/;

function validDate(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCMonth() !== m - 1) return null;
  return date.toISOString().slice(0, 10);
}

/** A two-digit year as a full year: up to next year in this century, else the last. */
function fullYear(y: string, now = new Date()): number {
  if (y.length === 4) return Number(y);
  const n = Number(y);
  const current = now.getUTCFullYear() % 100;
  return n <= current + 1 ? 2000 + n : 1900 + n;
}

/** A calendar date (YYYY-MM-DD) from ISO, compact (20250131), or short (31.01.2025, 1/31/25) text, or null. */
export function parseDate(raw: string, format: DateFormat): string | null {
  const value = raw.trim();
  let m = value.match(ISO) ?? value.match(COMPACT);
  if (m) return validDate(Number(m[1]), Number(m[2]), Number(m[3]));
  m = value.match(SHORT);
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return format === "mdy" ? validDate(fullYear(m[3]!), a, b) : validDate(fullYear(m[3]!), b, a);
}

/**
 * Day first or month first, decided over every value: a part above 12 settles
 * it; otherwise the reading that keeps the rows in date order wins; otherwise
 * day first, or month first when the user's locale writes dates that way.
 */
export function detectDateFormat(values: string[], locale?: string): DateFormat {
  const short = values.map((v) => v.trim().match(SHORT)).filter((m): m is RegExpMatchArray => !!m);
  if (short.length < values.filter((v) => v.trim()).length / 2) return "ymd";
  const dayFirst = short.filter((m) => Number(m[1]) > 12).length;
  const monthFirst = short.filter((m) => Number(m[2]) > 12).length;
  if (dayFirst !== monthFirst) return dayFirst > monthFirst ? "dmy" : "mdy";
  const reversals = (format: DateFormat) => {
    const dates = values.map((v) => parseDate(v, format)).filter((d): d is string => !!d);
    let changes = 0;
    let direction = 0;
    for (let i = 1; i < dates.length; i += 1) {
      const step = Math.sign(dates[i]!.localeCompare(dates[i - 1]!));
      if (step && direction && step !== direction) changes += 1;
      if (step) direction = step;
    }
    return changes;
  };
  const dmy = reversals("dmy");
  const mdy = reversals("mdy");
  if (dmy !== mdy) return dmy < mdy ? "dmy" : "mdy";
  return locale && writesMonthFirst(locale) ? "mdy" : "dmy";
}

/** Whether a locale writes numeric dates month first, as en-US does. */
export function writesMonthFirst(locale: string): boolean {
  try {
    const parts = new Intl.DateTimeFormat(locale, { year: "numeric", month: "numeric", day: "numeric", timeZone: "UTC" })
      .formatToParts(Date.UTC(2001, 1, 3))
      .map((p) => p.type);
    return parts.indexOf("month") < parts.indexOf("day") && parts.indexOf("year") > parts.indexOf("day");
  } catch {
    return false;
  }
}

/** Day first or month first when some date settles it (a part above 12), else null. */
export function clearDateFormat(values: string[]): DateFormat | null {
  const short = values.map((v) => v.trim().match(SHORT)).filter((m): m is RegExpMatchArray => !!m);
  const dayFirst = short.filter((m) => Number(m[1]) > 12).length;
  const monthFirst = short.filter((m) => Number(m[2]) > 12).length;
  return dayFirst === monthFirst ? null : dayFirst > monthFirst ? "dmy" : "mdy";
}

/** A time as ISO 8601 UTC with milliseconds, from an ISO string or epoch milliseconds, or null. */
export function toIsoUtc(value: string | number): string | null {
  const ms = typeof value === "number" ? value : Date.parse(value.trim());
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

// A sign may come before or after a leading currency symbol: '-kr 123', 'kr -123', '$-12.00'.
const AMOUNT = /^[+\-−(]?\s*[^\d\s+\-−(]{0,4}\s*[+\-−]?\s*[\d.,'\s  ]*\d[\d.,'\s  ]*\s*[^\d\s]{0,4}\s*[)-]?$/;

/** The decimal mark when the values show it beyond doubt (a value with both marks, or a mark with one or two digits after it), else null. */
export function clearDecimal(values: string[]): "." | "," | null {
  let dot = 0;
  let comma = 0;
  for (const raw of values) {
    const v = raw.replace(/[^\d.,]/g, "");
    const lastDot = v.lastIndexOf(".");
    const lastComma = v.lastIndexOf(",");
    const mark = lastDot >= 0 && lastComma >= 0 ? (lastDot > lastComma ? "." : ",") : /[.,]\d{1,2}$/.test(v) ? v[v.search(/[.,]\d{1,2}$/)] : "";
    if (mark === ".") dot += 1;
    else if (mark === ",") comma += 1;
  }
  return dot === comma ? null : dot > comma ? "." : ",";
}

/** '.' or ',' as the decimal mark, voted over every value. */
export function detectDecimal(values: string[]): "." | "," {
  let dot = 0;
  let comma = 0;
  for (const raw of values) {
    const v = raw.replace(/[^\d.,]/g, "");
    const lastDot = v.lastIndexOf(".");
    const lastComma = v.lastIndexOf(",");
    if (lastDot >= 0 && lastComma >= 0) {
      if (lastDot > lastComma) dot += 1;
      else comma += 1;
      continue;
    }
    const mark = lastDot >= 0 ? "." : lastComma >= 0 ? "," : "";
    if (!mark) continue;
    const decimals = v.length - v.lastIndexOf(mark) - 1;
    const repeated = v.indexOf(mark) !== v.lastIndexOf(mark);
    // Thousands separators.
    if (repeated || decimals === 3) {
      if (mark === ".") comma += 0.1;
      else dot += 0.1;
    } else if (mark === ".") dot += 1;
    else comma += 1;
  }
  return comma > dot ? "," : ".";
}

/** An amount in major units, or null. Handles signs, parentheses, symbols, and thousands separators. */
export function parseAmount(raw: string, decimal: "." | ","): number | null {
  let s = raw.trim();
  if (!s || !AMOUNT.test(s)) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (/-\s*$/.test(s) && !/^[-−]/.test(s)) {
    negative = true;
    s = s.replace(/-\s*$/, "");
  }
  if (/^[^\d]*[-−]/.test(s)) negative = true;
  s = s.replace(/[^\d.,]/g, "");
  // One mark with one or two digits after it is a decimal mark, whatever the file's: a hand-edited '-35000.00' among '617,80'.
  const lone = /^\d*[.,]\d{1,2}$/.test(s) ? s.replace(/\d/g, "") : "";
  const mark = lone || decimal;
  s = mark === "," ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  if (!s || (s.match(/\./g)?.length ?? 0) > 1) return null;
  const value = Number(s);
  if (!Number.isFinite(value)) return null;
  return negative ? -value : value;
}

/** Major units as integer minor units: 12.34 as 1234 with the default 100 per unit. */
export function toMinorUnits(amount: number, perUnit = 100): number {
  return Math.round(amount * perUnit);
}

/** A header cell in a comparable form: lower case, no brackets, punctuation, or repeated spaces. */
export const normalizeHeader = (h: string) =>
  h
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, " ")
    .replace(/[_:*#]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** A short id of a header row, for remembering a column mapping per file layout. */
export function headerSignature(header: string[]): string {
  return createHash("sha256").update(header.map(normalizeHeader).join("\u0001")).digest("hex").slice(0, 24);
}

/**
 * The first row that reads as a header: several text cells, none of them a date or an amount. -1 when the file
 * starts with data rows and has no header at all.
 */
export function findHeaderRow(rows: string[][]): number {
  const width = Math.max(0, ...rows.slice(0, 50).map((r) => r.filter((v) => v.trim()).length));
  for (let i = 0; i < Math.min(rows.length, 30); i += 1) {
    const cells = rows[i]!.filter((v) => v.trim());
    if (cells.length < 2 || cells.length < width * 0.6) continue;
    if (cells.some((v) => parseDate(v, "dmy") || parseAmount(v, ".") !== null)) continue;
    return i;
  }
  return rows[0]?.some((v) => parseDate(v, "dmy") ?? parseDate(v, "mdy")) ? -1 : 0;
}
