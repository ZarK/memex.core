import fs from "node:fs";
import path from "node:path";
import { isDir, isFile, licenseFileFromPath, licenseFilesIn, licenseText, readJson, readText } from "./files.js";
import { copyrightLines, fromReading, readLicenseText } from "./textid.js";
import type { Component, InventoryNote, LicenseFile } from "./types.js";

interface AssetsFile {
  version?: number;
  targets?: Record<string, Record<string, TargetEntry>>;
  libraries?: Record<string, { type?: string; path?: string; files?: string[] }>;
  packageFolders?: Record<string, unknown>;
  project?: {
    restore?: { projectName?: string; projectPath?: string };
    frameworks?: Record<string, {
      dependencies?: Record<string, { include?: string; exclude?: string; suppressParent?: string }>;
      frameworkReferences?: Record<string, unknown>;
    }>;
  };
}

interface TargetEntry {
  type?: string;
  runtime?: Record<string, unknown>;
  native?: Record<string, unknown>;
  runtimeTargets?: Record<string, unknown>;
  resource?: Record<string, unknown>;
  contentFiles?: Record<string, unknown>;
}

const TEST_PACKAGES = /^(microsoft\.net\.test\.sdk|xunit(\..+)?|nunit(\..+)?|mstest(\..+)?|mstest\.testframework)$/i;

export interface DotnetProject {
  assetsFile: string;
  project: string;
  test: boolean;
  packages: Component[];
  frameworks: string[];
  targetFrameworks: string[];
  dotnetRoot: string | null;
}

function realFiles(group: Record<string, unknown> | undefined): boolean {
  if (group === undefined) return false;
  return Object.keys(group).some((f) => !f.endsWith("/_._") && f !== "_._");
}

