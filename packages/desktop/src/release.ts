import { createHash } from "node:crypto";
import { closeSync, copyFileSync, createReadStream, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------------------------------------------
// Release version: the app's package.json, the desktop package.json (when separate) and the v<version> tag agree.
// A version is X.Y.Z, or X.Y.Z-rc.N for a release candidate (the beta channel).

const VERSION = String.raw`\d+\.\d+\.\d+(?:-rc\.\d+)?`;
const SEMVER = new RegExp(`^${VERSION}$`);

/** True for a release candidate: X.Y.Z-rc.N, or the tag vX.Y.Z-rc.N. */
export function isReleaseCandidate(version: string): boolean {
  return /^v?\d+\.\d+\.\d+-rc\.\d+$/.test(version);
}

export function readPackageVersion(packagePath: string): string {
  const manifest = JSON.parse(readFileSync(packagePath, "utf8")) as { version?: unknown };
  const version = manifest?.version;
  if (typeof version !== "string" || !SEMVER.test(version)) throw new Error(`The package version must be X.Y.Z or X.Y.Z-rc.N: ${packagePath}`);
  return version;
}

export function parseReleaseTag(tag: unknown): string | null {
  if (typeof tag !== "string" || tag.trim() === "") return null;
  const match = tag.trim().match(new RegExp(`^v(${VERSION})$`));
  return match ? match[1]! : null;
}

export interface ReleaseVersionInput {
  /** The versions that must be equal, for example the root and the desktop package.json. */
  versions: string[];
  releaseTag?: string | null;
  requireTag?: boolean;
}

/** Checks that the versions agree and match the tag. Returns the version and the tag. */
export function assertReleaseVersion(input: ReleaseVersionInput): { version: string; tag: string | null } {
  const [first, ...rest] = input.versions;
  if (first === undefined) throw new Error("No package version to check.");
  for (const other of rest) {
    if (other !== first) throw new Error(`The package versions differ: ${first} and ${other}.`);
  }
  const tag = input.releaseTag ?? null;
  if (!input.requireTag && (tag === null || tag === "")) return { version: first, tag: null };
  const tagged = parseReleaseTag(tag);
  if (!tagged) throw new Error(`The release tag ${tag ?? "(missing)"} is not vX.Y.Z or vX.Y.Z-rc.N.`);
  if (tagged !== first) throw new Error(`The release tag v${tagged} does not match the package version ${first}.`);
  return { version: first, tag: `v${tagged}` };
}

/** The release tag from MEMEX_RELEASE_TAG, or from GitHub Actions on a tag push. */
export function releaseTagFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): string | null {
  return env.MEMEX_RELEASE_TAG ?? (env.GITHUB_REF_TYPE === "tag" ? (env.GITHUB_REF_NAME ?? null) : null);
}

// ---------------------------------------------------------------------------------------------------------------
// Installer names and SHA256SUMS.txt.

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The pattern of a shared installer: <base>-<version>-<os>-<arch>.<ext>. */
export function artifactPattern(base: string): RegExp {
  return new RegExp(`^${escapeRegExp(base)}-${VERSION}-(windows|macos|linux)-[a-z0-9]+\\.(exe|dmg|zip|AppImage|deb)$`);
}

function resolveArtifactDirectory(directory: string): string {
  if (typeof directory !== "string" || directory.trim() === "") throw new Error("The artifact folder is required.");
  if (directory.split(/[\\/]/).some((segment) => segment === "..")) throw new Error("The artifact folder must not contain '..'.");
  return directory;
}

/** Renames x86_64 and amd64 Linux installers to linux-x64. */
export function normalizeLinuxArtifactNames(directory: string, base: string): Array<{ from: string; to: string }> {
  const root = resolveArtifactDirectory(directory);
  const alias = new RegExp(`^${escapeRegExp(base)}-(${VERSION})-linux-(?:x86_64|amd64)\\.(AppImage|deb)$`);
  const renamed: Array<{ from: string; to: string }> = [];
  for (const name of readdirSync(root)) {
    const match = name.match(alias);
    if (!match) continue;
    const next = `${base}-${match[1]}-linux-x64.${match[2]}`;
    if (existsSync(path.join(root, next))) throw new Error(`Cannot rename ${name}: ${next} exists.`);
    renameSync(path.join(root, name), path.join(root, next));
    renamed.push({ from: name, to: next });
  }
  return renamed;
}

