// A digest of a database's data, to show that a preview changed nothing and an
// undo put the earlier state back.
import { createHash } from "node:crypto";
import type { SqliteDatabase } from "@tjalve/memex-sqlite";

/** Tables that record the history of imports and changes, not the data: left out of the digest by default. */
export const HISTORY_TABLES = ["import_batch", "import_file", "memex_change", "memex_change_data", "schema_migrations"];

export interface DataDigest {
  /** Rows per table. */
  tables: Record<string, number>;
  /** SHA-256 over every row of every table, in key order. */
  hash: string;
}

/**
 * Row counts and a SHA-256 over the rows of every table except the history tables (and SQLite's own). Rows are
 * hashed in primary key order (rowid order for a table without one) as canonical JSON, blobs as hex.
 */
export function digestData(db: SqliteDatabase, options: { exclude?: string[] } = {}): DataDigest {
  const exclude = new Set(options.exclude ?? HISTORY_TABLES);
  const names = db
    .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .map((t) => t.name)
    .filter((name) => !exclude.has(name));
  const hash = createHash("sha256");
  const tables: Record<string, number> = {};
  const q = (name: string) => `"${name.replace(/"/g, '""')}"`;
  for (const name of names) {
    const columns = db.all<{ name: string; pk: number }>("SELECT name, pk FROM pragma_table_info(?)", name);
    const pk = columns.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => q(c.name));
    const order = pk.length ? pk.join(", ") : columns.map((c) => q(c.name)).join(", ");
    const rows = db.all<Record<string, unknown>>(`SELECT * FROM ${q(name)} ORDER BY ${order}`);
    tables[name] = rows.length;
    hash.update(`${name}\u0000`);
    for (const row of rows) {
      hash.update(
        JSON.stringify(
          Object.keys(row)
            .sort()
            .map((k) => [k, row[k] instanceof Uint8Array ? Buffer.from(row[k] as Uint8Array).toString("hex") : typeof row[k] === "bigint" ? String(row[k]) : row[k]]),
        ),
      );
      hash.update("\n");
    }
  }
  return { tables, hash: hash.digest("hex") };
}