function tag(xml: string, name: string): string | undefined {
  const m = new RegExp(`<${name}(\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i").exec(xml);
  return m ? decodeXml(m[2]!.trim()) : undefined;
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&");
}

interface NuspecFacts {
  license: string | null;
  licenseFrom: string;
  licenseFiles: LicenseFile[];
  copyright: string[];
  homepage?: string;
  authors?: string;
  customTerms?: string;
}

/** Reads the license facts of an extracted NuGet package folder. */
export function readNuspec(pkgDir: string, id: string, files: string[] = []): NuspecFacts {
  const facts: NuspecFacts = { license: null, licenseFrom: "nuspec", licenseFiles: licenseFilesIn(pkgDir), copyright: [] };
  const nuspecName = files.find((f) => f.toLowerCase().endsWith(".nuspec")) ?? `${id.toLowerCase()}.nuspec`;
  const nuspecPath = path.join(pkgDir, nuspecName);
  if (!isFile(nuspecPath)) {
    facts.licenseFrom = "nuspec missing";
    return facts;
  }
  const xml = readText(nuspecPath);
  const lic = /<license\s+type="(expression|file)"[^>]*>([\s\S]*?)<\/license>/i.exec(xml);
  const licenseUrl = tag(xml, "licenseUrl");
  if (lic !== null && lic[1]!.toLowerCase() === "expression") {
    facts.license = decodeXml(lic[2]!.trim());
  } else if (lic !== null) {
    const rel = decodeXml(lic[2]!.trim()).replace(/\\/g, "/");
    const file = path.join(pkgDir, ...rel.split("/"));
    if (isFile(file)) {
      const lf = facts.licenseFiles.find((f) => f.path === file) ?? licenseFileFromPath(file, path.basename(rel));
      if (!facts.licenseFiles.includes(lf)) facts.licenseFiles.push(lf);
      ({ license: facts.license, licenseFrom: facts.licenseFrom, customTerms: facts.customTerms } = fromReading(readLicenseText(readText(file), { named: true }), lf.sha256, "nuspec license file"));
    } else facts.licenseFrom = "nuspec license file missing";
  } else if (licenseUrl !== undefined) {
    const m = /^https?:\/\/licenses\.nuget\.org\/(.+)$/i.exec(licenseUrl);
    if (m) facts.license = decodeURIComponent(m[1]!);
    else {
      facts.licenseFrom = `nuspec licenseUrl ${licenseUrl}`;
      const known: [RegExp, string][] = [
        [/opensource\.org\/licenses\/mit/i, "MIT"],
        [/apache\.org\/licenses\/LICENSE-2\.0/i, "Apache-2.0"],
        [/dotnet\.microsoft\.com\/.*license|go\.microsoft\.com\/fwlink\/\?LinkId=329770/i, "LicenseRef-MS-NET-Library"],
      ];
      for (const [re, id2] of known) if (re.test(licenseUrl)) facts.license = id2;
    }
  }
  if (facts.license === null) {
    for (const f of facts.licenseFiles) {
      const reading = readLicenseText(licenseText(f));
      if (reading.id !== null) {
        ({ license: facts.license, licenseFrom: facts.licenseFrom, customTerms: facts.customTerms } = fromReading(reading, f.sha256, `license text (${f.name})`));
        break;
      }
    }
  }
  const copyright = tag(xml, "copyright");
  if (copyright) facts.copyright.push(copyright);
  for (const f of facts.licenseFiles) for (const line of copyrightLines(licenseText(f))) if (!facts.copyright.includes(line)) facts.copyright.push(line);
  facts.homepage = tag(xml, "projectUrl");
  facts.authors = tag(xml, "authors");
  return facts;
}

function findDotnetRoot(assets: AssetsFile): string | null {
  const candidates: string[] = [];
  const graph = (Object.values(assets.project?.frameworks ?? {})[0] as { runtimeIdentifierGraphPath?: string } | undefined)?.runtimeIdentifierGraphPath;
  if (typeof graph === "string") candidates.push(path.resolve(path.dirname(graph), "..", ".."));
  if (process.env.DOTNET_ROOT) candidates.push(process.env.DOTNET_ROOT);
  if (process.env.ProgramFiles) candidates.push(path.join(process.env.ProgramFiles, "dotnet"));
  candidates.push("/usr/share/dotnet", "/usr/local/share/dotnet", "/usr/lib/dotnet");
  for (const c of candidates) if (isDir(path.join(c, "shared"))) return c;
  return null;
}

function newestShared(root: string, framework: string, major: string | null): string | null {
  let versions: string[];
  try {
    versions = fs.readdirSync(path.join(root, "shared", framework));
  } catch {
    return null;
  }
  const fit = versions.filter((v) => major === null || v.split(".")[0] === major);
  fit.sort((a, b) => {
    const pa = a.split(/[.-]/).map((x) => Number(x) || 0);
    const pb = b.split(/[.-]/).map((x) => Number(x) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
    return 0;
  });
  return fit.at(-1) ?? null;
}

/** Reads one obj/project.assets.json: the NuGet packages that put files in the build output. */
export function readAssetsFile(file: string, root: string, notes: InventoryNote[]): DotnetProject {
  const assets = readJson(file) as AssetsFile;
  if (assets.version !== 3 && assets.version !== 4) {
    notes.push({ source: file, message: `project.assets.json version ${String(assets.version)} is not one this tool knows (3 or 4); read as 3` });
  }
  const project = assets.project?.restore?.projectName ?? path.basename(path.dirname(path.dirname(file)));
  const frameworks = assets.project?.frameworks ?? {};
  const directDeps = new Map<string, { include?: string; exclude?: string }>();
  const frameworkRefs = new Set<string>();
  for (const fw of Object.values(frameworks)) {
    for (const [name, d] of Object.entries(fw.dependencies ?? {})) directDeps.set(name.toLowerCase(), d);
    for (const name of Object.keys(fw.frameworkReferences ?? {})) frameworkRefs.add(name);
  }
  const test = [...directDeps.keys()].some((n) => TEST_PACKAGES.test(n)) || /\.(tests?|testhost|specs|benchmarks?)$/i.test(project);
  const folders = Object.keys(assets.packageFolders ?? {});
  const packages = new Map<string, Component>();
  const via = `dotnet:${path.relative(root, path.dirname(path.dirname(file))).split(path.sep).join("/") || "."}`;
  for (const [, entries] of Object.entries(assets.targets ?? {})) {
    for (const [libKey, entry] of Object.entries(entries)) {
      if (entry.type !== "package") continue;
      const slash = libKey.lastIndexOf("/");
      const id = libKey.slice(0, slash);
      const version = libKey.slice(slash + 1);
      const direct = directDeps.get(id.toLowerCase());
      const include = (direct?.include ?? "All").toLowerCase();
      const exclude = (direct?.exclude ?? "None").toLowerCase();
      const runtimeIncluded = (include.includes("all") || include.includes("runtime") || include.includes("native")) && !exclude.includes("all") && !(exclude.includes("runtime") && exclude.includes("native"));
      const ships = realFiles(entry.runtime) || realFiles(entry.native) || realFiles(entry.runtimeTargets) || realFiles(entry.resource) || realFiles(entry.contentFiles);
      if (!ships || !runtimeIncluded) continue;
      if (packages.has(libKey)) continue;
      const lib = assets.libraries?.[libKey];
      const rel = lib?.path ?? `${id.toLowerCase()}/${version.toLowerCase()}`;
      const pkgDir = folders.map((f) => path.join(f, rel)).find(isDir) ?? null;
      const facts: NuspecFacts = pkgDir === null
        ? { license: null, licenseFrom: "package not in the NuGet folders (run dotnet restore)", licenseFiles: [], copyright: [] }
        : readNuspec(pkgDir, id, lib?.files ?? []);
      packages.set(libKey, {
        key: `nuget:${id}@${version}`,
        ecosystem: "nuget",
        name: id,
        version,
        license: facts.license,
        licenseFrom: facts.licenseFrom,
        licenseFiles: facts.licenseFiles,
        copyright: facts.copyright,
        homepage: facts.homepage ?? `https://www.nuget.org/packages/${id}/${version}`,
        authors: facts.authors,
        customTerms: facts.customTerms,
        delivery: "bundled",
        via: [via],
        missing: pkgDir === null,
      });
    }
  }
  const targetFrameworks = Object.keys(frameworks);
  return {
    assetsFile: file,
    project,
    test,
    packages: [...packages.values()],
    frameworks: [...frameworkRefs],
    targetFrameworks,
    dotnetRoot: frameworkRefs.size > 0 ? findDotnetRoot(assets) : null,
  };
}

