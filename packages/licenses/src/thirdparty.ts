import path from "node:path";
import { isFile, licenseFileFromPath, readJson } from "./files.js";
import { classify, isUnknownDeclaration } from "./spdx.js";
import type { Commercial, Component, Delivery } from "./types.js";

export const THIRD_PARTY_FORMAT = "memex.third-party/1";

export interface ThirdPartyLicense {
  spdx: string;
  url?: string;
  /** A license text in the repository, relative to the third-party.json file. */
  file?: string;
  commercial?: Commercial;
  limits?: string[];
  /** Places where the license does not apply or the content may not be used. */
  territories?: string[];
  attribution: string | null;
}

export interface ThirdPartyItem {
  id: string;
  name: string;
  kind: string;
  version?: string;
  source?: string;
  delivery: Delivery;
  license: ThirdPartyLicense;
  notice?: string;
  blocker?: string | null;
  /** Files in the repository that hold the item, relative to the repository root. */
  paths?: string[];
}

export interface ThirdPartyFile {
  format: typeof THIRD_PARTY_FORMAT;
  items: ThirdPartyItem[];
}

export class ThirdPartyError extends Error {}

const DELIVERIES = new Set<Delivery>(["bundled", "hosted", "download", "service"]);
const COMMERCIAL = new Set<Commercial>(["allowed", "restricted", "unknown"]);
// Words that name places in a limit. Every limit on bundled or hosted content is an error anyway;
// these words make it a territory limit, which no allow entry can pass.
const PLACE_WORDS = [
  "territor(y|ies)", "countr(y|ies)", "regions?", "jurisdictions?", "excluded",
  "european union", "european economic area", "eea", "eu", "europe(an)?", "united kingdom", "uk", "united states", "u\\.s\\.", "usa",
  "asia", "africa", "north america", "south america", "latin america", "middle east", "oceania", "scandinavia", "nordic",
  "afghanistan", "albania", "algeria", "andorra", "angola", "argentina", "armenia", "australia", "austria", "azerbaijan",
  "bahamas", "bahrain", "bangladesh", "barbados", "belarus", "belgium", "belize", "benin", "bhutan", "bolivia", "bosnia",
  "botswana", "brazil", "brunei", "bulgaria", "burkina faso", "burundi", "cambodia", "cameroon", "canada", "cape verde",
  "chad", "chile", "china", "colombia", "comoros", "congo", "costa rica", "croatia", "cuba", "cyprus", "czech(ia)?",
  "denmark", "djibouti", "dominican republic", "ecuador", "egypt", "el salvador", "eritrea", "estonia", "eswatini",
  "ethiopia", "fiji", "finland", "france", "gabon", "gambia", "georgia", "germany", "ghana", "greece", "greenland",
  "guatemala", "guinea", "guyana", "haiti", "honduras", "hong kong", "hungary", "iceland", "india", "indonesia", "iran",
  "iraq", "ireland", "israel", "italy", "ivory coast", "jamaica", "japan", "jordan", "kazakhstan", "kenya", "kiribati",
  "korea", "kosovo", "kuwait", "kyrgyzstan", "laos", "latvia", "lebanon", "lesotho", "liberia", "libya", "liechtenstein",
  "lithuania", "luxembourg", "macau", "madagascar", "malawi", "malaysia", "maldives", "mali", "malta", "mauritania",
  "mauritius", "mexico", "micronesia", "moldova", "monaco", "mongolia", "montenegro", "morocco", "mozambique", "myanmar",
  "burma", "namibia", "nauru", "nepal", "netherlands", "new zealand", "nicaragua", "niger", "nigeria", "(north )?macedonia",
  "norway", "oman", "pakistan", "palau", "palestine", "panama", "papua new guinea", "paraguay", "peru", "philippines",
  "poland", "portugal", "qatar", "romania", "russia(n federation)?", "rwanda", "samoa", "san marino", "saudi arabia",
  "senegal", "serbia", "seychelles", "sierra leone", "singapore", "slovakia", "slovenia", "somalia", "south africa",
  "spain", "sri lanka", "sudan", "suriname", "sweden", "switzerland", "syria", "taiwan", "tajikistan", "tanzania",
  "thailand", "timor-leste", "togo", "tonga", "trinidad", "tunisia", "turkey", "türkiye", "turkmenistan", "tuvalu",
  "uganda", "ukraine", "crimea", "united arab emirates", "uae", "uruguay", "uzbekistan", "vanuatu", "vatican",
  "venezuela", "viet ?nam", "yemen", "zambia", "zimbabwe", "england", "scotland", "wales", "(great )?britain",
];
const TERRITORY = new RegExp(`(^|[^\\p{L}])(${PLACE_WORDS.join("|")})(?=$|[^\\p{L}])`, "iu");