export function listShareArtifacts(directory: string, base: string): string[] {
  const pattern = artifactPattern(base);
  return readdirSync(resolveArtifactDirectory(directory))
    .filter((name) => pattern.test(name))
    .sort();
}

export function hashFileSync(file: string): string {
  const hash = createHash("sha256");
  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(64 * 1024);
    let bytes = 0;
    while ((bytes = readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, bytes));
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

export async function hashFile(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function writeChecksumPayload(outputPath: string, entries: Map<string, string>): { outputPath: string; names: string[] } {
  const lines = [...entries.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, digest]) => `${digest}  ${name}`);
  const temporary = `${outputPath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${lines.join("\n")}\n`);
  renameSync(temporary, outputPath);
  return { outputPath, names: [...entries.keys()].sort() };
}

/** Writes SHA256SUMS.txt for every shared installer in the folder (sha256sum -c reads it). */
export function writeChecksums(directory: string, base: string, outputPath = path.join(directory, "SHA256SUMS.txt")): { outputPath: string; names: string[] } {
  normalizeLinuxArtifactNames(directory, base);
  const names = listShareArtifacts(directory, base);
  if (names.length === 0) throw new Error(`No ${base}-<version>-<os>-<arch> installers were found in ${directory}.`);
  const entries = new Map<string, string>();
  for (const name of names) entries.set(name, hashFileSync(path.join(directory, name)));
  return writeChecksumPayload(outputPath, entries);
}

const PARTIAL_SUMS = /^SHA256SUMS-(linux|windows|macos)\.txt$/;

function parseChecksumFile(text: string, source: string): Array<{ digest: string; name: string }> {
  const entries: Array<{ digest: string; name: string }> = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const match = line.match(/^([a-f0-9]{64})  (.+)$/);
    if (!match) throw new Error(`Invalid checksum line in ${source}: ${line}`);
    entries.push({ digest: match[1]!, name: match[2]! });
  }
  return entries;
}

/**
 * Merges the per-platform SHA256SUMS-<os>.txt that each build job wrote into one SHA256SUMS.txt, after it checks
 * every digest against the downloaded bytes and that the folder holds exactly the listed installers.
 */
export async function mergeBuilderChecksums(directory: string, base: string, outputPath = path.join(directory, "SHA256SUMS.txt")): Promise<{ outputPath: string; names: string[] }> {
  const root = resolveArtifactDirectory(directory);
  normalizeLinuxArtifactNames(root, base);
  const pattern = artifactPattern(base);
  const partials = readdirSync(root).filter((name) => PARTIAL_SUMS.test(name)).sort();
  if (partials.length === 0) throw new Error("No SHA256SUMS-<os>.txt files were found.");
  const entries = new Map<string, string>();
  for (const partial of partials) {
    for (const { digest, name } of parseChecksumFile(readFileSync(path.join(root, partial), "utf8"), partial)) {
      if (!pattern.test(name)) throw new Error(`${partial} lists a file that is not an installer: ${name}`);
      if (entries.has(name) && entries.get(name) !== digest) throw new Error(`Two different digests for ${name}.`);
      entries.set(name, digest);
    }
  }
  if (entries.size === 0) throw new Error("The checksum files list no installers.");
  for (const [name, expected] of entries) {
    const file = path.join(root, name);
    if (!existsSync(file)) throw new Error(`The checksums list a missing installer: ${name}`);
    if ((await hashFile(file)) !== expected) throw new Error(`Checksum mismatch for ${name}.`);
  }
  const present = listShareArtifacts(root, base);
  const expected = [...entries.keys()].sort();
  if (present.length !== expected.length || present.some((name, i) => name !== expected[i])) {
    throw new Error(`The installers do not match the checksums. present=${present.join(",")} expected=${expected.join(",")}`);
  }
  return writeChecksumPayload(outputPath, entries);
}

// ---------------------------------------------------------------------------------------------------------------
// app.asar: what a build ships.

