// SPDX license expressions: a small parser and the license classes the check needs.
// The list of ids is the common subset of the SPDX license list, not the whole list.
// An id outside it is "unknown" until someone adds it here or declares a LicenseRef.

export type LicenseClass =
  | "public-domain" // no conditions, no credit needed
  | "permissive" // keep the notice and the license text
  | "weak-copyleft" // LGPL, MPL, EPL and similar: file or library level
  | "copyleft" // GPL, AGPL and similar: the whole work
  | "non-commercial" // non-commercial or research only
  | "first-party" // LicenseRef-Memex-*: Memex's own content
  | "custom" // another LicenseRef-*: read the license text
  | "unknown";

const PUBLIC_DOMAIN = [
  "CC0-1.0", "0BSD", "Unlicense", "WTFPL", "MIT-0", "PDDL-1.0", "CC-PDDC", "LicenseRef-Public-Domain",
  "LicenseRef-Public-Domain-Mark", "BSD-0-Clause",
];

const PERMISSIVE = [
  "MIT", "MIT-CMU", "MIT-Modern-Variant", "X11", "ISC", "BSD-2-Clause", "BSD-3-Clause", "BSD-3-Clause-Clear",
  "BSD-4-Clause", "BSD-2-Clause-Patent", "Apache-1.1", "Apache-2.0", "Zlib", "zlib-acknowledgement", "BSL-1.0",
  "Python-2.0", "PSF-2.0", "Python-2.0.1", "BlueOak-1.0.0", "Unicode-3.0", "Unicode-DFS-2016", "Unicode-DFS-2015",
  "OFL-1.0", "OFL-1.1", "OFL-1.1-RFN", "OFL-1.1-no-RFN", "OFL-1.0-RFN", "OFL-1.0-no-RFN", "CC-BY-1.0",
  "CC-BY-2.0", "CC-BY-2.5", "CC-BY-3.0", "CC-BY-4.0", "CC-BY-SA-2.0", "CC-BY-SA-2.5", "CC-BY-SA-3.0",
  "CC-BY-SA-4.0", "CC-BY-ND-3.0", "CC-BY-ND-4.0", "ODC-By-1.0", "ODbL-1.0", "NLOD-1.0", "NLOD-2.0",
  "OGL-UK-3.0", "CDLA-Permissive-1.0", "CDLA-Permissive-2.0", "CDLA-Sharing-1.0", "NCSA", "blessing",
  "ImageMagick", "Artistic-1.0", "Artistic-1.0-Perl", "Artistic-2.0", "OpenSSL", "SSLeay-standalone", "curl",
  "libpng-2.0", "Libpng", "IJG", "FTL", "HPND", "HPND-sell-variant", "Info-ZIP", "bzip2-1.0.6", "W3C",
  "W3C-20150513", "AFL-2.1", "AFL-3.0", "UPL-1.0", "MS-PL", "Ruby", "Vim", "PostgreSQL", "TCL", "Beerware",
  "BSD-1-Clause", "ICU", "JSON", "Unlicense-libtelnet", "Xnet", "ZPL-2.1", "Zend-2.0", "PHP-3.01", "MulanPSL-2.0",
  "AML", "Fair", "Intel", "NTP", "SGI-B-2.0", "Spencer-94", "Spencer-99", "TU-Berlin-2.0", "X11-distribute-modifications-variant",
  "CC-BY-SA-1.0", "OLDAP-2.8", "Sendmail", "SMLNJ", "Multics", "Naumen", "NASA-1.3", "Plexus", "MirOS",
];

const WEAK_COPYLEFT = [
  "LGPL-2.0-only", "LGPL-2.0-or-later", "LGPL-2.1-only", "LGPL-2.1-or-later", "LGPL-3.0-only", "LGPL-3.0-or-later",
  "LGPL-2.0", "LGPL-2.0+", "LGPL-2.1", "LGPL-2.1+", "LGPL-3.0", "LGPL-3.0+", "MPL-1.0", "MPL-1.1", "MPL-2.0",
  "MPL-2.0-no-copyleft-exception", "EPL-1.0", "EPL-2.0", "CDDL-1.0", "CDDL-1.1", "MS-RL", "EUPL-1.1", "EUPL-1.2",
  "CPL-1.0", "IPL-1.0", "APSL-2.0", "OSL-3.0", "CECILL-C", "CECILL-2.1", "LGPLLR", "ErlPL-1.1", "QPL-1.0",
];

