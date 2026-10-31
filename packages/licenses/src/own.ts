// The repository's own license by its group: MIT for libraries, contracts and clients, AGPL-3.0-or-later for apps,
// services and headless tools, GPL-3.0-or-later for Studio's ComfyUI nodes. The LICENSE file and the license fields
// of the package manifests must name the license of the repository's group.
import fs from "node:fs";
import path from "node:path";
import { identifyLicenseText } from "./textid.js";

/** The licenses a Memex repository may have, one per group. */
export const OWN_LICENSES = ["MIT", "AGPL-3.0-or-later", "GPL-3.0-or-later"] as const;
export type OwnLicense = (typeof OWN_LICENSES)[number];

const LICENSE_FILES = ["LICENSE", "LICENSE.md", "LICENSE.txt", "COPYING"];

export interface OwnLicenseProblem {
  file: string;
  detail: string;
}

export interface OwnLicenseResult {
  ok: boolean;
  expected: OwnLicense;
  /** The license file that was read, relative to the repository, or null when there is none. */
  licenseFile: string | null;
  /** What the license file's text is, as an SPDX id (the GNU texts read as -only: the text does not say "or later"). */
  licenseText: string | null;
  /** The manifests that were read, with the license they declare. */
  manifests: { file: string; license: string | null }[];
  problems: OwnLicenseProblem[];
}

/** The license family without -only or -or-later, so a GNU text can be compared with the declared id. */
function family(id: string): string {
  return id.replace(/-(?:only|or-later)$/, "");
}

function readManifests(root: string): { file: string; license: string | null }[] {
  const found: { file: string; license: string | null }[] = [];
  const pkg = path.join(root, "package.json");
  if (fs.existsSync(pkg)) {
    const json = JSON.parse(fs.readFileSync(pkg, "utf8")) as { license?: unknown };
    found.push({ file: "package.json", license: typeof json.license === "string" ? json.license : null });
  }
  const pyproject = path.join(root, "pyproject.toml");
  if (fs.existsSync(pyproject)) {
    const m = /^\s*license\s*=\s*(?:"([^"]*)"|\{\s*text\s*=\s*"([^"]*)"\s*\})/m.exec(fs.readFileSync(pyproject, "utf8"));
    found.push({ file: "pyproject.toml", license: m ? (m[1] ?? m[2] ?? null) : null });
  }
  const props = path.join(root, "Directory.Build.props");
  if (fs.existsSync(props)) {
    const m = /<PackageLicenseExpression>([^<]*)<\/PackageLicenseExpression>/.exec(fs.readFileSync(props, "utf8"));
    if (m) found.push({ file: "Directory.Build.props", license: m[1]?.trim() ?? null });
  }
  return found;
}

export function checkOwnLicense(root: string, expected: OwnLicense): OwnLicenseResult {
  const problems: OwnLicenseProblem[] = [];
  const licenseFile = LICENSE_FILES.find((f) => fs.existsSync(path.join(root, f))) ?? null;
  let licenseText: string | null = null;
  if (licenseFile === null) {
    problems.push({ file: "LICENSE", detail: `no license file; the repository's license is ${expected}` });
  } else {
    licenseText = identifyLicenseText(fs.readFileSync(path.join(root, licenseFile), "utf8"));
    if (licenseText === null) problems.push({ file: licenseFile, detail: `not a license text this check knows; expected the ${expected} text` });
    else if (family(licenseText) !== family(expected)) problems.push({ file: licenseFile, detail: `holds the ${licenseText} text; expected ${expected}` });
  }
  const manifests = readManifests(root);
  for (const m of manifests) {
    if (m.license !== expected) problems.push({ file: m.file, detail: `declares ${m.license ?? "no license"}; expected ${expected}` });
  }
  return { ok: problems.length === 0, expected, licenseFile, licenseText, manifests, problems };
}
