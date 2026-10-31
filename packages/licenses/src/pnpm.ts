import fs from "node:fs";
import path from "node:path";
import { isDir, readText, realpath, tryReadJson } from "./files.js";
import { parseYaml, type YamlValue } from "./yaml.js";

export class LockfileError extends Error {}

type Deps = Record<string, string>;

export interface Importer {
  path: string;
  dependencies: Deps;
  optionalDependencies: Deps;
  devDependencies: Deps;
}

export interface Lockfile {
  version: string;
  importers: Map<string, Importer>;
  /** Snapshot key (`name@version(peers)`) to its dependencies. */
  snapshots: Map<string, { dependencies: Deps; optionalDependencies: Deps; optional: boolean }>;
  /** Package key to the version its package.json holds, where the lockfile states it (git and tarball packages). */
  packageVersions: Map<string, string>;
}

function asMap(v: YamlValue | undefined): Record<string, YamlValue> {
  return v !== null && v !== undefined && typeof v === "object" && !Array.isArray(v) ? v : {};
}

/** Importer dependencies: `{ name: { specifier, version } }` in lockfile 9. */
function importerDeps(v: YamlValue | undefined): Deps {
  const out: Deps = {};
  for (const [name, entry] of Object.entries(asMap(v))) {
    if (typeof entry === "string") out[name] = entry;
    else {
      const version = asMap(entry).version;
      if (typeof version === "string") out[name] = version;
    }
  }
  return out;
}

function plainDeps(v: YamlValue | undefined): Deps {
  const out: Deps = {};
  for (const [name, version] of Object.entries(asMap(v))) if (typeof version === "string") out[name] = version;
  return out;
}

