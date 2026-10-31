import { createHash } from "node:crypto";

/** The manifest format of one pack version (contracts/packs.md, schemas/packs/pack.json). */
export const PACK_FORMAT = "memex.pack/1";
/** The format of <packs>/packs.json (schemas/packs/store.json). */
export const STORE_FORMAT = "memex.packs/1";
/** The name of the manifest in a version folder. */
export const MANIFEST_FILE = "memex.pack.json";

export const PACK_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const PACK_VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const CAPABILITY_PATTERN = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/;

export type PackKind = "model" | "map" | "data" | "corpus" | "tool";
export type PackEngine = "onnx" | "generative" | "files";
export type Commercial = "allowed" | "restricted" | "unknown";

export interface PackLicense {
  spdx: string;
  url: string;
  file?: string;
  commercial: Commercial;
  limits: string[];
  attribution: string | null;
  acceptance: "required" | "none";
}

export interface PackFilePart {
  url: string;
  bytes: number;
  sha256: string;
}

export interface PackFile {
  /** Relative, with / separators; see isPackFilePath(). */
  path: string;
  bytes: number;
  sha256: string;
  url: string;
  role?: string;
  parts?: PackFilePart[];
}

export interface PackManifest {
  format: typeof PACK_FORMAT;
  id: string;
  version: string;
  title: string;
  kind: PackKind;
  engine: PackEngine;
  capabilities: string[];
  origin: "upstream" | "memex";
  derivedFrom?: {
    url: string;
    revision: string;
    license: string;
    notice: string;
    trainingData?: Array<{ name: string; url?: string; license: string | null }>;
  };
  source: { publisher: string; homepage: string; revision: string };
  license: PackLicense;
  hardware?: { memoryBytes?: number; gpuMemoryBytes?: number; providers?: Array<"webgpu" | "coreml" | "cpu"> };
  files: PackFile[];
}

/** An error of the pack library, with the error code of the Node contract where one fits. */
export class PackError extends Error {
  readonly code: string;
  readonly hint?: string;
  constructor(code: string, message: string, hint?: string) {
    super(message);
    this.name = "PackError";
    this.code = code;
    if (hint !== undefined) this.hint = hint;
  }
}

// ---------- file paths ----------

/** Characters that a file name cannot hold on Windows, besides the control characters. */
const UNSAFE_NAME_CHARS = new Set(["\\", ":", "*", "?", '"', "<", ">", "|"]);
const RESERVED_NAME = /^(CON|PRN|AUX|NUL|COM[0-9¹²³]|LPT[0-9¹²³])$/i;

/** A control character as .NET char.IsControl counts it: U+0000 to U+001F and U+007F to U+009F. */
function isControl(c: string): boolean {
  const code = c.charCodeAt(0);
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
}

function isSafeSegment(segment: string): boolean {
  if (segment === "" || segment === "." || segment === "..") return false;
  for (const c of segment) if (UNSAFE_NAME_CHARS.has(c) || isControl(c)) return false;
  const last = segment[segment.length - 1];
  if (last === "." || last === " ") return false;
  return !RESERVED_NAME.test(segment.split(".")[0]!.replace(/ +$/, ""));
}

/**
 * True for a pack file path that stays inside the version folder on every OS (contracts/packs.md, Manifest): segments
 * separated by '/', none of them empty, '.' or '..'; no ':' (a drive letter or an alternate data stream); no character
 * that a Windows file name cannot hold (\ * ? " < > | and control characters); no trailing dot or space; and no
 * reserved Windows device name (CON, PRN, AUX, NUL, COM0-9, LPT0-9, also with an extension). The same rules as
 * Memex.Node, and as the `path` pattern of schemas/packs/pack.json (PACK_FILE_PATH_PATTERN).
 */
export function isPackFilePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value[0] !== "/" && value.split("/").every(isSafeSegment);
}

const BAD = String.raw`\\/:*?"<>|\u0000-\u001f\u007f-\u009f`;
const RESERVED = String.raw`(?:[Cc][Oo][Nn]|[Pp][Rr][Nn]|[Aa][Uu][Xx]|[Nn][Uu][Ll]|[Cc][Oo][Mm][0-9¹²³]|[Ll][Pp][Tt][0-9¹²³]) *(?:\.[^/]*)?(?:/|$)`;
const SEGMENT = `(?!${RESERVED})[^${BAD}]*[^${BAD}. ]`;

/** The `path` pattern of schemas/packs/pack.json: isPackFilePath() as one regular expression (Unicode mode). */
export const PACK_FILE_PATH_PATTERN = `^${SEGMENT}(?:/${SEGMENT})*$`;

// ---------- digest ----------

/**
 * The digest of a pack version (contracts/packs.md, Digest): one line "<sha256>  <path>\n" per file, sorted by path in
 * ordinal byte order, hashed as UTF-8 with SHA-256, in lowercase hex.
 */
