// Small value helpers: JSON identity, text normalization, partial dates, and distances.

/** The JSON form of a value with the properties of every object in sorted order. Lists keep their order. */
export function valueKey(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    typeof v === 'object' && v !== null && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

export function sameValue(a: unknown, b: unknown): boolean {
  return valueKey(a) === valueKey(b);
}

/** Lowercase, without punctuation, with single spaces: the form in which names and addresses compare. */
export function normalizeText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[.,;:'"()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text === '' ? undefined : text;
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---- Partial dates: YYYY, YYYY-MM, YYYY-MM-DD, and --MM-DD (a day of the year without the year). ----

const PARTIAL = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/;
const NO_YEAR = /^--(\d{2})-(\d{2})$/;

export interface DateParts {
  y?: number;
  m?: number;
  d?: number;
}

export function dateParts(value: unknown): DateParts | undefined {
  if (typeof value !== 'string') return undefined;
  const t = value.length > 10 ? value.slice(0, 10) : value;
  const p = PARTIAL.exec(t);
  if (p) {
    const parts: DateParts = { y: Number(p[1]) };
    if (p[2]) parts.m = Number(p[2]);
    if (p[3]) parts.d = Number(p[3]);
    return parts;
  }
  const n = NO_YEAR.exec(value);
  if (n) return { m: Number(n[1]), d: Number(n[2]) };
  return undefined;
}

/** How many parts a date has: 1 for a year, 2 for a month, 3 for a day, 4 for a time. 0 when it is not a date. */
export function datePrecision(value: unknown): number {
  if (typeof value === 'string' && /T\d{2}:\d{2}/.test(value)) return 4;
  const p = dateParts(value);
  if (!p) return 0;
  return (p.y !== undefined ? 1 : 0) + (p.m !== undefined ? 1 : 0) + (p.d !== undefined ? 1 : 0);
}

/** Does `fine` refine `coarse`: every part that `coarse` has, `fine` has with the same value? */
export function refines(fine: unknown, coarse: unknown): boolean {
  const f = dateParts(fine);
  const c = dateParts(coarse);
  if (!f || !c) return false;
  for (const k of ['y', 'm', 'd'] as const) {
    if (c[k] !== undefined && f[k] !== c[k]) return false;
  }
  return true;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** The first day of the period (YYYY-MM-DD), or the time itself. */
export function periodStart(value: string): string {
  if (/T/.test(value)) return value;
  const p = dateParts(value);
  if (!p || p.y === undefined) return value;
  return `${pad(p.y, 4)}-${pad(p.m ?? 1)}-${pad(p.d ?? 1)}`;
}

/** The last day of the period (YYYY-MM-DD), or the time itself. */
export function periodEnd(value: string): string {
  if (/T/.test(value)) return value;
  const p = dateParts(value);
  if (!p || p.y === undefined) return value;
  const m = p.m ?? 12;
  return `${pad(p.y, 4)}-${pad(m)}-${pad(p.d ?? daysInMonth(p.y, m))}`;
}

/** The period just before a partial date, at its precision: 2023-07 gives 2023-06. */
export function periodBefore(value: string): string {
  const p = dateParts(value);
  if (!p || p.y === undefined) return value;
  if (p.d !== undefined) {
    const t = new Date(Date.UTC(p.y, (p.m ?? 1) - 1, p.d) - 86_400_000);
    return `${pad(t.getUTCFullYear(), 4)}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
  }
  if (p.m !== undefined) return p.m === 1 ? `${pad(p.y - 1, 4)}-12` : `${pad(p.y, 4)}-${pad(p.m - 1)}`;
  return pad(p.y - 1, 4);
}

/** Milliseconds since the epoch of a day or a time. */
export function instant(value: string): number {
  return Date.parse(/T/.test(value) ? value : `${value}T00:00:00Z`);
}

export const DAY_MS = 86_400_000;

/** A time interval in milliseconds; `end` is Infinity for an open end. */
export interface Interval {
  start: number;
  end: number;
}

/** The interval of a span: from the start of `from` to the end of `to`; open when `to` is missing. */
export function spanInterval(from: unknown, to: unknown): Interval | undefined {
  if (typeof from !== 'string' && typeof to !== 'string') return undefined;
  const start = typeof from === 'string' ? instant(periodStart(from)) : -Infinity;
  const end =
    typeof to === 'string'
      ? instant(periodEnd(to)) + (/T/.test(to) ? 0 : DAY_MS - 1)
      : typeof from === 'string'
        ? Infinity
        : -Infinity;
  if (Number.isNaN(start) || Number.isNaN(end)) return undefined;
  return { start, end };
}

/** The gap between two intervals in days; 0 or less when they overlap. */
export function gapDays(a: Interval, b: Interval): number {
  if (a.end >= b.start && b.end >= a.start) return 0;
  const gap = a.end < b.start ? b.start - a.end : a.start - b.end;
  return gap / DAY_MS;
}

// ---- Distances ----

export interface LatLon {
  lat: number;
  lon: number;
  radiusM?: number;
}

export function isLocation(value: unknown): value is LatLon {
  return isObject(value) && typeof value.lat === 'number' && typeof value.lon === 'number';
}

/** The great-circle distance in metres. */
export function distanceM(a: LatLon, b: LatLon): number {
  const r = 6_371_000;
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * r * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Are two locations within the larger of their radii (or the default)? */
export function near(a: LatLon, b: LatLon, defaultRadiusM: number): boolean {
  const radius = Math.max(a.radiusM ?? defaultRadiusM, b.radiusM ?? defaultRadiusM);
  return distanceM(a, b) <= radius;
}