export function findAppAsarArchives(directory: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const next = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(next);
      else if (entry.name === "app.asar") found.push(next);
    }
  };
  walk(directory);
  return found.sort();
}

/** The file paths inside an asar archive, with / separators. */
export function listAsarFiles(archivePath: string): string[] {
  const buffer = readFileSync(archivePath);
  if (buffer.length < 16) throw new Error(`The asar archive is too small: ${archivePath}`);
  const headerEnd = 8 + buffer.readUInt32LE(4);
  if (headerEnd > buffer.length) throw new Error(`The asar header overruns the archive: ${archivePath}`);
  const jsonSize = buffer.readUInt32LE(12);
  if (16 + jsonSize > buffer.length) throw new Error(`The asar JSON overruns the archive: ${archivePath}`);
  let header: { files?: Record<string, unknown> };
  try {
    header = JSON.parse(buffer.subarray(16, 16 + jsonSize).toString("utf8")) as { files?: Record<string, unknown> };
  } catch {
    throw new Error(`The asar header is not JSON: ${archivePath}`);
  }
  const files: string[] = [];
  const collect = (node: Record<string, unknown>, prefix: string) => {
    for (const [name, child] of Object.entries(node)) {
      const p = prefix ? `${prefix}/${name}` : name;
      const sub = child as { files?: Record<string, unknown> } | null;
      if (sub && typeof sub === "object" && sub.files) collect(sub.files, p);
      else files.push(p);
    }
  };
  collect(header.files ?? {}, "");
  return files.sort();
}

interface AsarEntry {
  files?: Record<string, AsarEntry>;
  size?: number;
  offset?: string;
  unpacked?: boolean;
  link?: string;
}

function safeAsarName(name: string, archivePath: string): string {
  if (name === "" || name === "." || name === ".." || /[\\/\u0000]/.test(name) || /^[A-Za-z]:/.test(name)) {
    throw new Error(`The asar archive holds an unsafe name: ${archivePath}`);
  }
  return name;
}

/**
 * The folder name that takes the place of node_modules for the files of a first-party package in an extracted build,
 * which keeps them apart from registry packages.
 */
export const FIRST_PARTY_MODULES = "node_modules.first-party";

/**
 * The packages of a pnpm lockfile that do not come from the registry: workspace packages (link:), local tarballs and
 * folders (file:) and packages from a git host or a URL. Their code is built here or by us, so it counts as the
 * app's own code. Registry packages carry a plain version (1.2.3) and are left out.
 */