export function readLockfile(file: string): Lockfile {
  let doc: YamlValue;
  try {
    doc = parseYaml(readText(file));
  } catch (error) {
    throw new LockfileError(`${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const top = asMap(doc);
  const version = String(top.lockfileVersion ?? "");
  if (!/^(9|10)\./.test(version)) throw new LockfileError(`${file}: lockfile version ${version || "missing"} is not supported (9.x or later)`);
  const importers = new Map<string, Importer>();
  for (const [p, entry] of Object.entries(asMap(top.importers))) {
    const e = asMap(entry);
    importers.set(p, {
      path: p,
      dependencies: importerDeps(e.dependencies),
      optionalDependencies: importerDeps(e.optionalDependencies),
      devDependencies: importerDeps(e.devDependencies),
    });
  }
  const snapshots = new Map<string, { dependencies: Deps; optionalDependencies: Deps; optional: boolean }>();
  for (const [key, entry] of Object.entries(asMap(top.snapshots))) {
    const e = asMap(entry);
    snapshots.set(key, {
      dependencies: plainDeps(e.dependencies),
      optionalDependencies: plainDeps(e.optionalDependencies),
      optional: e.optional === "true",
    });
  }
  const packageVersions = new Map<string, string>();
  for (const [key, entry] of Object.entries(asMap(top.packages))) {
    const v = asMap(entry).version;
    if (typeof v === "string") packageVersions.set(key, v);
  }
  return { version, importers, snapshots, packageVersions };
}

/** Splits a dependency version: an alias `npm:name@1.0.0` names another package. */
export function resolveRef(name: string, ref: string): { name: string; ref: string } {
  if (ref.startsWith("npm:")) {
    const spec = ref.slice(4);
    const at = spec.lastIndexOf("@");
    if (at > 0) return { name: spec.slice(0, at), ref: spec.slice(at + 1) };
  }
  return { name, ref };
}

/** The version without the peer suffix: `1.2.3(react@19.0.0)` is `1.2.3`. */
export function bareVersion(ref: string): string {
  const i = ref.indexOf("(");
  return i === -1 ? ref : ref.slice(0, i);
}

/** Finds a package the way Node does: `<dir>/node_modules/<name>` in this folder and each parent. */
export function resolveFrom(dir: string, name: string): string | null {
  let current = dir;
  for (;;) {
    if (path.basename(current) !== "node_modules") {
      const candidate = path.join(current, "node_modules", ...name.split("/"));
      if (isDir(candidate)) return realpath(candidate);
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export interface ResolvedPackage {
  name: string;
  version: string;
  /** The package folder, or null when it is not installed. */
  dir: string | null;
  /** True when every path to it is optional. */
  optional: boolean;
  importers: Set<string>;
}

export interface ClosureOptions {
  importers: string[];
  dev: boolean;
  /** Packages that the walk records but does not enter, for example electron. */
  stop: Set<string>;
}

export interface Closure {
  packages: Map<string, ResolvedPackage>;
  /** Stopped packages: name to version and importer folder. */
  stopped: Map<string, { version: string; importerDir: string; dir: string | null }>;
  /** Local packages linked with link: or file: that are not importers. */
  linked: string[];
}

/** An index of every package in the pnpm virtual store, used when Node resolution does not find one. */
function storeIndex(root: string): Map<string, string> {
  const index = new Map<string, string>();
  const store = path.join(root, "node_modules", ".pnpm");
  let entries: string[];
  try {
    entries = fs.readdirSync(store);
  } catch {
    return index;
  }
  for (const entry of entries) {
    const nm = path.join(store, entry, "node_modules");
    let names: string[];
    try {
      names = fs.readdirSync(nm);
    } catch {
      continue;
    }
    for (const n of names) {
      const dirs = n.startsWith("@") ? safeList(path.join(nm, n)).map((s) => path.join(nm, n, s)) : [path.join(nm, n)];
      for (const d of dirs) {
        const pkg = tryReadJson(path.join(d, "package.json")) as { name?: unknown; version?: unknown } | undefined;
        if (pkg && typeof pkg.name === "string" && typeof pkg.version === "string") {
          const key = `${pkg.name}@${pkg.version}`;
          if (!index.has(key)) index.set(key, realpath(d));
        }
      }
    }
  }
  return index;
}

function safeList(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** Every package that the chosen importers need at run time, with the folder each one is installed in. */
export function closure(root: string, lock: Lockfile, options: ClosureOptions): Closure {
  const packages = new Map<string, ResolvedPackage>();
  const stopped = new Map<string, { version: string; importerDir: string; dir: string | null }>();
  const linked: string[] = [];
  let index: Map<string, string> | null = null;
  const seenImporters = new Set<string>();
  interface Item {
    name: string;
    ref: string;
    from: string;
    optional: boolean;
    importer: string;
  }
  const queue: Item[] = [];

  const addImporter = (imp: string, optional: boolean, origin: string) => {
    if (seenImporters.has(imp)) return;
    seenImporters.add(imp);
    const importer = lock.importers.get(imp);
    if (importer === undefined) return;
    const dir = path.resolve(root, imp);
    const groups: [Deps, boolean][] = [
      [importer.dependencies, optional],
      [importer.optionalDependencies, true],
    ];
    if (options.dev) groups.push([importer.devDependencies, optional]);
    for (const [deps, opt] of groups) {
      for (const [name, ref] of Object.entries(deps)) queue.push({ name, ref, from: dir, optional: opt, importer: origin });
    }
    // Stopped packages count in dev dependencies too: electron is a dev dependency but ships.
    for (const [name, ref] of Object.entries(importer.devDependencies)) {
      if (options.stop.has(name) && !stopped.has(name)) {
        stopped.set(name, { version: bareVersion(ref), importerDir: dir, dir: resolveFrom(dir, name) });
      }
    }
  };
  for (const imp of options.importers) addImporter(imp, false, imp);

  const optionalState = new Map<string, boolean>();
  while (queue.length > 0) {
    const item = queue.shift()!;
    const { name, ref } = resolveRef(item.name, item.ref);
    if (ref.startsWith("link:")) {
      const target = path.resolve(item.from, ref.slice(5));
      const imp = path.relative(root, target).split(path.sep).join("/") || ".";
      if (lock.importers.has(imp)) addImporter(imp, item.optional, item.importer);
      else if (!linked.includes(imp)) linked.push(imp);
      continue;
    }
    if (options.stop.has(name)) {
      if (!stopped.has(name)) stopped.set(name, { version: bareVersion(ref), importerDir: item.from, dir: resolveFrom(item.from, name) });
      continue;
    }
    const snapKey = `${name}@${ref}`;
    let version = bareVersion(ref);
    // A git or tarball dependency has a URL in place of a version: the version is in the lockfile's
    // packages entry or in the installed package.json.
    const urlRef = !ref.startsWith("file:") && !/^\d/.test(version);
    if (urlRef) {
      const stated = lock.packageVersions.get(`${name}@${version}`);
      const localDir = resolveFrom(item.from, name);
      const pkg = localDir === null ? undefined : (tryReadJson(path.join(localDir, "package.json")) as { name?: unknown; version?: unknown } | undefined);
      if (stated !== undefined) version = stated;
      else if (pkg && pkg.name === name && typeof pkg.version === "string") version = pkg.version;
    }
    if (ref.startsWith("file:")) {
      const localDir = resolveFrom(item.from, name);
      const pkg = localDir === null ? undefined : (tryReadJson(path.join(localDir, "package.json")) as { version?: unknown } | undefined);
      version = pkg && typeof pkg.version === "string" ? pkg.version : version;
    }
    const pkgKey = `${name}@${version}`;
    const before = optionalState.get(snapKey);
    // Visit again only when a required path reaches a package first seen as optional.
    if (before !== undefined && (before === false || item.optional)) {
      packages.get(pkgKey)?.importers.add(item.importer);
      continue;
    }
    optionalState.set(snapKey, item.optional);
    let dir = resolveFrom(item.from, name);
    if (dir !== null && !ref.startsWith("file:")) {
      const pkg = tryReadJson(path.join(dir, "package.json")) as { version?: unknown } | undefined;
      if (!pkg || pkg.version !== version) dir = null;
    }
    if (dir === null && !ref.startsWith("file:")) {
      index ??= storeIndex(root);
      dir = index.get(pkgKey) ?? null;
    }
    let entry = packages.get(pkgKey);
    if (entry === undefined) {
      entry = { name, version, dir, optional: item.optional, importers: new Set([item.importer]) };
      packages.set(pkgKey, entry);
    } else {
      entry.optional = entry.optional && item.optional;
      entry.importers.add(item.importer);
      entry.dir ??= dir;
    }
    const snap = lock.snapshots.get(snapKey) ?? lock.snapshots.get(pkgKey);
    if (snap === undefined) continue;
    const from = dir ?? item.from;
    const opt = item.optional || snap.optional;
    for (const [n, r] of Object.entries(snap.dependencies)) queue.push({ name: n, ref: r, from, optional: opt, importer: item.importer });
    for (const [n, r] of Object.entries(snap.optionalDependencies)) queue.push({ name: n, ref: r, from, optional: true, importer: item.importer });
  }
  return { packages, stopped, linked };
}
