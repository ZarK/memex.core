// Names the license of a license text by its distinctive sentences. It reads only the
// common texts. Anything else stays null, and the check reports it as unknown.

function squash(text: string): string {
  return text.replace(/\s+/g, " ").toLowerCase();
}

const MARKERS = [
  "permission is hereby granted, free of charge",
  "redistribution and use in source and binary forms",
  "permission to use, copy, modify, and/or distribute this software",
  "permission to use, copy, modify, and distribute this software",
  "apache license",
  "sil open font license",
  "creative commons legal code",
  "this is free and unencumbered software",
  "boost software license",
];

/**
 * The SPDX id of a license text, or null when the text is not one this function knows. A file
 * that holds several permissive licenses one after another (for example BSD-3-Clause for the
 * project and MIT for code it took in) gives them all, joined with AND, in the order they appear.
 */
export function identifyLicenseText(text: string): string | null {
  const t = squash(text);
  // These texts quote phrases of other licenses, so they are read as one text.
  if (/gnu (affero |lesser |library )?general public license|mozilla public license|sil open font license/.test(t)) return identifyOne(t);
  const starts: number[] = [];
  for (const m of MARKERS) for (let i = t.indexOf(m); i !== -1; i = t.indexOf(m, i + 1)) starts.push(i);
  starts.sort((a, b) => a - b);
  if (starts.length <= 1) return identifyOne(t);
  const ids: string[] = [];
  for (let k = 0; k < starts.length; k++) {
    const id = identifyOne(t.slice(starts[k], starts[k + 1] ?? t.length));
    if (id !== null && !ids.includes(id)) ids.push(id);
  }
  if (ids.length === 0) return identifyOne(t);
  return ids.join(" AND ");
}

/**
 * The GNU license whose title comes first. Each GNU text names the others in its body (the GPL's section 13 names
 * the GNU Affero General Public License, the AGPL and the LGPL name the GPL), so the title, which comes first, decides.
 */
function gnuFamily(t: string): "agpl" | "lgpl" | "gpl" | null {
  const at = (phrase: string) => {
    const i = t.indexOf(phrase);
    return i === -1 ? Number.POSITIVE_INFINITY : i;
  };
  const found = [
    { family: "agpl" as const, at: at("gnu affero general public license") },
    { family: "lgpl" as const, at: Math.min(at("gnu lesser general public license"), at("gnu library general public license")) },
    { family: "gpl" as const, at: at("gnu general public license") },
  ].filter((f) => f.at !== Number.POSITIVE_INFINITY);
  found.sort((a, b) => a.at - b.at);
  return found[0]?.family ?? null;
}

function identifyOne(t: string): string | null {
  const gnu = gnuFamily(t);
  if (gnu === "agpl") return /version 3/.test(t) ? "AGPL-3.0-only" : "AGPL-1.0-only";
  if (gnu === "lgpl") {
    if (t.includes("version 3")) return "LGPL-3.0-only";
    if (t.includes("version 2.1")) return "LGPL-2.1-only";
    return "LGPL-2.0-only";
  }
  if (gnu === "gpl") {
    if (t.includes("version 3")) return "GPL-3.0-only";
    if (t.includes("version 2")) return "GPL-2.0-only";
    return "GPL-1.0-only";
  }
  if (t.includes("mozilla public license version 2.0") || t.includes("mozilla public license, version 2.0")) return "MPL-2.0";
  if (t.includes("sil open font license")) return "OFL-1.1";
  if (t.includes("apache license") && t.includes("version 2.0")) return "Apache-2.0";
  if (t.includes("creative commons legal code") && t.includes("cc0 1.0 universal")) return "CC0-1.0";
  if (t.includes("this is free and unencumbered software released into the public domain")) return "Unlicense";
  if (t.includes("permission is hereby granted, free of charge, to any person obtaining a copy")) {
    if (!t.includes("the above copyright notice and this permission notice shall be included")) return "MIT-0";
    return "MIT";
  }
  if (t.includes("permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted")) {
    return t.includes("provided that the above copyright notice and this permission notice appear in all copies") ? "ISC" : "0BSD";
  }
  if (t.includes("permission to use, copy, modify, and distribute this software for any purpose with or without fee is hereby granted")) {
    return t.includes("provided that the above copyright notice") ? "ISC" : "0BSD";
  }
  if (t.includes("redistribution and use in source and binary forms")) {
    if (t.includes("all advertising materials mentioning features")) return "BSD-4-Clause";
    if (t.includes("neither the name") || t.includes("the names of its contributors may not be used") || t.includes("may be used to endorse or promote")) {
      return "BSD-3-Clause";
    }
    return "BSD-2-Clause";
  }
  if (t.includes("boost software license - version 1.0")) return "BSL-1.0";
  if (t.includes("this software is provided 'as-is', without any express or implied warranty") && t.includes("altered source versions must be plainly marked")) {
    return "Zlib";
  }
  if (t.includes("blue oak model license")) return "BlueOak-1.0.0";
  if (t.includes("do what the fuck you want to public license")) return "WTFPL";
  if (t.includes("university of illinois/ncsa open source license")) return "NCSA";
  if (t.includes("python software foundation license")) return "Python-2.0";
  if (t.includes("creative commons attribution 4.0 international")) return "CC-BY-4.0";
  if (t.includes("in place of a legal notice, here is a blessing")) return "blessing";
  if (t.length < 400 && /\bpublic domain\b/.test(t)) return "LicenseRef-Public-Domain";
  if (t.includes("attribution-sharealike 4.0 international")) return "CC-BY-SA-4.0";
  return null;
}

