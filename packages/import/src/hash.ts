// Content hashes for the provenance dedupe key, and file hashes.
import { createHash } from "node:crypto";

/**
 * JSON with object keys sorted at every level, so one value always has one
 * spelling. Undefined object members are left out; numbers that are not finite,
 * functions, and symbols are refused.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`A content identity cannot hold ${value}.`);
    return JSON.stringify(value);
  }
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? "null" : canonicalJson(v))).join(",")}]`;
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  throw new TypeError(`A content identity cannot hold a ${typeof value}.`);
}

/**
 * The provenance content hash of a record: the SHA-256 (lowercase hex) of the canonical JSON of the fields that
 * identify it in its source. `ordinal` numbers identical records in one file (the second is 1), so that both are
 * kept and a repeated import still adds nothing; ordinal 0 is the plain hash.
 */
export function contentHash(identity: unknown, ordinal = 0): string {
  const hash = createHash("sha256").update(canonicalJson(identity));
  if (ordinal > 0) hash.update(`\u0001${ordinal}`);
  return hash.digest("hex");
}

/** SHA-256 (lowercase hex) of bytes. */
export function sha256(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** SHA-256 (lowercase hex) of a stream of chunks, with the byte count. */
export async function hashChunks(chunks: AsyncIterable<Uint8Array>): Promise<{ hash: string; bytes: number }> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of chunks) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  return { hash: hash.digest("hex"), bytes };
}
