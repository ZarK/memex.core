import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { checkInventory, type CheckResult, type Finding } from "./check.js";
import { ConfigError, loadConfig } from "./config.js";
import { readJson } from "./files.js";
import { buildInventory, collectPacks, type InventoryOptions } from "./inventory.js";
import { writeNotices } from "./notices.js";
import { OWN_LICENSES, checkOwnLicense, type OwnLicense } from "./own.js";
import { creditLines, creditsMarkdown } from "./packs.js";
import { LockfileError } from "./pnpm.js";
import { ThirdPartyError, importReview } from "./thirdparty.js";
import type { InventoryNote } from "./types.js";

const USAGE = `Usage:
  memex-licenses check   [--repo <dir>] [--config <file>] [--json] [inputs]
  memex-licenses notices --out <empty folder> [--repo <dir>] [--config <file>] [--json] [inputs]
  memex-licenses packs   <manifest or folder>... [--format md|text|json] [--out <file>]
  memex-licenses third-party --from-review <license-review.json> [--match <repo>] [--out <file>]
  memex-licenses own     --expect <MIT|AGPL-3.0-or-later|GPL-3.0-or-later> [--repo <dir>] [--pending <step and reason>] [--json]

Inputs (each replaces what the config or the repository walk gives):
  --importer <path>       pnpm importer to read, repeatable (default: every importer)
  --vite <dist>           Vite build folder, repeatable
  --dotnet <file|dir>     project.assets.json or project folder, repeatable
  --electron-dist <dir>   folder with LICENSES.chromium.html (Electron dist or an unpacked app)
  --electron-zip <file>   Electron release zip
  --third-party <file>    third-party.json, repeatable
  --packs <file|dir>      memex.pack/1 manifest or folder, repeatable
  --product <name>        product name in the notices

The config is --config, else memex-licenses.json in the repository.
own checks the repository's own LICENSE file and the license of its manifests against its group;
--pending says why a license is still open and what settles it, and makes a mismatch a note.
check exits 0 when clean, 1 on findings, 2 on a usage error. notices exits 0 unless it cannot write.`;

export interface CliIo {
  out?: (line: string) => void;
}

const INPUT_OPTIONS = {
  repo: { type: "string" },
  config: { type: "string" },
  json: { type: "boolean" },
  importer: { type: "string", multiple: true },
  vite: { type: "string", multiple: true },
  dotnet: { type: "string", multiple: true },
  "electron-dist": { type: "string" },
  "electron-zip": { type: "string" },
  "third-party": { type: "string", multiple: true },
  packs: { type: "string", multiple: true },
  product: { type: "string" },
  out: { type: "string" },
} as const;

class UsageError extends Error {}

function describe(f: Finding): string {
  const tag = f.severity === "error" ? "" : f.severity === "allowed" ? " (allowed)" : " (note)";
  return `${(f.rule + tag).padEnd(30)} ${f.key}  ${f.detail}${f.reason ? `  [reason: ${f.reason}]` : ""}`;
}