/** Commercial use as a license id suggests it, when no one stated it. */
export function commercialFromSpdx(spdx: string): Commercial {
  if (isUnknownDeclaration(spdx)) return "unknown";
  const c = classify(spdx);
  if (c.class === "non-commercial") return "restricted";
  if (c.class === "custom" || c.class === "unknown") return "unknown";
  return "allowed";
}

/** Whether a limit names a place: a country, a region such as the EEA or Europe, or territories as such. */
export function namesPlace(limit: string): boolean {
  return TERRITORY.test(limit);
}

/** Limits that name places become territories. */
export function territoriesFromLimits(limits: string[]): string[] {
  return limits.filter(namesPlace);
}

export function readThirdParty(file: string): ThirdPartyFile {
  const doc = readJson(file) as Partial<ThirdPartyFile>;
  if (doc.format !== THIRD_PARTY_FORMAT) throw new ThirdPartyError(`${file}: format must be ${THIRD_PARTY_FORMAT}`);
  if (!Array.isArray(doc.items)) throw new ThirdPartyError(`${file}: items must be a list`);
  const ids = new Set<string>();
  doc.items.forEach((item, i) => {
    const where = `${file}: items[${i}]`;
    if (typeof item?.id !== "string" || item.id === "") throw new ThirdPartyError(`${where}: id is missing`);
    if (ids.has(item.id)) throw new ThirdPartyError(`${where}: id ${item.id} is used twice`);
    ids.add(item.id);
    if (typeof item.name !== "string") throw new ThirdPartyError(`${where}: name is missing`);
    if (!DELIVERIES.has(item.delivery)) throw new ThirdPartyError(`${where}: delivery must be bundled, hosted, download or service`);
    if (item.license === null || typeof item.license !== "object" || typeof item.license.spdx !== "string") {
      throw new ThirdPartyError(`${where}: license.spdx is missing`);
    }
    if (item.license.commercial !== undefined && !COMMERCIAL.has(item.license.commercial)) {
      throw new ThirdPartyError(`${where}: license.commercial must be allowed, restricted or unknown`);
    }
    const limits = item.license.limits;
    if (limits !== undefined && (!Array.isArray(limits) || limits.some((l) => typeof l !== "string"))) {
      throw new ThirdPartyError(`${where}: license.limits must be a list of strings`);
    }
    const territories = item.license.territories;
    if (territories !== undefined && (!Array.isArray(territories) || territories.some((l) => typeof l !== "string"))) {
      throw new ThirdPartyError(`${where}: license.territories must be a list of strings`);
    }
    const placed = (limits ?? []).filter(namesPlace);
    if (placed.length > 0 && territories === undefined) {
      throw new ThirdPartyError(
        `${where}: license.limits name a place ("${placed[0]}"), so license.territories is required: the places, or [] when the limit is not about places`,
      );
    }
    if (item.license.attribution === undefined) throw new ThirdPartyError(`${where}: license.attribution is missing (null when no credit is needed)`);
  });
  return doc as ThirdPartyFile;
}