// Words of terms that take rights away: a text with one of them is never read as a permissive license.
const RESTRICTION =
  /commons clause|competing (use|product|service|offering)|\bnon-?commercial\b|not for commercial|right to sell|business source license|functional source license|server side public license|elastic license|polyform|additional use grant|hippocratic license|ethical source|shall be used for good, not evil/;

const COPYLEFT_ID = /^(A?GPL|LGPL|MPL)-/;

/** Lines that may stand before the license text itself: titles, copyright lines, rules and links. */
function isHeaderLine(line: string): boolean {
  const l = line.trim().replace(/^[#>*\s]+/, "").replace(/[*\s]+$/, "");
  if (l === "") return true;
  if (/^[=\-*_~#.\s]+$/.test(l)) return true;
  if (/^(copyright|\(c\)|©|all rights reserved|portions copyright|spdx-license-identifier)/i.test(l)) return true;
  if (/^(https?:\/\/|<https?:\/\/)\S+$/i.test(l)) return true;
  if (/^version \d[\w.,\s]*$/i.test(l)) return true;
  if (l.length <= 80 && /licen[cs]e/i.test(l) && !RESTRICTION.test(l.toLowerCase())) return true;
  return false;
}

export interface LicenseTextReading {
  /** The SPDX id of the standard text, or null when the text is not one the tool knows. */
  id: string | null;
  /** Set when the text holds a known license plus terms of its own: why it is not the standard text. */
  custom?: string;
}

/**
 * Reads a license file for its license id. A known id counts only when the file has no words of
 * restricting terms (Commons Clause, competing use, non-commercial and similar). When the package
 * names the file as its license (`named`: npm "SEE LICENSE IN <file>", a nuspec license file), the
 * file must also be the standard text with nothing of its own before the license starts, because
 * npm and NuGet use that convention for licenses that have no SPDX id. Otherwise the reading has
 * `custom`, and the caller records a LicenseRef so that someone reads it.
 */
export function readLicenseText(text: string, options: { named?: boolean } = {}): LicenseTextReading {
  const id = identifyLicenseText(text);
  if (id === null) return { id: null };
  // Copyleft texts already need a decision, and the GPL itself says "noncommercial".
  if (id.split(" AND ").some((x) => COPYLEFT_ID.test(x))) return { id };
  const t = squash(text);
  const word = RESTRICTION.exec(t);
  if (word !== null) return { id, custom: `the text adds terms ("${word[0]}") to ${id}` };
  if (options.named !== true) return { id };
  const lines = text.split(/\r?\n/);
  let extra = 0;
  for (const line of lines) {
    const sq = squash(line);
    // A marker may wrap onto the next line, so its first words are enough.
    if (MARKERS.some((mk) => sq.includes(mk.slice(0, 16)))) break;
    if (!isHeaderLine(line)) extra += line.trim().length;
  }
  if (extra > 200) return { id, custom: `the text has ${extra} characters of its own before the ${id} text starts` };
  return { id };
}

/** The LicenseRef id for a license text with terms of its own; it changes when the text changes. */
export function customLicenseId(sha256: string): string {
  return `LicenseRef-Custom-${sha256.slice(0, 12)}`;
}

/**
 * The license that a license file gives: the known id when the file is the standard text, a
 * LicenseRef-Custom-* id with the reason when it adds terms of its own, null when it is not known.
 */
export function fromReading(
  reading: LicenseTextReading,
  sha: string,
  from: string,
): { license: string | null; licenseFrom: string; customTerms: string | undefined } {
  if (reading.id === null) return { license: null, licenseFrom: `${from} (not recognized)`, customTerms: undefined };
  if (reading.custom !== undefined) return { license: customLicenseId(sha), licenseFrom: `${from} (custom terms)`, customTerms: reading.custom };
  return { license: reading.id, licenseFrom: from, customTerms: undefined };
}

/** The copyright lines of a license text, at most five. */
export function copyrightLines(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^(copyright|\(c\)|©)\s/i.test(line) && !/copyright notice|copyright holders? (and|be liable)|copyright owner/i.test(line)) {
      out.push(line.replace(/\s+/g, " "));
      if (out.length === 5) break;
    }
  }
  return out;
}
