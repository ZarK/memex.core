import fs from "node:fs";
import path from "node:path";
import type { Config } from "./config.js";
import { dotnetRuntimeComponents, readAssetsFile, type DotnetProject } from "./dotnet.js";
import { electronComponent } from "./electron.js";
import { isDir, isFile, licenseFileFromPath, licenseFileFromText, licenseFilesIn, licenseText, rel, sha256, tryReadJson, walkFiles } from "./files.js";
import { canonicalId, classify } from "./spdx.js";
import { standardLicenseText } from "./texts.js";
import { FONT_FILE, fontLicenseId, readFontNames, type FontNames } from "./fonts.js";
import { readNpmPackage, npmComponent } from "./npm.js";
import { packComponent, readPack, type PackManifest } from "./packs.js";
import { closure, readLockfile, resolveFrom } from "./pnpm.js";
import { copyrightLines, fromReading, readLicenseText } from "./textid.js";
import { readThirdParty, thirdPartyComponents } from "./thirdparty.js";
import type { Component, Inventory, InventoryNote, LicenseFile } from "./types.js";
import { readViteBuild } from "./vite.js";

/** Folders that the repository walk never enters, besides every hidden folder. */
export const SKIP_DIRS = new Set([
  "node_modules", ".git", ".pnpm-store", "bin", "obj", ".cache", "coverage", "release", "out", "test", "tests",
  "testdata", "fixtures", "__tests__", "docs", "design", "scripts", ".github", ".vscode", ".idea", ".venv", "venv",
  "__pycache__", "target", ".next", ".turbo",
]);

const VENDOR_DIRS = new Set(["vendor", "_vendor", "third_party", "third-party", "thirdparty"]);

export interface InventoryOptions {
  root: string;
  config: Config;
  /** Command-line additions; they replace the config lists they name. */
  vite?: string[];
  dotnet?: string[];
  electronDist?: string;
  electronZip?: string;
  thirdParty?: string[];
  packs?: string[];
  importers?: string[];
  product?: string;
}

interface Walked {
  csproj: string[];
  fonts: string[];
  vendorDirs: string[];
  thirdParty: string[];
  packs: string[];
  dists: string[];
}

function walkRepo(root: string, ignore: string[]): Walked {
  const ignored = new Set(ignore.map((p) => path.resolve(root, p)));
  const w: Walked = { csproj: [], fonts: [], vendorDirs: [], thirdParty: [], packs: [], dists: [] };
  const files = walkFiles(root, {
    skipDir: (name, full) => {
      if (SKIP_DIRS.has(name) || name.startsWith(".") || ignored.has(full)) return true;
      if (VENDOR_DIRS.has(name)) w.vendorDirs.push(full);
      if (name === "dist" && isFile(path.join(full, "index.html")) && isDir(path.join(full, "assets"))) w.dists.push(full);
      return false;
    },
  });
  for (const f of files) {
    const base = path.basename(f);
    if (base.endsWith(".csproj")) w.csproj.push(f);
    else if (FONT_FILE.test(base)) w.fonts.push(f);
    else if (base === "third-party.json") w.thirdParty.push(f);
    else if (base === "memex.pack.json" || base.endsWith(".pack.json")) w.packs.push(f);
  }
  return w;
}

class Collector {
  readonly byKey = new Map<string, Component>();
  add(c: Component): Component {
    const prev = this.byKey.get(c.key);
    if (prev === undefined) {
      this.byKey.set(c.key, c);
      return c;
    }
    for (const v of c.via) if (!prev.via.includes(v)) prev.via.push(v);
    if (prev.missingOptional && !c.missingOptional) {
      this.byKey.set(c.key, { ...c, via: prev.via });
      return this.byKey.get(c.key)!;
    }
    return prev;
  }
}

function fontFilesUnder(dir: string, out: Map<string, string>, depth = 0): void {
  if (depth > 4) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory() && e.name !== "node_modules") fontFilesUnder(path.join(dir, e.name), out, depth + 1);
    else if (e.isFile() && FONT_FILE.test(e.name)) out.set(e.name.toLowerCase(), dir);
  }
}