export function thirdPartyComponents(doc: ThirdPartyFile, file: string, via: string): Component[] {
  return doc.items.map((item) => {
    const lic = item.license;
    const files = [];
    if (lic.file !== undefined) {
      const full = path.resolve(path.dirname(file), lic.file);
      if (isFile(full)) files.push(licenseFileFromPath(full));
    }
    const limits = lic.limits ?? [];
    return {
      key: `third-party:${item.id}`,
      ecosystem: "third-party",
      name: item.name,
      version: item.version ?? "",
      license: isUnknownDeclaration(lic.spdx) ? null : lic.spdx,
      licenseFrom: "third-party.json",
      licenseFiles: files,
      copyright: [],
      homepage: item.source ?? lic.url,
      delivery: item.delivery,
      via: [via],
      kind: item.kind,
      attribution: lic.attribution,
      commercial: lic.commercial ?? commercialFromSpdx(lic.spdx),
      limits,
      territories: lic.territories ?? territoriesFromLimits(limits),
      notice: item.notice,
      blocker: item.blocker ?? null,
      note: lic.file !== undefined && files.length === 0 ? `license file ${lic.file} not found` : undefined,
    } satisfies Component;
  });
}

/** Items that the scanners find on their own, so a review import leaves them out. */
const SCANNED_ID = /^(npm[:-]|nuget[:-]|vendor[:-]|font[:-]|runtime:electron$|npm-electron$|dotnet-runtime)/i;

export interface ReviewItem {
  id: string;
  kind: string;
  name: string;
  version?: string;
  license?: string;
  spdx: string;
  source?: string;
  licenseText?: string;
  action: string;
  commercial?: Commercial;
  limits?: string[];
  notice?: string | null;
  blocker?: string | null;
  verified?: { url?: string };
}

export interface ReviewImport {
  file: ThirdPartyFile;
  skipped: { id: string; reason: string }[];
}

/**
 * Turns the items of one repository in a license review (memex.license-review/0-draft) into
 * a third-party.json: ship is bundled, host is hosted, download is download, and remove is left out.
 * Items that the scanners find themselves (npm and NuGet packages, vendored code, fonts,
 * Electron, the .NET runtime) are left out too.
 */
export function importReview(review: unknown, repoMatch?: string): ReviewImport {
  const doc = review as { format?: unknown; repos?: { repo?: string; path?: string; items?: ReviewItem[] }[] };
  if (typeof doc.format !== "string" || !doc.format.startsWith("memex.license-review/")) {
    throw new ThirdPartyError("not a license review (format memex.license-review/*)");
  }
  const repos = (doc.repos ?? []).filter((r) => repoMatch === undefined || `${r.repo ?? ""} ${r.path ?? ""}`.toLowerCase().includes(repoMatch.toLowerCase()));
  if (repos.length === 0) throw new ThirdPartyError(`no repository in the review matches ${repoMatch ?? "(any)"}`);
  const items: ThirdPartyItem[] = [];
  const skipped: { id: string; reason: string }[] = [];
  const seen = new Set<string>();
  for (const repo of repos) {
    for (const it of repo.items ?? []) {
      if (it.action === "remove") {
        skipped.push({ id: it.id, reason: "remove" });
        continue;
      }
      if (SCANNED_ID.test(it.id) || it.kind === "font") {
        skipped.push({ id: it.id, reason: "found by the scanners" });
        continue;
      }
      const delivery: Delivery | undefined =
        it.kind === "service" ? "service" : ({ ship: "bundled", host: "hosted", download: "download" } as Record<string, Delivery>)[it.action];
      if (delivery === undefined) {
        skipped.push({ id: it.id, reason: `unknown action ${it.action}` });
        continue;
      }
      if (seen.has(it.id)) continue;
      seen.add(it.id);
      const limits = it.limits ?? [];
      items.push({
        id: it.id,
        name: it.name,
        kind: it.kind,
        version: it.version,
        source: it.source,
        delivery,
        license: {
          spdx: it.spdx,
          url: it.licenseText ?? it.verified?.url ?? it.source,
          commercial: it.commercial ?? commercialFromSpdx(it.spdx),
          limits,
          territories: territoriesFromLimits(limits),
          attribution: it.notice === undefined || it.notice === "" ? null : it.notice,
        },
        notice: it.license,
        blocker: it.blocker ?? null,
      });
    }
  }
  return { file: { format: THIRD_PARTY_FORMAT, items }, skipped };
}