const COPYLEFT = [
  "GPL-1.0-only", "GPL-1.0-or-later", "GPL-2.0-only", "GPL-2.0-or-later", "GPL-3.0-only", "GPL-3.0-or-later",
  "GPL-1.0", "GPL-1.0+", "GPL-2.0", "GPL-2.0+", "GPL-3.0", "GPL-3.0+", "AGPL-1.0", "AGPL-1.0-only",
  "AGPL-1.0-or-later", "AGPL-3.0", "AGPL-3.0-only", "AGPL-3.0-or-later", "SSPL-1.0", "OSL-1.0", "OSL-2.0",
  "OSL-2.1", "RPL-1.5", "Sleepycat", "CECILL-2.0",
];

const NON_COMMERCIAL = [
  "CC-BY-NC-1.0", "CC-BY-NC-2.0", "CC-BY-NC-2.5", "CC-BY-NC-3.0", "CC-BY-NC-4.0", "CC-BY-NC-SA-2.0",
  "CC-BY-NC-SA-2.5", "CC-BY-NC-SA-3.0", "CC-BY-NC-SA-4.0", "CC-BY-NC-ND-2.0", "CC-BY-NC-ND-2.5",
  "CC-BY-NC-ND-3.0", "CC-BY-NC-ND-4.0", "PolyForm-Noncommercial-1.0.0", "Elastic-2.0", "BUSL-1.1",
];

/** Exceptions that let code under a GPL be combined with code under another license. */
const LINKING_EXCEPTIONS = new Set([
  "Font-exception-2.0", "Classpath-exception-2.0", "GCC-exception-3.1", "GCC-exception-2.0", "LLVM-exception",
  "Autoconf-exception-3.0", "Bison-exception-2.2", "Libtool-exception", "Qt-LGPL-exception-1.1",
  "Universal-FOSS-exception-1.0", "OpenJDK-assembly-exception-1.0", "u-boot-exception-2.0", "WxWindows-exception-3.1",
]);

const CLASSES = new Map<string, LicenseClass>();
for (const id of PUBLIC_DOMAIN) CLASSES.set(id.toLowerCase(), "public-domain");
for (const id of PERMISSIVE) CLASSES.set(id.toLowerCase(), "permissive");
for (const id of WEAK_COPYLEFT) CLASSES.set(id.toLowerCase(), "weak-copyleft");
for (const id of COPYLEFT) CLASSES.set(id.toLowerCase(), "copyleft");
for (const id of NON_COMMERCIAL) CLASSES.set(id.toLowerCase(), "non-commercial");

const CANONICAL = new Map<string, string>();
for (const id of [...PUBLIC_DOMAIN, ...PERMISSIVE, ...WEAK_COPYLEFT, ...COPYLEFT, ...NON_COMMERCIAL]) {
  CANONICAL.set(id.toLowerCase(), id);
}

const NC_WORDS = /non-?commercial|research[- ]only|\bresearch\b|\bnc\b|-NC-|-NC$/i;

/** One license in an expression, with its exception if it has one. */
export interface LicenseTerm {
  id: string;
  exception?: string;
}

export type Expression =
  | { kind: "term"; term: LicenseTerm }
  | { kind: "and" | "or"; left: Expression; right: Expression };

export class ExpressionError extends Error {}

function tokenize(text: string): string[] {
  return text.match(/\(|\)|[^\s()]+/g) ?? [];
}

/** Parses an SPDX expression. OR binds weaker than AND; WITH binds tightest. Operators are case-insensitive. */
export function parseExpression(text: string): Expression {
  const tokens = tokenize(text.trim());
  if (tokens.length === 0) throw new ExpressionError("empty expression");
  let pos = 0;
  const peek = () => tokens[pos];
  const isOp = (t: string | undefined, op: string) => t !== undefined && t.toUpperCase() === op;

  function primary(): Expression {
    const t = tokens[pos++];
    if (t === undefined) throw new ExpressionError(`unexpected end: ${text}`);
    if (t === "(") {
      const inner = orExpr();
      if (tokens[pos++] !== ")") throw new ExpressionError(`missing ): ${text}`);
      return inner;
    }
    if (t === ")" || isOp(t, "AND") || isOp(t, "OR") || isOp(t, "WITH")) throw new ExpressionError(`unexpected ${t}: ${text}`);
    const term: LicenseTerm = { id: t };
    if (isOp(peek(), "WITH")) {
      pos++;
      const ex = tokens[pos++];
      if (ex === undefined || ex === "(" || ex === ")") throw new ExpressionError(`missing exception: ${text}`);
      term.exception = ex;
    }
    return { kind: "term", term };
  }
  function andExpr(): Expression {
    let left = primary();
    while (isOp(peek(), "AND")) {
      pos++;
      left = { kind: "and", left, right: primary() };
    }
    return left;
  }
  function orExpr(): Expression {
    let left = andExpr();
    while (isOp(peek(), "OR")) {
      pos++;
      left = { kind: "or", left, right: andExpr() };
    }
    return left;
  }
  const result = orExpr();
  if (pos !== tokens.length) throw new ExpressionError(`unexpected ${tokens[pos]}: ${text}`);
  return result;
}