/** The .NET runtime and ASP.NET Core as components, with the license and notices of the installed SDK. */
export function dotnetRuntimeComponents(projects: DotnetProject[], notes: InventoryNote[]): Component[] {
  const out = new Map<string, Component>();
  for (const p of projects) {
    if (p.test) continue;
    const major = /net(\d+)\./.exec(p.targetFrameworks[0] ?? "")?.[1] ?? null;
    const names = new Set(["Microsoft.NETCore.App", ...p.frameworks]);
    for (const name of names) {
      const version = p.dotnetRoot === null ? null : newestShared(p.dotnetRoot, name, major);
      const key = `dotnet:${name}@${version ?? `${major ?? "?"}.x`}`;
      const existing = out.get(key);
      if (existing) {
        if (!existing.via.includes(`dotnet:${p.project}`)) existing.via.push(`dotnet:${p.project}`);
        continue;
      }
      const files: LicenseFile[] = [];
      if (p.dotnetRoot !== null) {
        for (const f of ["LICENSE.txt", "ThirdPartyNotices.txt"]) {
          const full = path.join(p.dotnetRoot, f);
          if (isFile(full)) files.push(licenseFileFromPath(full));
        }
      } else notes.push({ source: p.assetsFile, message: "the .NET install was not found, so the runtime license texts are missing" });
      out.set(key, {
        key,
        ecosystem: "dotnet",
        name,
        version: version ?? `${major ?? "?"}.x`,
        license: "MIT",
        licenseFrom: "the .NET install",
        licenseFiles: files,
        copyright: ["Copyright (c) .NET Foundation and Contributors"],
        homepage: "https://github.com/dotnet/runtime",
        delivery: "bundled",
        via: [`dotnet:${p.project}`],
        note: "Ships in a self-contained build.",
      });
    }
  }
  return [...out.values()];
}