/** A Vite asset name without its content hash: `inter-latin-wght-normal-Dx3k_a9Q.woff2` is `inter-latin-wght-normal.woff2`. */
export function unhashedName(name: string): string {
  return name.replace(/-[A-Za-z0-9_-]{8}(\.[a-z0-9]+)$/i, "$1").toLowerCase();
}

function versionOfFont(names: FontNames): string {
  const m = /(\d+(\.\d+)+)/.exec(names.version ?? "");
  return m ? m[1]! : "";
}

interface PackageLockEntry {
  name?: unknown;
  version?: unknown;
  license?: unknown;
  dev?: unknown;
  optional?: unknown;
  devOptional?: unknown;
  link?: unknown;
}

/** The packages map of an npm package-lock.json (lockfile 2 or 3), or null with a note when it cannot be read. */
function readPackageLock(file: string, notes: InventoryNote[]): Map<string, PackageLockEntry> | null {
  const lock = tryReadJson(file) as { lockfileVersion?: unknown; packages?: unknown } | undefined;
  if (lock === undefined || lock === null || typeof lock !== "object") {
    notes.push({ source: "package-lock.json", message: "unreadable" });
    return null;
  }
  if ((lock.lockfileVersion !== 2 && lock.lockfileVersion !== 3) || lock.packages === null || typeof lock.packages !== "object") {
    notes.push({ source: "package-lock.json", message: `lockfile version ${String(lock.lockfileVersion)} is not read (2 or 3)` });
    return null;
  }
  return new Map(Object.entries(lock.packages as Record<string, PackageLockEntry>));
}

/** A platform package name: the main package name, then the OS, the CPU and maybe an ABI. */
const PLATFORM =
  "(?:linux|darwin|win32|android|freebsd|openbsd|netbsd|sunos|aix)-(?:x64|arm64|arm|ia32|riscv64|s390x|ppc64|loong64|universal)(?:-(?:gnu|musl|msvc|gnueabihf|musleabihf|eabi))?";
const PLATFORM_PACKAGE = new RegExp(`^(.+?)-${PLATFORM}$`);
/** A scoped platform package: @esbuild/linux-x64, @rolldown/binding-linux-x64-gnu. Its main package is the scope. */
const SCOPED_PLATFORM_PACKAGE = new RegExp(`^@([^/]+)/(?:[^/]+-)?${PLATFORM}$`);

/** The names of the main package of a platform package, most likely first. */
function mainPackageNames(name: string): string[] {
  const names: string[] = [];
  const prefix = PLATFORM_PACKAGE.exec(name)?.[1];
  if (prefix !== undefined && !prefix.endsWith("/")) names.push(prefix);
  const scope = SCOPED_PLATFORM_PACKAGE.exec(name)?.[1];
  if (scope !== undefined) names.push(scope);
  return names;
}