/** The expression in disjunctive normal form: a list of choices, each a list of terms that all apply. */
export function choices(expr: Expression): LicenseTerm[][] {
  if (expr.kind === "term") return [[expr.term]];
  const l = choices(expr.left);
  const r = choices(expr.right);
  if (expr.kind === "or") return [...l, ...r];
  const out: LicenseTerm[][] = [];
  for (const a of l) for (const b of r) out.push([...a, ...b]);
  return out;
}

export function canonicalId(id: string): string {
  return CANONICAL.get(id.toLowerCase()) ?? id;
}

export function classOfTerm(term: LicenseTerm): LicenseClass {
  const id = term.id;
  if (/^LicenseRef-Memex/i.test(id)) return "first-party";
  if (/^LicenseRef-Public-Domain/i.test(id)) return "public-domain";
  const base = id.endsWith("+") ? id.slice(0, -1) : id;
  let cls = CLASSES.get(id.toLowerCase()) ?? CLASSES.get(base.toLowerCase());
  if (cls === undefined && /^(LicenseRef|DocumentRef)-/i.test(id)) cls = NC_WORDS.test(id) ? "non-commercial" : "custom";
  if (cls === undefined) return "unknown";
  if (cls === "copyleft" && term.exception !== undefined && LINKING_EXCEPTIONS.has(term.exception)) return "weak-copyleft";
  return cls;
}

const RANK: Record<LicenseClass, number> = {
  "public-domain": 0,
  "first-party": 0,
  permissive: 1,
  "weak-copyleft": 2,
  custom: 3,
  copyleft: 4,
  "non-commercial": 5,
  unknown: 6,
};

export interface Classified {
  /** The expression as written, trimmed. */
  expression: string;
  /** The choice the check uses: the least restrictive one. */
  chosen: LicenseTerm[];
  /** The most restrictive class within the chosen terms. */
  class: LicenseClass;
  /** Ids in the chosen terms that the list does not know. */
  unknownIds: string[];
  /** True when the chosen terms ask for credit or for the license text to go with the work. */
  needsCredit: boolean;
  parseError?: string;
}

function worst(terms: LicenseTerm[]): LicenseClass {
  let w: LicenseClass = terms[0] === undefined ? "unknown" : classOfTerm(terms[0]);
  for (const t of terms) {
    const c = classOfTerm(t);
    if (RANK[c] > RANK[w]) w = c;
  }
  return w;
}

/** Normalizes the common non-SPDX spellings found in package metadata. */
export function normalizeDeclared(text: string): string {
  let t = text.trim();
  if (/^\(.*\)$/.test(t) && !/\).*\(/.test(t)) t = t.slice(1, -1).trim();
  const aliases: Record<string, string> = {
    "apache 2.0": "Apache-2.0",
    "apache-2": "Apache-2.0",
    "apache 2": "Apache-2.0",
    "apache license 2.0": "Apache-2.0",
    "apache license, version 2.0": "Apache-2.0",
    "mit license": "MIT",
    "the mit license": "MIT",
    "bsd": "BSD-3-Clause",
    "new bsd": "BSD-3-Clause",
    "simplified bsd": "BSD-2-Clause",
    "public domain": "LicenseRef-Public-Domain",
    "gplv2": "GPL-2.0-only",
    "gplv3": "GPL-3.0-only",
    "lgplv3": "LGPL-3.0-only",
  };
  return aliases[t.toLowerCase()] ?? t;
}

export function classify(text: string): Classified {
  const expression = normalizeDeclared(text);
  let parsed: Expression;
  try {
    parsed = parseExpression(expression);
  } catch (error) {
    return {
      expression,
      chosen: [],
      class: "unknown",
      unknownIds: [expression],
      needsCredit: true,
      parseError: error instanceof Error ? error.message : String(error),
    };
  }
  const all = choices(parsed);
  let best = all[0]!;
  for (const c of all) if (RANK[worst(c)] < RANK[worst(best)]) best = c;
  const cls = worst(best);
  const unknownIds = best.filter((t) => classOfTerm(t) === "unknown").map((t) => t.id);
  const needsCredit = best.some((t) => {
    const c = classOfTerm(t);
    return c !== "public-domain" && c !== "first-party";
  });
  return { expression, chosen: best, class: cls, unknownIds, needsCredit };
}

/** The license words that mean "we do not know". */
export function isUnknownDeclaration(text: string | null | undefined): boolean {
  if (text === null || text === undefined) return true;
  const t = text.trim().toLowerCase();
  return t === "" || t === "unknown" || t === "noassertion" || t === "none" || t === "unlicensed" || t.startsWith("see license in");
}
