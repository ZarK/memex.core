import fs from "node:fs";
import path from "node:path";
import { licenseText, safeName } from "./files.js";
import type { Component, Inventory, LicenseFile } from "./types.js";

export const NOTICES_FORMAT = "memex.notices/1";

/** License texts larger than this are linked from THIRD-PARTY-NOTICES.md, not written into it. */
export const INLINE_LIMIT = 256 * 1024;

export interface NoticeEntry {
  key: string;
  ecosystem: string;
  name: string;
  version: string;
  license: string | null;
  delivery: string;
  kind?: string;
  homepage?: string;
  copyright: string[];
  attribution?: string | null;
  notice?: string;
  limits?: string[];
  /** The license files in the licenses/ folder, relative to the output folder. */
  files: string[];
  via: string[];
}

export interface NoticesResult {
  outDir: string;
  entries: NoticeEntry[];
  files: number;
  bytes: number;
}

const SECTIONS: { ecosystem: string; title: string }[] = [
  { ecosystem: "npm", title: "JavaScript packages" },
  { ecosystem: "vite", title: "Build tool code in the app" },
  { ecosystem: "nuget", title: ".NET packages" },
  { ecosystem: "dotnet", title: ".NET runtime" },
  { ecosystem: "electron", title: "Electron and Chromium" },
  { ecosystem: "font", title: "Fonts" },
  { ecosystem: "vendor", title: "Libraries copied into the app" },
];

const CONTENT: { delivery: string; title: string }[] = [
  { delivery: "bundled", title: "In the app" },
  { delivery: "hosted", title: "Hosted by Memex" },
  { delivery: "download", title: "Downloaded on your device from the publisher" },
  { delivery: "service", title: "Services the app calls" },
];

