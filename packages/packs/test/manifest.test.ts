import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import { PACK_FILE_PATH_PATTERN, PackError, checkPackManifest, isPackFilePath, isPinnedUrl, packDigest, packFolder, type PackManifest } from "../src/index.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const readJson = (p: string) => JSON.parse(fs.readFileSync(path.join(repo, p), "utf8")) as unknown;
const schema = readJson("schemas/packs/pack.json") as { $id: string };
const ajv = new Ajv2020.default({ strict: false, allErrors: true });
addFormats.default(ajv);
const validate = ajv.compile(schema);
const e5 = () => structuredClone(readJson("contracts/fixtures/packs/pack-e5-small.json")) as PackManifest;

// The path cases of Memex.Node (PackManifestTests) and more: each is refused by Node, the schema, and this library.
const BAD_PATHS = [
  "",
  "../LICENSE",
  "/LICENSE",
  "onnx\\model.onnx",
  "C:/Users/someone/victim.txt",
  "c:victim.txt",
  "onnx/model.onnx:stream",
  "//server/share/x",
  "onnx//model.onnx",
  "onnx/",
  "./model.onnx",
  "onnx/./model.onnx",
  "onnx/../model.onnx",
  "..",
  "onnx/CON.txt",
  "onnx/con",
  "onnx/lpt1",
  "LPT¹",
  "com9.tar.gz",
  "aux .txt",
  "Nul",
  "onnx/model.onnx.",
  "onnx/model.onnx ",
  "onnx/mo?del.onnx",
  "a*b",
  'a"b',
  "a<b",
  "a>b",
  "a|b",
  "a\u0000b",
  "tab\there",
  "a\u007fb",
  "a\u0085b",
];
const GOOD_PATHS = [
  "LICENSE",
  "onnx/encoder.onnx",
  "onnx/model_q4.onnx",
  "a/b/c/d.bin",
  ".hidden",
  "dir.v2/file",
  "CONSOLE.txt",
  "lpt10",
  "com",
  "my con.txt",
  "x/CONX/y",
  "space in name.txt",
  "naïve/日本語.txt",
  "a.b.c",
  "file-1+2_3",
];

function withPath(p: string): PackManifest {
  const m = e5();
  m.files[0]!.path = p;
  m.license.file = m.files[0]!.path;
  return m;
}

describe("pack file paths", () => {
  for (const p of BAD_PATHS) {
    it(`refuses ${JSON.stringify(p)} in the library, the schema, and the manifest check`, () => {
      expect(isPackFilePath(p)).toBe(false);
      expect(new RegExp(PACK_FILE_PATH_PATTERN, "u").test(p)).toBe(false);
      expect(validate(withPath(p))).toBe(false);
      expect(() => checkPackManifest(withPath(p))).toThrow(PackError);
    });
  }
  for (const p of GOOD_PATHS) {
    it(`accepts ${JSON.stringify(p)} everywhere`, () => {
      expect(isPackFilePath(p)).toBe(true);
      expect(new RegExp(PACK_FILE_PATH_PATTERN, "u").test(p)).toBe(true);
      expect(validate(withPath(p)), JSON.stringify(validate.errors)).toBe(true);
      expect(() => checkPackManifest(withPath(p))).not.toThrow();
    });
  }
  it("puts PACK_FILE_PATH_PATTERN in the schema", () => {
    const files = (schema as { properties: { files: { items: { properties: { path: { pattern: string } } } } } }).properties.files;
    expect(files.items.properties.path.pattern).toBe(PACK_FILE_PATH_PATTERN);
  });
});

describe("checkPackManifest", () => {
  for (const name of ["pack-e5-small.json", "pack-memex-made.json"]) {
    it(`accepts the fixture ${name}`, () => {
      const m = readJson(`contracts/fixtures/packs/${name}`);
      expect(validate(m)).toBe(true);
      expect(checkPackManifest(m)).toBe(m);
    });
  }
  const cases: Array<[string, (m: PackManifest & Record<string, unknown>) => void]> = [
    ["another format", (m) => ((m as { format: string }).format = "memex.pack/2")],
    ["a bad id", (m) => (m.id = "Not An Id")],
    ["the reserved id location", (m) => (m.id = "location")],
    ["a bad version", (m) => (m.version = "-1")],
    ["an unknown kind", (m) => ((m as { kind: string }).kind = "weights")],
    ["memex origin without derivedFrom", (m) => (m.origin = "memex")],
    ["a bad capability", (m) => (m.capabilities = ["Embed Text"])],
    ["no files", (m) => (m.files = [])],
    ["an unknown property", (m) => (m.extra = 1)],
    ["an unknown file property", (m) => ((m.files[0] as unknown as Record<string, unknown>).extra = 1)],
    ["a sha256 in capitals", (m) => (m.files[0]!.sha256 = "ABC")],
    ["an http url", (m) => (m.files[0]!.url = m.files[0]!.url.replace("https:", "http:"))],
    ["a Hugging Face branch url", (m) => (m.files[0]!.url = "https://huggingface.co/intfloat/multilingual-e5-small/resolve/main/LICENSE")],
    ["a short Hugging Face branch url", (m) => (m.files[0]!.url = "https://hf.co/intfloat/multilingual-e5-small/resolve/main/LICENSE")],
    ["bytes as a string", (m) => ((m.files[0] as unknown as Record<string, unknown>).bytes = "12")],
    ["no attribution", (m) => delete (m.license as unknown as Record<string, unknown>).attribution],
    ["no limits", (m) => delete (m.license as unknown as Record<string, unknown>).limits],
    ["a license file that is not a file", (m) => (m.license.file = "NOPE")],
    ["a path listed twice", (m) => m.files.push({ ...m.files[0]! })],
  ];
  for (const [name, change] of cases) {
    it(`refuses ${name}`, () => {
      const m = e5() as PackManifest & Record<string, unknown>;
      change(m);
      expect(() => checkPackManifest(m)).toThrow(PackError);
    });
  }
});

describe("digest", () => {
  it("hashes the sorted lines of sha256 and path", () => {
    const files = [
      { path: "b", sha256: "b".repeat(64) },
      { path: "a", sha256: "a".repeat(64) },
    ];
    const expected = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  a\nbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb  b\n";
    expect(packDigest(files)).toBe(createHash("sha256").update(expected).digest("hex"));
  });
  it("sorts by ordinal byte order", () => {
    const a = packDigest([{ path: "B", sha256: "1".repeat(64) }, { path: "a", sha256: "2".repeat(64) }]);
    const b = packDigest([{ path: "a", sha256: "2".repeat(64) }, { path: "B", sha256: "1".repeat(64) }]);
    expect(a).toBe(b);
  });
  it("names the version folder <id>/<version>-<sha8>", () => {
    const m = e5();
    expect(packFolder(m)).toBe(`${m.id}/${m.version}-${packDigest(m.files).slice(0, 8)}`);
  });
});

describe("pinned urls", () => {
  it("knows a commit from a branch", () => {
    expect(isPinnedUrl("https://huggingface.co/o/r/resolve/0123456789abcdef0123456789abcdef01234567/x")).toBe(true);
    expect(isPinnedUrl("https://huggingface.co/o/r/resolve/main/x")).toBe(false);
    expect(isPinnedUrl("https://github.com/o/r/releases/download/v1/x")).toBe(true);
  });
});
