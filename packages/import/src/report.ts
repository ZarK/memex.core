// Reports as text for people and the CLI.
import type { ChangeCounts } from "@tjalve/memex-sqlite";
import type { BatchRow, FileReport, ImportReport, ImportTotals, RecordCounts, UndoResult } from "./types.js";

const n = (v: number) => v.toLocaleString("en-US");

export function recordsText(r: RecordCounts): string {
  const parts = [`${n(r.new)} new`];
  if (r.duplicate) parts.push(`${n(r.duplicate)} duplicate`);
  if (r.repeated) parts.push(`${n(r.repeated)} repeated in the file`);
  if (r.skipped) parts.push(`${n(r.skipped)} skipped`);
  return `${n(r.read)} records: ${parts.join(", ")}`;
}

export function tablesText(tables: ChangeCounts): string {
  const parts = Object.entries(tables)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([table, c]) => {
      const bits = [];
      if (c.inserted) bits.push(`+${n(c.inserted)}`);
      if (c.updated) bits.push(`~${n(c.updated)}`);
      if (c.deleted) bits.push(`-${n(c.deleted)}`);
      return `${table} ${bits.join(" ")}`;
    });
  return parts.length ? parts.join(", ") : "no rows";
}

function fileLine(f: FileReport): string {
  const head = `  ${f.outcome.padEnd(12)} ${f.path}`;
  const reader = f.reader ? ` [${f.reader}]` : "";
  switch (f.outcome) {
    case "imported":
      return `${head}${reader}: ${recordsText(f.records)}`;
    case "unchanged":
      return `${head}${reader}: the same bytes were imported in batch ${f.importedIn}; ${recordsText(f.records)}`;
    case "copy":
      return `${head}${reader}: the same bytes as ${f.copyOf}`;
    case "archive":
      return `${head}: ${n(f.entries ?? 0)} ${f.entries === 1 ? "entry" : "entries"}, listed below it`;
    default:
      return `${head}${reader}: ${f.reason ?? ""}`;
  }
}

export function totalsText(t: ImportTotals): string[] {
  const outcomes = Object.entries(t.files)
    .filter(([k, v]) => k !== "all" && v)
    .map(([k, v]) => `${k} ${n(v)}`)
    .join(", ");
  return [
    `Files: ${n(t.files.all)} (${outcomes || "none"})`,
    `Records: ${recordsText(t.records)}`,
    `Rows: ${tablesText(t.tables)}`,
  ];
}

export function reportText(report: ImportReport, options: { skips?: boolean } = {}): string {
  const lines: string[] = [];
  lines.push(
    report.mode === "preview"
      ? `Preview of an import from ${report.roots.join(", ")}. Nothing was written: the writes ran in a transaction that was rolled back.`
      : `Batch ${report.batchId}: imported from ${report.roots.join(", ")}.`,
  );
  lines.push("");
  for (const f of report.files) {
    lines.push(fileLine(f));
    for (const s of f.sample) lines.push(`      + ${s}`);
    if (options.skips !== false) for (const s of f.skips.slice(0, 5)) lines.push(`      skipped ${s.ref}: ${s.skip}`);
    if (f.skips.length > 5 && options.skips !== false) lines.push(`      (${n(f.records.skipped - 5)} more skipped)`);
  }
  lines.push("");
  lines.push(...totalsText(report.totals));
  if (report.onlineOnly) {
    lines.push(`Online-only: ${n(report.onlineOnly.files)} files (${n(report.onlineOnly.bytes)} bytes) were not read, because reading them downloads them. Confirm to read them.`);
  }
  for (const w of report.warnings) lines.push(`Warning: ${w}`);
  lines.push(report.accounted ? "Every file and every record is accounted for." : "NOT ACCOUNTED: the counts do not add up.");
  return lines.join("\n") + "\n";
}

export function batchesText(batches: BatchRow[]): string {
  if (!batches.length) return "No import batches.\n";
  return (
    batches
      .map((b) => {
        const t = b.totals;
        const summary = t ? `${n(t.files.all)} files, ${recordsText(t.records)}` : "no totals";
        return `${b.id}  ${b.state.padEnd(9)} ${b.started_at}  ${summary}`;
      })
      .join("\n") + "\n"
  );
}

export function undoText(result: UndoResult): string {
  return `Undid batch ${result.batchId}: ${n(result.undone.length)} file ${result.undone.length === 1 ? "change" : "changes"}, newest first. Rows: ${tablesText(result.tables)}.\n`;
}