/** Reads the repository and returns every third-party component it ships, downloads or names. */
export function buildInventory(options: InventoryOptions): Inventory {
  const root = path.resolve(options.root);
  const cfg = options.config;
  const notes: InventoryNote[] = [];
  const sources: string[] = [];
  const col = new Collector();
  const resolveAll = (list: string[]) => list.map((p) => path.resolve(root, p));
  const walked = walkRepo(root, cfg.ignore ?? []);
  const rootPkg = tryReadJson(path.join(root, "package.json")) as { name?: unknown } | undefined;
  const product = options.product ?? cfg.product ?? (typeof rootPkg?.name === "string" ? rootPkg.name : path.basename(root));

  // pnpm lockfile and node_modules
  const lockPath = path.join(root, "pnpm-lock.yaml");
  let electronFound: { version: string; dir: string | null; importerDir: string } | null = null;
  const npmDirs = new Map<string, string>();
  if (cfg.pnpm !== false && isFile(lockPath)) {
    const lock = readLockfile(lockPath);
    const importers = options.importers ?? (cfg.pnpm ? cfg.pnpm.importers : undefined) ?? [...lock.importers.keys()];
    for (const imp of importers) if (!lock.importers.has(imp)) notes.push({ source: "pnpm-lock.yaml", message: `importer ${imp} is not in the lockfile` });
    const result = closure(root, lock, { importers, dev: cfg.pnpm ? cfg.pnpm.dev === true : false, stop: new Set(["electron"]) });
    sources.push(`pnpm-lock.yaml (lockfile ${lock.version}; importers ${importers.join(", ")})`);
    for (const pkg of result.packages.values()) {
      const via = `pnpm:${[...pkg.importers].sort().join(",")}`;
      if (pkg.dir === null) {
        col.add({
          key: `npm:${pkg.name}@${pkg.version}`,
          ecosystem: "npm",
          name: pkg.name,
          version: pkg.version,
          license: null,
          licenseFrom: "not installed",
          licenseFiles: [],
          copyright: [],
          delivery: "bundled",
          via: [via],
          missing: !pkg.optional,
          missingOptional: pkg.optional,
        });
        continue;
      }
      const info = readNpmPackage(pkg.dir);
      if (info === null) {
        notes.push({ source: via, message: `${pkg.name}@${pkg.version}: package.json unreadable in ${pkg.dir}` });
        continue;
      }
      npmDirs.set(`npm:${info.name}@${info.version}`, pkg.dir);
      col.add(npmComponent(info, via));
    }
    for (const l of result.linked) notes.push({ source: "pnpm-lock.yaml", message: `local package ${l} is linked but is not a workspace importer; it is not read` });
    const e = result.stopped.get("electron");
    if (e !== undefined) electronFound = e;
  } else if (cfg.pnpm !== false && isFile(path.join(root, "package-lock.json"))) {
    // npm's package-lock.json (lockfile 2 or 3) and node_modules.
    const dev = cfg.pnpm ? cfg.pnpm.dev === true : false;
    const packages = readPackageLock(path.join(root, "package-lock.json"), notes);
    if (packages !== null) {
      let count = 0;
      for (const [key, entry] of packages) {
        // The root and workspace folders are the product itself; a link is read where it lives.
        if (!key.startsWith("node_modules/") && !key.includes("/node_modules/")) continue;
        if (entry.link === true) continue;
        if (entry.dev === true && !dev) continue;
        const name = typeof entry.name === "string" ? entry.name : key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length);
        const version = typeof entry.version === "string" ? entry.version : "";
        const dir = path.join(root, ...key.split("/"));
        count += 1;
        if (!isFile(path.join(dir, "package.json"))) {
          const optional = entry.optional === true || entry.devOptional === true;
          col.add({
            key: `npm:${name}@${version}`,
            ecosystem: "npm",
            name,
            version,
            license: typeof entry.license === "string" ? entry.license : null,
            licenseFrom: "not installed",
            licenseFiles: [],
            copyright: [],
            delivery: "bundled",
            via: ["npm:package-lock.json"],
            missing: !optional,
            missingOptional: optional,
          });
          continue;
        }
        const info = readNpmPackage(dir);
        if (info === null) {
          notes.push({ source: "package-lock.json", message: `${name}@${version}: package.json unreadable in ${dir}` });
          continue;
        }
        npmDirs.set(`npm:${info.name}@${info.version}`, dir);
        col.add(npmComponent(info, "npm:package-lock.json"));
      }
      sources.push(`package-lock.json (${count} package${count === 1 ? "" : "s"}${dev ? " with dev dependencies" : ", no dev dependencies"})`);
    }
  } else if (cfg.pnpm !== false && isFile(path.join(root, "yarn.lock"))) {
    notes.push({ source: root, message: "no pnpm-lock.yaml or package-lock.json: yarn lockfiles are not read" });
  }

  // Vite builds
  const viteDirs = options.vite !== undefined ? resolveAll(options.vite) : cfg.vite !== undefined ? resolveAll(cfg.vite) : walked.dists;
  for (const dir of viteDirs) {
    const build = readViteBuild(dir);
    const label = `vite:${rel(root, dir)}`;
    if (!isDir(dir)) {
      notes.push({ source: label, message: "the build folder does not exist; build first" });
      continue;
    }
    if (build.from === "none") {
      notes.push({ source: label, message: "no source maps and no .vite/memex-licenses.json: the packages are the lockfile closure, and dev dependencies that Vite bundles are not listed" });
      sources.push(`${label} (no module list)`);
      continue;
    }
    sources.push(`${label} (${build.from === "plugin" ? "plugin module list" : `${build.maps} source maps`}, ${build.packages.size} packages)`);
    for (const p of build.packages.values()) {
      if (p.dir === null) {
        notes.push({ source: label, message: `${p.name}: the package folder from the build is not on this machine` });
        continue;
      }
      const info = readNpmPackage(p.dir);
      if (info === null) continue;
      npmDirs.set(`npm:${info.name}@${info.version}`, p.dir);
      col.add(npmComponent(info, label));
    }
    if (build.viteHelpers) {
      const viteDir = resolveFrom(root, "vite") ?? resolveFrom(dir, "vite");
      const info = viteDir === null ? null : readNpmPackage(viteDir);
      if (info !== null) col.add(npmComponent(info, label, "vite"));
      else notes.push({ source: label, message: "the build holds Vite's preload helper, but the vite package was not found" });
    }
  }

  // Electron
  const electronCfg = cfg.electron === false ? null : (cfg.electron ?? {});
  if (electronFound !== null && electronCfg !== null) {
    const dist = options.electronDist ?? electronCfg.dist;
    const zip = options.electronZip ?? electronCfg.zip;
    col.add(
      electronComponent(electronFound.version, electronFound.dir, `pnpm:${rel(root, electronFound.importerDir)}`, {
        root,
        dist: dist === undefined ? undefined : path.resolve(root, dist),
        zip: zip === undefined ? undefined : path.resolve(root, zip),
      }, notes),
    );
  }

  // .NET
  if (cfg.dotnet !== false) {
    const listed = options.dotnet ?? (Array.isArray(cfg.dotnet) ? cfg.dotnet : undefined);
    const assetFiles: string[] = [];
    if (listed !== undefined) {
      for (const p of resolveAll(listed)) {
        const f = isDir(p) ? path.join(p, "obj", "project.assets.json") : p;
        if (isFile(f)) assetFiles.push(f);
        else notes.push({ source: rel(root, p), message: "no project.assets.json: run dotnet restore" });
      }
    } else {
      for (const proj of walked.csproj) {
        const f = path.join(path.dirname(proj), "obj", "project.assets.json");
        if (isFile(f)) assetFiles.push(f);
        else notes.push({ source: rel(root, proj), message: "no obj/project.assets.json: run dotnet restore" });
      }
    }
    const projects: DotnetProject[] = [];
    for (const f of assetFiles) {
      let p: DotnetProject;
      try {
        p = readAssetsFile(f, root, notes);
      } catch (error) {
        notes.push({ source: rel(root, f), message: `unreadable: ${error instanceof Error ? error.message : String(error)}` });
        continue;
      }
      if (p.test && listed === undefined) {
        sources.push(`${rel(root, f)} (test project ${p.project}, skipped)`);
        continue;
      }
      projects.push(p);
      sources.push(`${rel(root, f)} (${p.project}, ${p.packages.length} packages with runtime files)`);
      for (const c of p.packages) col.add(c);
    }
    for (const c of dotnetRuntimeComponents(projects, notes)) col.add(c);
  }

  // Fonts
  const fontIndex = new Map<string, string>();
  for (const [key, dir] of npmDirs) {
    const found = new Map<string, string>();
    fontFilesUnder(dir, found);
    for (const name of found.keys()) if (!fontIndex.has(name)) fontIndex.set(name, key);
  }
  const fontFiles = new Set(walked.fonts);
  for (const dir of resolveAll(cfg.fonts ?? [])) {
    for (const f of walkFiles(dir, { skipDir: (n) => n === "node_modules" })) if (FONT_FILE.test(f)) fontFiles.add(f);
  }
  for (const dir of viteDirs) for (const f of walkFiles(dir, { skipDir: () => false })) if (FONT_FILE.test(f)) fontFiles.add(f);
  const seenFontHashes = new Set<string>();
  for (const f of [...fontFiles].sort()) {
    const data = fs.readFileSync(f);
    const hash = sha256(data);
    if (seenFontHashes.has(hash)) continue;
    seenFontHashes.add(hash);
    const owner = fontIndex.get(unhashedName(path.basename(f))) ?? fontIndex.get(path.basename(f).toLowerCase());
    if (owner !== undefined) {
      const c = col.byKey.get(owner);
      if (c && !c.via.includes(`font:${rel(root, path.dirname(f))}`)) c.via.push(`font:${rel(root, path.dirname(f))}`);
      continue;
    }
    let names: FontNames = {};
    let readError: string | undefined;
    try {
      names = readFontNames(f);
    } catch (error) {
      readError = error instanceof Error ? error.message : String(error);
    }
    const family = names.family ?? path.basename(f).replace(FONT_FILE, "");
    const version = versionOfFont(names);
    const key = `font:${family}@${version}`;
    const existing = col.byKey.get(key);
    if (existing) {
      const label = `font:${rel(root, f)}`;
      if (!existing.via.includes(label)) existing.via.push(label);
      continue;
    }
    // License files next to the font; when several, the ones that name the family.
    const fontDir = path.dirname(f);
    const near = fs
      .readdirSync(fontDir)
      .filter((n) => /(licen[cs]e|ofl|copying)/i.test(n) && /(\.(txt|md)|^[^.]+)$/i.test(n) && isFile(path.join(fontDir, n)))
      .sort()
      .map((n) => licenseFileFromPath(path.join(fontDir, n)));
    const fam = family.toLowerCase().replace(/[\s_-]+/g, "");
    const firstWord = (family.split(/\s+/)[0] ?? "").toLowerCase();
    const mine = near.filter((l) => {
      const n = l.name.toLowerCase().replace(/[\s_-]+/g, "");
      return n.includes(fam) || (firstWord.length >= 3 && n.includes(firstWord));
    });
    // Without a file that names the family, only a plain LICENSE, OFL or COPYING file counts.
    const files: LicenseFile[] = mine.length > 0 ? mine : near.filter((l) => /^(licen[cs]e|ofl|copying)(\.(txt|md))?$/i.test(l.name));
    let license: string | null = null;
    let licenseFrom = "font name table";
    let customTerms: string | undefined;
    for (const l of files) {
      const reading = readLicenseText(licenseText(l));
      if (reading.id !== null) {
        ({ license, licenseFrom, customTerms } = fromReading(reading, l.sha256, `license text (${l.name})`));
        break;
      }
    }
    license ??= fontLicenseId(names);
    const copyright = names.copyright ? [names.copyright] : [];
    for (const l of files) for (const line of copyrightLines(licenseText(l))) if (!copyright.includes(line)) copyright.push(line);
    col.add({
      key,
      ecosystem: "font",
      name: family,
      version,
      license,
      licenseFrom: license === null ? "font name table (no license named)" : licenseFrom,
      licenseFiles: files,
      copyright,
      homepage: names.licenseUrl,
      delivery: "bundled",
      via: [`font:${rel(root, f)}`],
      kind: "font",
      customTerms,
      note: readError !== undefined ? `font not readable: ${readError}` : undefined,
    });
  }

  // Vendored libraries
  const vendorDirs = cfg.vendor !== undefined ? resolveAll(cfg.vendor) : walked.vendorDirs;
  for (const vdir of vendorDirs) {
    let children: fs.Dirent[];
    try {
      children = fs.readdirSync(vdir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of children) {
      if (!child.isDirectory()) continue;
      const dir = path.join(vdir, child.name);
      const m = /^(.+?)[-@]v?(\d[\w.+-]*)$/.exec(child.name);
      const name = m ? m[1]! : child.name;
      const version = m ? m[2]! : "";
      const pkg = readNpmPackage(dir);
      const files = licenseFilesIn(dir);
      let license = pkg?.license ?? null;
      let licenseFrom = pkg?.licenseFrom ?? "license text";
      let customTerms = pkg?.customTerms;
      if (license === null) {
        for (const l of files) {
          const reading = readLicenseText(licenseText(l));
          if (reading.id !== null) {
            ({ license, licenseFrom, customTerms } = fromReading(reading, l.sha256, `license text (${l.name})`));
            break;
          }
        }
      }
      const copyright: string[] = [];
      for (const l of files) for (const line of copyrightLines(licenseText(l))) if (!copyright.includes(line)) copyright.push(line);
      col.add({
        key: `vendor:${name}@${version}`,
        ecosystem: "vendor",
        name,
        version,
        license,
        licenseFrom: license === null ? "no license file recognized" : licenseFrom,
        licenseFiles: files,
        copyright,
        customTerms,
        delivery: "bundled",
        via: [`vendor:${rel(root, dir)}`],
      });
    }
  }

  // third-party.json
  const tpFiles = options.thirdParty !== undefined ? resolveAll(options.thirdParty) : cfg.thirdParty !== undefined ? resolveAll(cfg.thirdParty) : walked.thirdParty;
  for (const f of tpFiles) {
    const doc = readThirdParty(f);
    sources.push(`${rel(root, f)} (${doc.items.length} items)`);
    for (const c of thirdPartyComponents(doc, f, `third-party:${rel(root, f)}`)) col.add(c);
  }

  // Packs
  for (const m of collectPacks(options.packs !== undefined ? resolveAll(options.packs) : cfg.packs !== undefined ? resolveAll(cfg.packs) : walked.packs, notes)) {
    col.add(packComponent(m.pack, `pack:${rel(root, m.file)}`));
  }

  // A platform package of a native module (napi-rs and others publish <name>-<os>-<cpu>[-<abi>], esbuild and rolldown
  // @<name>/[<part>-]<os>-<cpu>[-<abi>]) often ships
  // no license file. It takes the license file of its main package, from the same project, when the main package is
  // in the inventory with the same license.
  const npm = [...col.byKey.values()].filter((c) => c.ecosystem === "npm");
  for (const c of npm) {
    if (c.licenseFiles.length > 0 || c.license === null || c.missing || c.missingOptional) continue;
    const parent = mainPackageNames(c.name)
      .map((main) => npm.find((p) => p.name === main && p.license === c.license && p.licenseFiles.length > 0))
      .find((p) => p !== undefined);
    if (parent === undefined) continue;
    c.licenseFiles = parent.licenseFiles;
    c.licenseTextFrom = parent.key;
    if (c.copyright.length === 0) c.copyright = parent.copyright;
  }

  // A package that names its license by id but ships no text gets the standard text.
  for (const c of col.byKey.values()) {
    if (c.licenseFiles.length > 0 || c.license === null || c.missing || c.missingOptional) continue;
    if (!["npm", "nuget", "vendor"].includes(c.ecosystem)) continue;
    const k = classify(c.license);
    if (k.chosen.length !== 1 || k.chosen[0]!.exception !== undefined) continue;
    const holders = c.copyright.length > 0 ? c.copyright : c.authors ? [c.authors] : [];
    const lines = holders.map((h) => (/^(copyright|\(c\)|©)/i.test(h.trim()) ? h.trim() : `Copyright (c) ${h.trim()}`));
    const text = standardLicenseText(canonicalId(k.chosen[0]!.id), lines);
    if (text === null) continue;
    c.licenseFiles = [licenseFileFromText("LICENSE.generated.txt", text)];
    c.generatedText = true;
    if (c.copyright.length === 0) c.copyright = lines;
  }

  const order = ["npm", "vite", "nuget", "dotnet", "electron", "font", "vendor", "third-party", "pack"];
  const components = [...col.byKey.values()].sort(
    (a, b) => order.indexOf(a.ecosystem) - order.indexOf(b.ecosystem) || a.name.localeCompare(b.name, "en") || a.version.localeCompare(b.version, "en"),
  );
  return { root, product, components, notes, sources };
}

const PACK_NAME = /(^|[\\/])(memex\.pack|[^\\/]+\.pack)\.json$/;

/**
 * memex.pack/1 manifests from files and folders. In a folder, every JSON file whose format is
 * memex.pack/1 counts. A named file, or a *.pack.json file, that is not a valid manifest gives a note.
 */
export function collectPacks(paths: string[], notes: InventoryNote[]): { file: string; pack: PackManifest }[] {
  const out: { file: string; pack: PackManifest }[] = [];
  for (const p of paths) {
    const inFolder = isDir(p);
    const files = inFolder ? walkFiles(p, { skipDir: (n) => n === "node_modules" || n === ".staging" }).filter((f) => f.endsWith(".json")).sort() : [p];
    for (const f of files) {
      if (inFolder && !PACK_NAME.test(f)) {
        const doc = tryReadJson(f) as { format?: unknown } | undefined;
        if (doc?.format !== "memex.pack/1") continue;
      }
      try {
        out.push({ file: f, pack: readPack(f) });
      } catch (error) {
        notes.push({ source: f, message: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  return out;
}
