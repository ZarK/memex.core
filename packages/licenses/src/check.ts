import type { AllowEntry } from "./config.js";
import { hasChromiumCredits } from "./electron.js";
import { classify } from "./spdx.js";
import type { Component, Inventory } from "./types.js";

export type Rule =
  | "unknown-license" // no license, an id the tool does not know, or commercial use unknown for content Memex ships
  | "copyleft" // GPL or AGPL (or another strong copyleft license) without an allow entry
  | "custom-license" // a license file with a known license plus terms of its own; read it, then an allow entry
  | "limits" // bundled or hosted content with limits in its license; read them, then an allow entry
  | "missing-attribution" // no license text to ship with the code, or no credit line for content
  | "restricted-content" // non-commercial or territory-limited content that is bundled or hosted
  | "review-blocker" // an open blocker from the license review
  | "weak-copyleft" // note: LGPL, MPL and similar; keep the library replaceable and the source offer
  | "not-installed" // note: an optional package for another platform
  | "unused-allow" // note: an allow entry that matched nothing
  | "generated-text" // note: the package ships no license file; the notices hold the standard text
  | "inventory" // note: something the inventory could not read
  | "no-dependencies"; // nothing was read: no lockfile, assets file, vendor folder, font or third-party.json

/**
 * The only rules an allow entry can turn into "allowed". Unknown licenses, restricted content
 * (non-commercial, restricted commercial use, territory limits), missing credit and review blockers
 * always stay errors: Memex does not ship or host such content.
 */
export const ALLOWABLE_RULES: readonly Rule[] = ["copyleft", "custom-license", "limits"];

export type Severity = "error" | "note" | "allowed";

export interface Finding {
  rule: Rule;
  severity: Severity;
  key: string;
  detail: string;
  /** The allow entry's reason, when an entry allows the finding. */
  reason?: string;
}

export interface CheckResult {
  product: string;
  components: number;
  byEcosystem: Record<string, number>;
  byLicense: Record<string, number>;
  findings: Finding[];
  errors: number;
}

const CODE = new Set(["npm", "vite", "nuget", "dotnet", "electron", "font", "vendor"]);