export function nonRegistryPackages(lockfileText: string): Set<string> {
  const names = new Set<string>();
  const local = /^(?:link|file|https?|git\+[a-z]+|git|github):/;
  const unquote = (value: string) => value.trim().replace(/^'(.*)'$/, "$1").replace(/^"(.*)"$/, "$1");
  let key: string | null = null;
  for (const line of lockfileText.split(/\r?\n/)) {
    const match = line.match(/^(\s+)('[^']+'|"[^"]+"|[^\s:'"][^:]*?):(?:\s+(.*))?$/);
    if (!match) continue;
    const name = unquote(match[2]!);
    const value = match[3] === undefined ? "" : unquote(match[3]);
    if (value === "") {
      // A key line: an importer dependency ("name:"), or a package ("name@version:").
      key = name;
      const at = name.lastIndexOf("@");
      if (at > 0 && local.test(name.slice(at + 1))) names.add(name.slice(0, at));
      continue;
    }
    if (name === "version" && key !== null && local.test(value)) names.add(key);
    else if (name !== "version" && name !== "specifier" && local.test(value)) names.add(name);
  }
  return names;
}

/** The nearest pnpm-lock.yaml at or above a folder, or null. */
export function findPnpmLockfile(from: string): string | null {
  let dir = path.resolve(from);
  for (;;) {
    const candidate = path.join(dir, "pnpm-lock.yaml");
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** The package that a path inside app.asar belongs to (the name after its last node_modules), or null. */
export function packageOfPath(parts: string[]): string | null {
  const at = parts.lastIndexOf("node_modules");
  if (at === -1 || at + 1 >= parts.length - 1) return null;
  const first = parts[at + 1]!;
  if (!first.startsWith("@")) return first;
  return at + 2 < parts.length - 1 ? `${first}/${parts[at + 2]}` : null;
}

export interface ExtractOptions {
  /** True for a first-party package: its files go under FIRST_PARTY_MODULES, not node_modules. */
  firstParty?: (name: string) => boolean;
}

/**
 * Writes the files of an app.asar into an empty folder, so that other tools read what the build ships. Files that the archive keeps unpacked are copied from app.asar.unpacked. A link inside the archive is
 * refused: Memex apps ship none. The files of a first-party package go under FIRST_PARTY_MODULES in place of every
 * node_modules folder of their path.
 */
export function extractAsar(archivePath: string, outDirectory: string, options: ExtractOptions = {}): { files: number; bytes: number; firstParty: string[] } {
  const buffer = readFileSync(archivePath);
  if (buffer.length < 16) throw new Error(`The asar archive is too small: ${archivePath}`);
  const dataStart = 8 + buffer.readUInt32LE(4);
  const jsonSize = buffer.readUInt32LE(12);
  if (dataStart > buffer.length || 16 + jsonSize > buffer.length) throw new Error(`The asar header overruns the archive: ${archivePath}`);
  let header: { files?: Record<string, AsarEntry> };
  try {
    header = JSON.parse(buffer.subarray(16, 16 + jsonSize).toString("utf8")) as { files?: Record<string, AsarEntry> };
  } catch {
    throw new Error(`The asar header is not JSON: ${archivePath}`);
  }
  if (existsSync(outDirectory) && readdirSync(outDirectory).length > 0) throw new Error(`The folder is not empty: ${outDirectory}`);
  mkdirSync(outDirectory, { recursive: true });
  const unpackedRoot = `${archivePath}.unpacked`;
  let files = 0;
  let bytes = 0;
  const firstParty = new Set<string>();
  const walk = (node: Record<string, AsarEntry>, relative: string[]) => {
    for (const [name, entry] of Object.entries(node)) {
      const parts = [...relative, safeAsarName(name, archivePath)];
      if (entry.link !== undefined) throw new Error(`app.asar holds a link: ${parts.join("/")}`);
      if (entry.files) {
        mkdirSync(path.join(outDirectory, ...parts), { recursive: true });
        walk(entry.files, parts);
        continue;
      }
      const owner = packageOfPath(parts);
      let target = path.join(outDirectory, ...parts);
      if (owner !== null && options.firstParty?.(owner)) {
        firstParty.add(owner);
        target = path.join(outDirectory, ...parts.map((part) => (part === "node_modules" ? FIRST_PARTY_MODULES : part)));
        if (existsSync(target)) throw new Error(`Two files of app.asar extract to the same place: ${parts.join("/")}`);
        mkdirSync(path.dirname(target), { recursive: true });
      }
      if (entry.unpacked) {
        copyFileSync(path.join(unpackedRoot, ...parts), target);
        bytes += statSync(target).size;
      } else {
        const size = Number(entry.size ?? 0);
        const start = dataStart + Number(entry.offset ?? "0");
        if (!Number.isSafeInteger(size) || size < 0 || !Number.isSafeInteger(start) || start + size > buffer.length) {
          throw new Error(`An asar entry overruns the archive: ${parts.join("/")}`);
        }
        writeFileSync(target, buffer.subarray(start, start + size));
        bytes += size;
      }
      files++;
    }
  };
  walk(header.files ?? {}, []);
  return { files, bytes, firstParty: [...firstParty].sort() };
}

/**
 * Writes what a release folder ships: for each app.asar (one per unpacked build) its files under
 * <out>/<build>/app, and the other files of its resources folder (the CLI shims, the notices) under
 * <out>/<build>/resources. The Electron program itself is not copied: it is the same for every app. The files of
 * first-party packages go under FIRST_PARTY_MODULES (see extractAsar).
 */
export function extractRelease(releaseDirectory: string, outDirectory: string, options: ExtractOptions = {}): Array<{ archive: string; out: string; files: number; firstParty: string[] }> {
  const archives = findAppAsarArchives(releaseDirectory);
  if (archives.length === 0) throw new Error(`No app.asar was found under ${releaseDirectory}.`);
  if (existsSync(outDirectory) && readdirSync(outDirectory).length > 0) throw new Error(`The folder is not empty: ${outDirectory}`);
  const result: Array<{ archive: string; out: string; files: number; firstParty: string[] }> = [];
  for (const archive of archives) {
    const resources = path.dirname(archive);
    const build = path
      .relative(releaseDirectory, resources)
      .split(/[\\/]/)
      .filter((part) => part !== "" && part !== "resources" && part !== "Contents" && part !== "Resources")
      .join("-")
      .replace(/[^A-Za-z0-9._-]+/g, "_") || "app";
    const out = path.join(outDirectory, build);
    const { files, firstParty } = extractAsar(archive, path.join(out, "app"), options);
    let copied = 0;
    const copy = (from: string, to: string) => {
      for (const entry of readdirSync(from, { withFileTypes: true })) {
        const source = path.join(from, entry.name);
        const target = path.join(to, entry.name);
        if (entry.isDirectory()) {
          mkdirSync(target, { recursive: true });
          copy(source, target);
        } else if (entry.isFile()) {
          copyFileSync(source, target);
          copied++;
        }
      }
    };
    for (const entry of readdirSync(resources, { withFileTypes: true })) {
      // app.asar is extracted above, and app.asar.unpacked with it; default_app.asar and elevate.exe come with Electron.
      if (["app.asar", "app.asar.unpacked", "default_app.asar", "elevate.exe"].includes(entry.name) || entry.name.endsWith(".lproj")) continue;
      const target = path.join(out, "resources", entry.name);
      if (entry.isDirectory()) {
        mkdirSync(target, { recursive: true });
        copy(path.join(resources, entry.name), target);
      } else if (entry.isFile()) {
        mkdirSync(path.dirname(target), { recursive: true });
        copyFileSync(path.join(resources, entry.name), target);
        copied++;
      }
    }
    result.push({ archive, out, files: files + copied, firstParty });
  }
  return result;
}

export interface AsarRules {
  /** Paths that must be in app.asar. */
  required?: string[];
  /** Path prefixes that must not be in app.asar or its unpacked folder (for example a plain-text server tree). */
  forbiddenPrefixes?: string[];
}

/** Checks a list of packed files: no source maps, every required path, no forbidden prefix. */
export function assertPackedAppFiles(paths: string[], rules: AsarRules = {}): void {
  const normalized = paths.map((p) => String(p).replaceAll("\\", "/"));
  const maps = normalized.filter((p) => p.endsWith(".map"));
  if (maps.length > 0) throw new Error(`The app must not ship source maps: ${maps.slice(0, 10).join(", ")}`);
  for (const required of rules.required ?? []) {
    if (!normalized.includes(required)) throw new Error(`${required} is missing from app.asar.`);
  }
  const leaked = normalized.filter((p) => (rules.forbiddenPrefixes ?? []).some((prefix) => p === prefix || p.startsWith(prefix)));
  if (leaked.length > 0) throw new Error(`app.asar must not include: ${leaked.slice(0, 10).join(", ")}`);
}

function walkFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const next = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(next);
      else out.push(path.relative(root, next).replaceAll("\\", "/"));
    }
  };
  walk(root);
  return out;
}

/** Checks every app.asar under a release folder, and the unpacked folder next to it. */
export function inspectReleaseAsar(releaseDirectory: string, rules: AsarRules = {}): { archives: string[]; files: number } {
  const archives = findAppAsarArchives(releaseDirectory);
  if (archives.length === 0) throw new Error(`No app.asar was found under ${releaseDirectory}.`);
  let files = 0;
  for (const archive of archives) {
    const list = listAsarFiles(archive);
    files += list.length;
    assertPackedAppFiles(list, rules);
    const unpacked = `${archive}.unpacked`;
    if (existsSync(unpacked) && statSync(unpacked).isDirectory()) {
      assertPackedAppFiles(walkFiles(unpacked), { forbiddenPrefixes: rules.forbiddenPrefixes });
    }
  }
  return { archives, files };
}