function summarize(r: CheckResult, sources: string[]): string[] {
  const lines = [`Product: ${r.product}`, "Read:"];
  for (const s of sources) lines.push(`  ${s}`);
  lines.push(`Components: ${r.components} (${Object.entries(r.byEcosystem).map(([k, v]) => `${k} ${v}`).join(", ")})`);
  lines.push(`Licenses: ${Object.entries(r.byLicense).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  const by = (s: string) => r.findings.filter((f) => f.severity === s).length;
  lines.push(`Findings: ${by("error")} errors, ${by("allowed")} allowed, ${by("note")} notes`);
  return lines;
}

function inventoryOptions(values: Record<string, unknown>): InventoryOptions {
  const root = path.resolve((values.repo as string | undefined) ?? process.cwd());
  if (!fs.existsSync(root)) throw new UsageError(`repository not found: ${root}`);
  const { config } = loadConfig(root, values.config as string | undefined);
  return {
    root,
    config,
    importers: values.importer as string[] | undefined,
    vite: values.vite as string[] | undefined,
    dotnet: values.dotnet as string[] | undefined,
    electronDist: values["electron-dist"] as string | undefined,
    electronZip: values["electron-zip"] as string | undefined,
    thirdParty: values["third-party"] as string[] | undefined,
    packs: values.packs as string[] | undefined,
    product: values.product as string | undefined,
  };
}

function emptyOrMissing(dir: string): boolean {
  try {
    return fs.readdirSync(dir).length === 0;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

export async function main(argv: string[], io: CliIo = {}): Promise<number> {
  const out = io.out ?? ((line: string) => console.log(line));
  const [command, ...rest] = argv;
  try {
    if (command === "check" || command === "notices") {
      const { values } = parseArgs({ args: rest, options: INPUT_OPTIONS, allowPositionals: false, strict: true });
      const opts = inventoryOptions(values);
      const inv = buildInventory(opts);
      const result = checkInventory(inv, opts.config.allow ?? [], { emptyInventory: { reason: opts.config.noDependencies } });
      if (command === "check") {
        if (values.json) out(JSON.stringify({ ...result, sources: inv.sources }, null, 2));
        else {
          for (const l of summarize(result, inv.sources)) out(l);
          for (const f of result.findings) out(describe(f));
        }
        return result.errors > 0 ? 1 : 0;
      }
      const target = values.out;
      if (target === undefined) throw new UsageError("notices needs --out <empty folder>");
      const outDir = path.resolve(target);
      if (!emptyOrMissing(outDir)) throw new UsageError(`the output folder is not empty: ${outDir}`);
      const written = writeNotices(inv, outDir);
      if (values.json) out(JSON.stringify({ outDir: written.outDir, entries: written.entries.length, files: written.files, bytes: written.bytes, errors: result.errors }, null, 2));
      else {
        out(`Wrote ${path.join(outDir, "THIRD-PARTY-NOTICES.md")}, notices.json and licenses/ (${written.files} files, ${written.bytes} bytes)`);
        out(`Entries: ${written.entries.length}`);
        out(`check: ${result.errors} errors${result.errors > 0 ? " (run memex-licenses check)" : ""}`);
      }
      return 0;
    }
    if (command === "packs") {
      const { values, positionals } = parseArgs({
        args: rest,
        options: { format: { type: "string" }, out: { type: "string" } },
        allowPositionals: true,
        strict: true,
      });
      if (positionals.length === 0) throw new UsageError("packs needs at least one manifest or folder");
      const format = values.format ?? "md";
      if (!["md", "text", "json"].includes(format)) throw new UsageError("--format must be md, text or json");
      const notes: InventoryNote[] = [];
      const packs = collectPacks(positionals.map((p) => path.resolve(p)), notes);
      for (const n of notes) out(`skipped ${n.source}: ${n.message}`);
      const lines = creditLines(packs.map((p) => p.pack));
      const text =
        format === "json" ? JSON.stringify({ format: "memex.pack-credits/1", credits: lines }, null, 2) + "\n"
        : format === "text" ? lines.map((l) => l.credit).join("\n") + (lines.length > 0 ? "\n" : "")
        : creditsMarkdown(lines);
      if (values.out !== undefined) {
        fs.mkdirSync(path.dirname(path.resolve(values.out)), { recursive: true });
        fs.writeFileSync(path.resolve(values.out), text);
        out(`Wrote ${lines.length} credit lines to ${path.resolve(values.out)}`);
      } else out(text.trimEnd());
      return notes.length > 0 && packs.length === 0 ? 1 : 0;
    }
    if (command === "third-party") {
      const { values } = parseArgs({
        args: rest,
        options: { "from-review": { type: "string" }, match: { type: "string" }, out: { type: "string" } },
        strict: true,
      });
      if (values["from-review"] === undefined) throw new UsageError("third-party needs --from-review <license-review.json>");
      const imported = importReview(readJson(path.resolve(values["from-review"])), values.match);
      const text = JSON.stringify(imported.file, null, 2) + "\n";
      if (values.out !== undefined) {
        fs.mkdirSync(path.dirname(path.resolve(values.out)), { recursive: true });
        fs.writeFileSync(path.resolve(values.out), text);
        out(`Wrote ${imported.file.items.length} items to ${path.resolve(values.out)}; skipped ${imported.skipped.length} (${summarizeSkipped(imported.skipped)})`);
      } else out(text.trimEnd());
      return 0;
    }
    if (command === "own") {
      const { values } = parseArgs({
        args: rest,
        options: { expect: { type: "string" }, repo: { type: "string" }, pending: { type: "string" }, json: { type: "boolean" } },
        strict: true,
      });
      const expected = values.expect;
      if (expected === undefined || !(OWN_LICENSES as readonly string[]).includes(expected)) {
        throw new UsageError(`own needs --expect with one of ${OWN_LICENSES.join(", ")}`);
      }
      const root = path.resolve(values.repo ?? process.cwd());
      if (!fs.existsSync(root)) throw new UsageError(`repository not found: ${root}`);
      const result = checkOwnLicense(root, expected as OwnLicense);
      const pending = values.pending?.trim() || undefined;
      if (values.json) out(JSON.stringify({ ...result, pending: pending ?? null }, null, 2));
      else {
        out(`Expected: ${result.expected}`);
        out(`License file: ${result.licenseFile ?? "none"}${result.licenseText ? ` (${result.licenseText} text)` : ""}`);
        for (const m of result.manifests) out(`${m.file}: ${m.license ?? "no license"}`);
        for (const p of result.problems) out(`${pending ? "pending" : "own-license"}`.padEnd(14) + ` ${p.file}  ${p.detail}`);
        if (result.ok) out("OK: the repository's license matches its group.");
        else if (pending) out(`Pending: ${pending}`);
      }
      return result.ok || pending ? 0 : 1;
    }
    if (command === undefined || command === "help" || command === "--help" || command === "-h") {
      out(USAGE);
      return command === undefined ? 2 : 0;
    }
    throw new UsageError(`unknown command: ${command}`);
  } catch (error) {
    if (error instanceof UsageError || error instanceof ConfigError || error instanceof ThirdPartyError || error instanceof LockfileError || (error as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")) {
      out(`memex-licenses: ${(error as Error).message}`);
      if (error instanceof UsageError || (error as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")) out(USAGE);
      return 2;
    }
    throw error;
  }
}

function summarizeSkipped(skipped: { reason: string }[]): string {
  const counts = new Map<string, number>();
  for (const s of skipped) counts.set(s.reason, (counts.get(s.reason) ?? 0) + 1);
  return [...counts].map(([r, n]) => `${r}: ${n}`).join(", ") || "none";
}
