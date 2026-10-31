import { readJson } from "./files.js";
import { classify, isUnknownDeclaration } from "./spdx.js";
import { territoriesFromLimits } from "./thirdparty.js";
import type { Commercial, Component } from "./types.js";

export const PACK_FORMAT = "memex.pack/1";

export interface PackLicense {
  spdx: string;
  url?: string;
  file?: string;
  commercial: Commercial;
  limits: string[];
  attribution: string | null;
  acceptance: "required" | "none";
}

export interface PackManifest {
  format: typeof PACK_FORMAT;
  id: string;
  version: string;
  title: string;
  kind: string;
  origin: "upstream" | "memex";
  source?: { publisher?: string; homepage?: string; revision?: string };
  derivedFrom?: { url?: string; revision?: string; license?: string; notice?: string };
  license: PackLicense;
  files?: { path: string }[];
}

export class PackError extends Error {}

/** Reads a memex.pack/1 manifest and checks the fields the license check needs. */
export function readPack(file: string): PackManifest {
  const doc = readJson(file) as Partial<PackManifest>;
  if (doc.format !== PACK_FORMAT) throw new PackError(`${file}: format must be ${PACK_FORMAT}`);
  for (const k of ["id", "version", "title", "kind", "origin"] as const) {
    if (typeof doc[k] !== "string") throw new PackError(`${file}: ${k} is missing`);
  }
  if (doc.license === undefined || doc.license === null || typeof doc.license !== "object") throw new PackError(`${file}: license is missing`);
  return doc as PackManifest;
}

/** The pack as a component: hosted when Memex made it, downloaded from the publisher otherwise. */
export function packComponent(pack: PackManifest, via: string): Component {
  const lic = pack.license;
  const limits = Array.isArray(lic.limits) ? lic.limits : [];
  const notes: string[] = [];
  if (pack.origin === "memex" && pack.derivedFrom === undefined) notes.push("origin memex without derivedFrom");
  if (lic.acceptance === "required" && (lic.file === undefined || !(pack.files ?? []).some((f) => f.path === lic.file))) {
    notes.push("acceptance required but license.file is not one of the pack files");
  }
  return {
    key: `pack:${pack.id}@${pack.version}`,
    ecosystem: "pack",
    name: pack.title,
    version: pack.version,
    license: typeof lic.spdx !== "string" || isUnknownDeclaration(lic.spdx) ? null : lic.spdx,
    licenseFrom: "memex.pack/1",
    licenseFiles: [],
    copyright: [],
    homepage: pack.source?.homepage ?? lic.url,
    delivery: pack.origin === "memex" ? "hosted" : "download",
    via: [via],
    kind: pack.kind,
    attribution: lic.attribution === undefined ? undefined : lic.attribution,
    commercial: lic.commercial,
    limits,
    territories: territoriesFromLimits(limits),
    note: notes.length > 0 ? notes.join("; ") : undefined,
  };
}

export interface CreditLine {
  id: string;
  version: string;
  title: string;
  credit: string;
  /** True when the license asks for credit; false when the line is a courtesy. */
  required: boolean;
  license: string;
  url?: string;
}

/** The credit line of each pack: its attribution, or a line made from the title, publisher and license. */
export function creditLines(packs: PackManifest[]): CreditLine[] {
  return packs
    .map((p) => {
      const spdx = typeof p.license.spdx === "string" ? p.license.spdx : "unknown";
      const required = isUnknownDeclaration(spdx) ? true : classify(spdx).needsCredit;
      const publisher = p.source?.publisher;
      const made = `${p.title}${publisher ? ` by ${publisher}` : ""}, ${spdx}`;
      const derived = p.origin === "memex" && p.derivedFrom?.notice ? ` ${p.derivedFrom.notice}` : "";
      return {
        id: p.id,
        version: p.version,
        title: p.title,
        credit: (p.license.attribution ?? made) + derived,
        required,
        license: spdx,
        url: p.license.url ?? p.source?.homepage,
      };
    })
    .sort((a, b) => a.title.localeCompare(b.title, "en"));
}

export function creditsMarkdown(lines: CreditLine[]): string {
  const out = ["# Pack credits", ""];
  const req = lines.filter((l) => l.required);
  const courtesy = lines.filter((l) => !l.required);
  if (req.length > 0) {
    out.push("## Credit required", "");
    for (const l of req) out.push(`- ${l.credit}${l.url ? ` (${l.url})` : ""}`);
    out.push("");
  }
  if (courtesy.length > 0) {
    out.push("## Credited as a courtesy", "");
    for (const l of courtesy) out.push(`- ${l.credit}${l.url ? ` (${l.url})` : ""}`);
    out.push("");
  }
  if (lines.length === 0) out.push("No packs.", "");
  return out.join("\n");
}
