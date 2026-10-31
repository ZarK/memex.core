import path from "node:path";
import { isFile, licenseFileFromPath, licenseFilesIn, licenseText, readText, tryReadJson } from "./files.js";
import { copyrightLines, fromReading, readLicenseText } from "./textid.js";
import type { Component, LicenseFile } from "./types.js";

interface PackageJson {
  name?: unknown;
  version?: unknown;
  license?: unknown;
  licenses?: unknown;
  homepage?: unknown;
  repository?: unknown;
  author?: unknown;
}

function declaredLicense(pkg: PackageJson): string | null {
  const one = (v: unknown): string | null => {
    if (typeof v === "string") return v;
    if (v !== null && typeof v === "object" && typeof (v as { type?: unknown }).type === "string") return (v as { type: string }).type;
    return null;
  };
  const direct = one(pkg.license);
  if (direct !== null) return direct;
  if (Array.isArray(pkg.licenses)) {
    const all = pkg.licenses.map(one).filter((x): x is string => x !== null);
    if (all.length === 1) return all[0]!;
    if (all.length > 1) return `(${all.join(" OR ")})`;
  }
  return one(pkg.licenses);
}

function homepageOf(pkg: PackageJson): string | undefined {
  if (typeof pkg.homepage === "string") return pkg.homepage;
  const repo = pkg.repository;
  const url = typeof repo === "string" ? repo : repo !== null && typeof repo === "object" ? (repo as { url?: unknown }).url : undefined;
  if (typeof url !== "string") return undefined;
  if (/^github:/.test(url)) return `https://github.com/${url.slice(7)}`;
  if (/^[\w.-]+\/[\w.-]+$/.test(url)) return `https://github.com/${url}`;
  return url.replace(/^git\+/, "").replace(/^git:\/\//, "https://").replace(/^ssh:\/\/git@/, "https://").replace(/\.git$/, "");
}

export interface NpmPackageInfo {
  name: string;
  version: string;
  license: string | null;
  licenseFrom: string;
  licenseFiles: LicenseFile[];
  copyright: string[];
  homepage?: string;
  author?: string;
  customTerms?: string;
}

/** Reads the license facts of an installed npm package folder. */
export function readNpmPackage(dir: string): NpmPackageInfo | null {
  const pkg = tryReadJson(path.join(dir, "package.json")) as PackageJson | undefined;
  if (pkg === undefined || pkg === null || typeof pkg !== "object") return null;
  const name = typeof pkg.name === "string" ? pkg.name : path.basename(dir);
  const version = typeof pkg.version === "string" ? pkg.version : "0.0.0";
  let license = declaredLicense(pkg);
  let licenseFrom = "package.json";
  let customTerms: string | undefined;
  const files = licenseFilesIn(dir);
  const seeFile = license !== null ? /^see licen[cs]e in (.+)$/i.exec(license.trim()) : null;
  if (seeFile !== null) {
    const target = path.resolve(dir, seeFile[1]!.trim());
    const inside = !path.relative(dir, target).startsWith("..") && !path.isAbsolute(path.relative(dir, target));
    if (inside && isFile(target)) {
      const file = files.find((f) => f.path === target) ?? licenseFileFromPath(target);
      if (!files.includes(file)) files.push(file);
      const reading = readLicenseText(readText(target), { named: true });
      ({ license, licenseFrom, customTerms } = fromReading(reading, file.sha256, "license file"));
    } else {
      license = null;
      licenseFrom = "package.json (SEE LICENSE IN, file missing)";
    }
  }
  if (license === null || license.trim() === "") {
    for (const f of files) {
      const reading = readLicenseText(licenseText(f));
      if (reading.id !== null) {
        ({ license, licenseFrom, customTerms } = fromReading(reading, f.sha256, `license text (${f.name})`));
        break;
      }
    }
  }
  const copyright: string[] = [];
  for (const f of files) for (const line of copyrightLines(licenseText(f))) if (!copyright.includes(line)) copyright.push(line);
  const author = typeof pkg.author === "string" ? pkg.author : typeof (pkg.author as { name?: unknown } | null)?.name === "string" ? (pkg.author as { name: string }).name : undefined;
  return { name, version, license, licenseFrom, licenseFiles: files, copyright, homepage: homepageOf(pkg), author, customTerms };
}

export function npmComponent(info: NpmPackageInfo, via: string, ecosystem: "npm" | "vite" = "npm"): Component {
  return {
    key: `${ecosystem}:${info.name}@${info.version}`,
    ecosystem,
    name: info.name,
    version: info.version,
    license: info.license,
    licenseFrom: info.licenseFrom,
    licenseFiles: info.licenseFiles,
    copyright: info.copyright,
    homepage: info.homepage,
    authors: info.author,
    customTerms: info.customTerms,
    delivery: "bundled",
    via: [via],
  };
}