function normExpr(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

function allowMatches(a: AllowEntry, c: Component): boolean {
  const m = a.match.trim();
  const short = c.key.slice(c.key.indexOf(":") + 1);
  const candidates = [c.key, short, c.name, `${c.ecosystem}:${c.name}`];
  if (!candidates.includes(m)) return false;
  return c.license !== null && normExpr(a.license) === normExpr(c.license);
}

export interface CheckOptions {
  /**
   * Report an empty inventory: an error, unless the reason says why the product has no third-party components
   * (memex-licenses.json `noDependencies`). Left out, an empty inventory is not reported.
   */
  emptyInventory?: { reason?: string };
}

/** Runs the license rules over an inventory. */
export function checkInventory(inv: Inventory, allow: AllowEntry[] = [], options: CheckOptions = {}): CheckResult {
  const findings: Finding[] = [];
  const used = new Set<number>();
  const byEcosystem: Record<string, number> = {};
  const byLicense: Record<string, number> = {};
  let count = 0;

  const push = (c: Component, rule: Rule, severity: Severity, detail: string) => {
    if (severity === "error") {
      const i = ALLOWABLE_RULES.includes(rule) ? allow.findIndex((a) => (a.rules ?? ["copyleft"]).includes(rule) && allowMatches(a, c)) : -1;
      if (i !== -1) {
        used.add(i);
        findings.push({ rule, severity: "allowed", key: c.key, detail, reason: allow[i]!.reason });
        return;
      }
    }
    findings.push({ rule, severity, key: c.key, detail });
  };

  for (const c of inv.components) {
    if (c.missingOptional) {
      findings.push({ rule: "not-installed", severity: "note", key: c.key, detail: "optional package not installed on this machine (another platform); not in these notices" });
      continue;
    }
    count++;
    byEcosystem[c.ecosystem] = (byEcosystem[c.ecosystem] ?? 0) + 1;
    byLicense[c.license ?? "(none)"] = (byLicense[c.license ?? "(none)"] ?? 0) + 1;
    const shipsOrHosts = c.delivery === "bundled" || c.delivery === "hosted";

    if (c.missing) {
      push(c, "unknown-license", "error", `in the lockfile or assets file but not installed (${c.licenseFrom})`);
      continue;
    }
    if (c.license === null) {
      push(c, "unknown-license", "error", `no license declared (${c.licenseFrom})`);
    } else {
      const k = classify(c.license);
      if (k.parseError !== undefined) push(c, "unknown-license", "error", `"${c.license}" is not an SPDX expression: ${k.parseError}`);
      else if (k.unknownIds.length > 0) push(c, "unknown-license", "error", `unknown license id ${k.unknownIds.join(", ")} (${c.licenseFrom})`);
      else if (k.class === "custom" && CODE.has(c.ecosystem) && c.licenseFiles.length === 0) {
        push(c, "unknown-license", "error", `${c.license} without a license text`);
      }
      if (c.customTerms !== undefined) {
        push(c, "custom-license", "error", `${c.licenseFrom}: ${c.customTerms}; read the text, then add an allow entry for ${c.license} with rules ["custom-license"] and a reason`);
      }
      if (k.class === "copyleft") push(c, "copyleft", "error", `${c.license}: strong copyleft; needs an allow entry with a reason`);
      if (k.class === "weak-copyleft") push(c, "weak-copyleft", "note", `${c.license}: keep it a separate, replaceable library and offer its source`);
      if (k.class === "non-commercial" && shipsOrHosts) push(c, "restricted-content", "error", `${c.license} is non-commercial and is ${c.delivery}`);

      if (CODE.has(c.ecosystem)) {
        if (c.ecosystem === "electron" && !hasChromiumCredits(c)) {
          push(c, "missing-attribution", "error", c.note ?? "LICENSES.chromium.html is missing");
        } else if (k.needsCredit && c.licenseFiles.length === 0) {
          push(c, "missing-attribution", "error", `${c.license} asks for its license text, and the package has no license file`);
        }
      } else if (k.needsCredit && (c.attribution === null || c.attribution === undefined || c.attribution.trim() === "")) {
        push(c, "missing-attribution", "error", `${c.license} asks for credit, and no credit line (attribution) is set`);
      }
    }

    if (!CODE.has(c.ecosystem)) {
      if (c.commercial === "unknown" && (shipsOrHosts || c.ecosystem === "pack")) {
        push(c, "unknown-license", "error", `commercial use unknown and the content is ${c.ecosystem === "pack" ? "a pack" : c.delivery}`);
      }
      const restricted = shipsOrHosts && c.commercial === "restricted" && !(c.license !== null && classify(c.license).class === "non-commercial");
      if (restricted) {
        push(c, "restricted-content", "error", `commercial use restricted and the content is ${c.delivery}${c.limits?.length ? `: ${c.limits.join(" ")}` : ""}`);
      }
      const territorial = shipsOrHosts && (c.territories?.length ?? 0) > 0;
      if (territorial) {
        push(c, "restricted-content", "error", `territory limits and the content is ${c.delivery}: ${c.territories!.join(" ")}`);
      }
      // Any other limit on content that Memex ships or hosts needs someone to read it and decide.
      if (shipsOrHosts && !restricted && !territorial && (c.limits?.length ?? 0) > 0) {
        push(c, "limits", "error", `the license has limits and the content is ${c.delivery}: ${c.limits!.join(" ")}; read them, then add an allow entry with rules ["limits"] and a reason`);
      }
    }
    // A blocker stops content that Memex ships or hosts; for a download or a service it is a note.
    if (c.blocker) push(c, "review-blocker", shipsOrHosts ? "error" : "note", `${c.delivery}: ${c.blocker}`);
    if (c.licenseTextFrom) findings.push({ rule: "generated-text", severity: "note", key: c.key, detail: `no license file in the package; the notices hold the license file of its main package ${c.licenseTextFrom}` });
    if (c.generatedText) findings.push({ rule: "generated-text", severity: "note", key: c.key, detail: `no license file in the package; the notices hold the standard ${c.license} text with "${c.copyright[0] ?? ""}"` });
    if (c.note && c.ecosystem === "pack") findings.push({ rule: "inventory", severity: "note", key: c.key, detail: c.note });
  }

  allow.forEach((a, i) => {
    if (!used.has(i)) findings.push({ rule: "unused-allow", severity: "note", key: a.match, detail: `allow entry for ${a.license} matched no finding` });
  });
  for (const n of inv.notes) findings.push({ rule: "inventory", severity: "note", key: n.source, detail: n.message });
  const empty = options.emptyInventory;
  if (empty !== undefined) {
    const reason = empty.reason?.trim() ?? "";
    if (inv.components.length === 0 && reason === "") {
      findings.push({
        rule: "no-dependencies",
        severity: "error",
        key: inv.product,
        detail:
          "the check read no dependencies (no pnpm-lock.yaml, package-lock.json, project.assets.json, vendor folder, font or third-party.json); install and build first, or say why there are none with noDependencies in memex-licenses.json",
      });
    } else if (inv.components.length === 0) {
      findings.push({ rule: "no-dependencies", severity: "note", key: inv.product, detail: `no third-party components: ${reason}` });
    } else if (reason !== "") {
      findings.push({
        rule: "no-dependencies",
        severity: "error",
        key: inv.product,
        detail: `memex-licenses.json says there are no dependencies, but the check found ${inv.components.length}; remove noDependencies`,
      });
    }
  }

  const rank: Record<Severity, number> = { error: 0, allowed: 1, note: 2 };
  findings.sort((a, b) => rank[a.severity] - rank[b.severity] || a.rule.localeCompare(b.rule) || a.key.localeCompare(b.key));
  return {
    product: inv.product,
    components: count,
    byEcosystem,
    byLicense,
    findings,
    errors: findings.filter((f) => f.severity === "error").length,
  };
}