function folderOf(c: Component): string {
  const name = safeName(c.name.replace(/\//g, "+"));
  return `licenses/${c.ecosystem}/${c.version ? `${name}@${safeName(c.version)}` : name}`;
}

function fence(text: string): string {
  let longest = 2;
  for (const m of text.matchAll(/`{3,}|~{3,}/g)) longest = Math.max(longest, m[0].length);
  return "`".repeat(longest + 1);
}

function md(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function writeLicenseFile(outDir: string, folder: string, file: LicenseFile, used: Set<string>): string {
  let name = safeName(file.name);
  let n = 2;
  while (used.has(`${folder}/${name}`)) name = `${safeName(file.name)}.${n++}`;
  const relPath = `${folder}/${name}`;
  used.add(relPath);
  const target = path.join(outDir, ...relPath.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (file.path !== undefined) fs.copyFileSync(file.path, target);
  else fs.writeFileSync(target, file.text ?? "");
  return relPath;
}

/**
 * Writes THIRD-PARTY-NOTICES.md, notices.json and the licenses/ folder into outDir.
 * Optional packages that are not installed are left out. The output does not depend on the
 * time it is made, so the same inventory gives the same bytes.
 */
export function writeNotices(inv: Inventory, outDir: string): NoticesResult {
  const out = path.resolve(outDir);
  fs.mkdirSync(out, { recursive: true });
  const used = new Set<string>();
  const entries: NoticeEntry[] = [];
  const texts = new Map<string, { file: LicenseFile; rel: string; users: string[]; license: string }>();
  let files = 0;
  let bytes = 0;
  const shown = inv.components.filter((c) => !c.missingOptional);
  for (const c of shown) {
    const folder = folderOf(c);
    const rels: string[] = [];
    for (const f of c.licenseFiles) {
      const r = writeLicenseFile(out, folder, f, used);
      rels.push(r);
      files++;
      bytes += f.bytes;
      const label = `${c.name}${c.version ? ` ${c.version}` : ""}`;
      const t = texts.get(f.sha256);
      if (t === undefined) texts.set(f.sha256, { file: f, rel: r, users: [label], license: c.license ?? "unknown" });
      else if (!t.users.includes(label)) t.users.push(label);
    }
    entries.push({
      key: c.key,
      ecosystem: c.ecosystem,
      name: c.name,
      version: c.version,
      license: c.license,
      delivery: c.delivery,
      kind: c.kind,
      homepage: c.homepage,
      copyright: c.copyright,
      attribution: c.attribution,
      notice: c.notice,
      limits: c.limits && c.limits.length > 0 ? c.limits : undefined,
      files: rels,
      via: c.via,
    });
  }

  fs.writeFileSync(
    path.join(out, "notices.json"),
    JSON.stringify({ format: NOTICES_FORMAT, product: inv.product, components: entries }, null, 2) + "\n",
  );

  const lines: string[] = [];
  lines.push("# Third-party notices", "");
  lines.push(
    `${inv.product} includes the software and content listed here, and credits the content it downloads or uses. ` +
      "Each entry names its license. The license texts follow the lists. The machine-readable list is `notices.json`, and every license file is in the `licenses/` folder next to this file.",
    "",
  );
  const code = entries.filter((e) => SECTIONS.some((s) => s.ecosystem === e.ecosystem));
  const content = entries.filter((e) => e.ecosystem === "third-party" || e.ecosystem === "pack");
  lines.push("| Part | Entries |", "| --- | ---: |");
  for (const s of SECTIONS) {
    const n = code.filter((e) => e.ecosystem === s.ecosystem).length;
    if (n > 0) lines.push(`| ${s.title} | ${n} |`);
  }
  for (const s of CONTENT) {
    const n = content.filter((e) => e.delivery === s.delivery).length;
    if (n > 0) lines.push(`| Content: ${s.title.charAt(0).toLowerCase()}${s.title.slice(1)} | ${n} |`);
  }
  lines.push("");

  for (const s of SECTIONS) {
    const list = code.filter((e) => e.ecosystem === s.ecosystem);
    if (list.length === 0) continue;
    lines.push(`## ${s.title}`, "");
    lines.push("| Name | Version | License | Copyright | Home |", "| --- | --- | --- | --- | --- |");
    for (const e of list) {
      lines.push(`| ${md(e.name)} | ${md(e.version)} | ${md(e.license ?? "unknown")} | ${md(e.copyright[0] ?? "")} | ${e.homepage ? md(e.homepage) : ""} |`);
    }
    lines.push("");
  }

  if (content.length > 0) {
    lines.push("## Data, models and other content", "");
    for (const s of CONTENT) {
      const list = content.filter((e) => e.delivery === s.delivery);
      if (list.length === 0) continue;
      lines.push(`### ${s.title}`, "");
      for (const e of list) {
        const credit = e.attribution ? ` ${e.attribution.trim()}` : "";
        const limits = e.limits ? ` Limits: ${e.limits.join(" ")}` : "";
        const home = e.homepage ? ` <${e.homepage}>` : "";
        lines.push(`- **${md(e.name)}**${e.version ? ` (${md(e.version)})` : ""}: ${md(e.license ?? "unknown")}.${md(credit)}${md(limits)}${home}`);
      }
      lines.push("");
    }
  }

  if (texts.size > 0) {
    lines.push("## License texts", "");
    const sorted = [...texts.values()].sort((a, b) => a.license.localeCompare(b.license, "en") || a.rel.localeCompare(b.rel, "en"));
    for (const t of sorted) {
      // A notice file (NOTICE, ThirdPartyNotices, the Chromium credits) is named by its file, not by the license.
      const label = /notice|third|chromium|copyright|authors/i.test(t.file.name) ? t.file.name : t.license;
      lines.push(`### ${md(label)}: ${md(t.users.join(", "))}`, "");
      const text = t.file.bytes <= INLINE_LIMIT ? licenseText(t.file) : "";
      if (text.trim() === "") {
        lines.push(`See \`${t.rel}\` (${t.file.bytes} bytes).`, "");
        continue;
      }
      const f = fence(text);
      lines.push(f + "text", text.replace(/\r\n/g, "\n").trimEnd(), f, "");
    }
  }
  fs.writeFileSync(path.join(out, "THIRD-PARTY-NOTICES.md"), lines.join("\n"));
  return { outDir: out, entries, files, bytes };
}