export function packDigest(files: ReadonlyArray<Pick<PackFile, "path" | "sha256">>): string {
  const lines = [...files]
    .sort((a, b) => Buffer.compare(Buffer.from(a.path, "utf8"), Buffer.from(b.path, "utf8")))
    .map((f) => `${f.sha256}  ${f.path}\n`)
    .join("");
  return createHash("sha256").update(lines, "utf8").digest("hex");
}

/** The folder of a version in the store, relative and with '/': <id>/<version>-<sha8>. */
export function packFolder(manifest: Pick<PackManifest, "id" | "version" | "files">): string {
  return `${manifest.id}/${manifest.version}-${packDigest(manifest.files).slice(0, 8)}`;
}

/** The sum of the bytes of every file. */
export function packBytes(manifest: Pick<PackManifest, "files">): number {
  return manifest.files.reduce((sum, f) => sum + f.bytes, 0);
}

// ---------- the manifest check ----------

function isUri(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function isHttps(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * False for a Hugging Face url whose resolve path names a branch: every url is pinned, and a Hugging Face url names a
 * commit, https://huggingface.co/<owner>/<repo>/resolve/<40 hex>/<path>. hf.co is the short host of Hugging Face.
 */
export function isPinnedUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  if (host !== "huggingface.co" && host !== "hf.co") return true;
  const segments = url.pathname.split("/").filter((s) => s.length > 0);
  const resolve = segments.indexOf("resolve");
  return resolve >= 0 && resolve + 1 < segments.length && /^[0-9a-f]{40}$/.test(segments[resolve + 1]!);
}

const KEYS = {
  manifest: ["format", "id", "version", "title", "kind", "engine", "capabilities", "origin", "derivedFrom", "source", "license", "hardware", "files"],
  derivedFrom: ["url", "revision", "license", "notice", "trainingData"],
  trainingData: ["name", "url", "license"],
  source: ["publisher", "homepage", "revision"],
  license: ["spdx", "url", "file", "commercial", "limits", "attribution", "acceptance"],
  hardware: ["memoryBytes", "gpuMemoryBytes", "providers"],
  file: ["path", "bytes", "sha256", "url", "role", "parts"],
  part: ["url", "bytes", "sha256"],
} as const;

/** The first property that the schema does not know, or undefined. */
function unknownKey(value: object, known: readonly string[]): string | undefined {
  return Object.keys(value).find((k) => !known.includes(k));
}

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

/**
 * Checks a parsed memex.pack/1 manifest with the rules of Memex.Node and returns it. Throws PackError
 * "invalid_manifest" that names the first broken rule.
 */
export function checkPackManifest(value: unknown): PackManifest {
  const fail = (why: string): never => {
    throw new PackError("invalid_manifest", `The pack manifest breaks ${PACK_FORMAT}: ${why}.`);
  };
  const require = (ok: boolean, why: string) => {
    if (!ok) fail(why);
  };
  if (typeof value !== "object" || value === null || Array.isArray(value)) return fail("it is not a JSON object");
  const m = value as Record<string, unknown> & Partial<PackManifest>;
  const extra = (where: string, v: unknown, known: readonly string[]) => {
    if (typeof v === "object" && v !== null && !Array.isArray(v)) {
      const k = unknownKey(v, known);
      require(k === undefined, `${where} has the property '${k}', which the schema does not know`);
    }
  };
  extra("the manifest", m, KEYS.manifest);
  require(m.format === PACK_FORMAT, `format is '${String(m.format)}', not '${PACK_FORMAT}'`);
  require(typeof m.id === "string" && PACK_ID_PATTERN.test(m.id) && m.id !== "location", `id '${String(m.id)}' is not a pack id`);
  require(typeof m.version === "string" && PACK_VERSION_PATTERN.test(m.version), `version '${String(m.version)}' is not a pack version`);
  require(nonEmpty(m.title), "title is empty");
  require(["model", "map", "data", "corpus", "tool"].includes(m.kind as string), `kind '${String(m.kind)}' is not known`);
  require(["onnx", "generative", "files"].includes(m.engine as string), `engine '${String(m.engine)}' is not known`);
  require(Array.isArray(m.capabilities) && m.capabilities.every((c) => typeof c === "string" && CAPABILITY_PATTERN.test(c)), "a capability is not a capability name");
  require(new Set(m.capabilities).size === m.capabilities!.length, "a capability is listed twice");
  require(m.origin === "upstream" || m.origin === "memex", `origin '${String(m.origin)}' is not known`);
  require(m.origin !== "memex" || m.derivedFrom !== undefined, "a pack that Memex made needs derivedFrom");
  if (m.derivedFrom !== undefined) {
    const d = m.derivedFrom as Partial<NonNullable<PackManifest["derivedFrom"]>> | null;
    require(d !== null && isUri(d.url) && nonEmpty(d.revision) && nonEmpty(d.license) && nonEmpty(d.notice), "derivedFrom needs url, revision, license and notice");
    extra("derivedFrom", d, KEYS.derivedFrom);
    if (d!.trainingData !== undefined) {
      require(
        Array.isArray(d!.trainingData) && d!.trainingData.length > 0 && d!.trainingData.every((t) => typeof t === "object" && t !== null && nonEmpty(t.name) && (t.license === null || nonEmpty(t.license)) && (t.url === undefined || isUri(t.url))),
        "derivedFrom.trainingData needs a name and a license (or null) for each data set",
      );
      for (const t of d!.trainingData!) extra("derivedFrom.trainingData", t, KEYS.trainingData);
    }
  }
  const s = m.source as Partial<PackManifest["source"]> | undefined | null;
  require(!!s && nonEmpty(s.publisher) && isUri(s.homepage) && nonEmpty(s.revision), "source needs publisher, homepage and revision");
  extra("source", s, KEYS.source);
  const l = m.license as Partial<PackLicense> | undefined | null;
  require(!!l && typeof l === "object", "license is missing");
  require(nonEmpty(l!.spdx) && isUri(l!.url), "license needs spdx and url");
  extra("license", l, KEYS.license);
  require("attribution" in l! && (l!.attribution === null || typeof l!.attribution === "string"), "license.attribution is missing (null when no credit is necessary)");
  require(l!.file === undefined || nonEmpty(l!.file), "license.file is empty");
  require(["allowed", "restricted", "unknown"].includes(l!.commercial as string), `license.commercial '${String(l!.commercial)}' is not known`);
  require(Array.isArray(l!.limits) && l!.limits.every(nonEmpty), "license.limits has an empty entry");
  require(l!.acceptance === "required" || l!.acceptance === "none", `license.acceptance '${String(l!.acceptance)}' is not known`);
  require(l!.acceptance !== "required" || nonEmpty(l!.file), "a license that needs acceptance names its file");
  const h = m.hardware as PackManifest["hardware"] | undefined;
  if (h !== undefined) {
    require(typeof h === "object" && h !== null, "hardware is not an object");
    extra("hardware", h, KEYS.hardware);
    require(h.providers === undefined || (Array.isArray(h.providers) && h.providers.every((p) => ["webgpu", "coreml", "cpu"].includes(p))), "hardware.providers has an unknown provider");
    require((h.memoryBytes === undefined || isCount(h.memoryBytes)) && (h.gpuMemoryBytes === undefined || isCount(h.gpuMemoryBytes)), "hardware memory is negative");
  }
  require(Array.isArray(m.files) && m.files.length > 0, "files is empty");
  for (const file of m.files!) {
    require(typeof file === "object" && file !== null, "files has a null entry");
    extra(`the file ${String(file.path)}`, file, KEYS.file);
    require(isPackFilePath(file.path), `file path '${String(file.path)}' is not a relative path with / separators`);
    require(isCount(file.bytes) && typeof file.sha256 === "string" && SHA256_PATTERN.test(file.sha256), `${file.path} needs bytes and a lowercase hex sha256`);
    require(isHttps(file.url), `${file.path} needs an https url`);
    require(file.role === undefined || nonEmpty(file.role), `${file.path} has an empty role`);
    if (file.parts !== undefined) {
      require(Array.isArray(file.parts) && file.parts.length >= 2, `${file.path} has fewer than two parts`);
      require(
        file.parts.every((p) => typeof p === "object" && p !== null && isHttps(p.url) && isCount(p.bytes) && p.bytes >= 1 && typeof p.sha256 === "string" && SHA256_PATTERN.test(p.sha256)),
        `${file.path} has a part without an https url, bytes or sha256`,
      );
      for (const part of file.parts) extra(`a part of ${file.path}`, part, KEYS.part);
      require(file.parts.reduce((sum, p) => sum + p.bytes, 0) === file.bytes, `the parts of ${file.path} do not add up to its bytes`);
    }
    require(isPinnedUrl(file.url) && (file.parts === undefined || file.parts.every((p) => isPinnedUrl(p.url))), `${file.path} has a Hugging Face url that names a branch, not a commit`);
  }
  require(new Set(m.files!.map((f) => f.path)).size === m.files!.length, "a file path is listed twice");
  require(l!.file === undefined || m.files!.some((f) => f.path === l!.file), `license.file '${String(l!.file)}' is not in files`);
  return m as PackManifest;
}

/** True when Memex.Node refuses to install the pack: its license or its commercial use is unknown. */
export function isLicenseUnknown(manifest: Pick<PackManifest, "license">): boolean {
  return manifest.license.spdx.toLowerCase() === "unknown" || manifest.license.commercial === "unknown";
}

/** The file that holds the license text, for a license that needs acceptance. */
export function licenseFile(manifest: PackManifest): PackFile | undefined {
  return manifest.license.file === undefined ? undefined : manifest.files.find((f) => f.path === manifest.license.file);
}
