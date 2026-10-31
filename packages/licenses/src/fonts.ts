import fs from "node:fs";
import { brotliDecompressSync, inflateSync } from "node:zlib";

export const FONT_FILE = /\.(ttf|otf|woff2?)$/i;

export interface FontNames {
  family?: string;
  fullName?: string;
  version?: string;
  copyright?: string;
  license?: string;
  licenseUrl?: string;
  manufacturer?: string;
  designer?: string;
}

export class FontReadError extends Error {}

const WOFF2_TAGS = [
  "cmap", "head", "hhea", "hmtx", "maxp", "name", "OS/2", "post", "cvt ", "fpgm", "glyf", "loca", "prep", "CFF ",
  "VORG", "EBDT", "EBLC", "gasp", "hdmx", "kern", "LTSH", "PCLT", "VDMX", "vhea", "vmtx", "BASE", "GDEF", "GPOS",
  "GSUB", "EBSC", "JSTF", "MATH", "CBDT", "CBLC", "COLR", "CPAL", "SVG ", "sbix", "acnt", "avar", "bdat", "bloc",
  "bsln", "cvar", "fdsc", "feat", "fmtx", "fvar", "gvar", "hsty", "just", "lcar", "mort", "morx", "opbd", "prop",
  "trak", "Zapf", "Silf", "Glat", "Gloc", "Feat", "Sill",
];

/** The bytes of the font's name table. */
function nameTable(buf: Buffer): Buffer {
  const sig = buf.toString("latin1", 0, 4);
  if (sig === "wOFF") {
    const num = buf.readUInt16BE(12);
    for (let i = 0; i < num; i++) {
      const p = 44 + i * 20;
      if (buf.toString("latin1", p, p + 4) !== "name") continue;
      const offset = buf.readUInt32BE(p + 4);
      const compLength = buf.readUInt32BE(p + 8);
      const origLength = buf.readUInt32BE(p + 12);
      const data = buf.subarray(offset, offset + compLength);
      return compLength < origLength ? inflateSync(data) : data;
    }
    throw new FontReadError("no name table");
  }
  if (sig === "wOF2") {
    const num = buf.readUInt16BE(12);
    const totalCompressed = buf.readUInt32BE(20);
    let p = 48;
    const base128 = (): number => {
      let v = 0;
      for (let i = 0; i < 5; i++) {
        const b = buf[p++]!;
        v = v * 128 + (b & 0x7f);
        if ((b & 0x80) === 0) return v;
      }
      throw new FontReadError("bad UIntBase128");
    };
    let offset = 0;
    let target: { offset: number; length: number } | null = null;
    for (let i = 0; i < num; i++) {
      const flags = buf[p++]!;
      const tagIndex = flags & 0x3f;
      let tagName: string;
      if (tagIndex === 63) {
        tagName = buf.toString("latin1", p, p + 4);
        p += 4;
      } else tagName = WOFF2_TAGS[tagIndex] ?? "????";
      const transform = (flags >> 6) & 3;
      const origLength = base128();
      const isGlyfLoca = tagName === "glyf" || tagName === "loca";
      const transformed = isGlyfLoca ? transform !== 3 : transform !== 0;
      const length = transformed ? base128() : origLength;
      if (tagName === "name") target = { offset, length };
      offset += length;
    }
    if (buf.toString("latin1", 4, 8) === "ttcf") throw new FontReadError("font collections are not supported");
    if (target === null) throw new FontReadError("no name table");
    const stream = brotliDecompressSync(buf.subarray(p, p + totalCompressed));
    return stream.subarray(target.offset, target.offset + target.length);
  }
  const flavor = buf.readUInt32BE(0);
  if (flavor !== 0x00010000 && sig !== "OTTO" && sig !== "true") throw new FontReadError("not a TrueType, OpenType or WOFF font");
  const num = buf.readUInt16BE(4);
  for (let i = 0; i < num; i++) {
    const p = 12 + i * 16;
    if (buf.toString("latin1", p, p + 4) !== "name") continue;
    const offset = buf.readUInt32BE(p + 8);
    const length = buf.readUInt32BE(p + 12);
    return buf.subarray(offset, offset + length);
  }
  throw new FontReadError("no name table");
}

function decodeUtf16be(b: Buffer): string {
  const swapped = Buffer.from(b);
  swapped.swap16();
  return swapped.toString("utf16le");
}

/** Reads the copyright, license and names from a TrueType, OpenType, WOFF or WOFF2 font. */
export function readFontNames(file: string): FontNames {
  const buf = fs.readFileSync(file);
  if (buf.length < 12) throw new FontReadError("file too short");
  const t = nameTable(buf);
  const count = t.readUInt16BE(2);
  const strings = t.readUInt16BE(4);
  const best = new Map<number, { score: number; value: string }>();
  for (let i = 0; i < count; i++) {
    const p = 6 + i * 12;
    if (p + 12 > t.length) break;
    const platform = t.readUInt16BE(p);
    const encoding = t.readUInt16BE(p + 2);
    const language = t.readUInt16BE(p + 4);
    const nameId = t.readUInt16BE(p + 6);
    const length = t.readUInt16BE(p + 8);
    const offset = t.readUInt16BE(p + 10);
    const raw = t.subarray(strings + offset, strings + offset + length);
    let value: string;
    let score: number;
    if (platform === 3 && (encoding === 1 || encoding === 10)) {
      value = decodeUtf16be(raw);
      score = language === 0x409 ? 3 : 2;
    } else if (platform === 0) {
      value = decodeUtf16be(raw);
      score = 2;
    } else if (platform === 1 && encoding === 0) {
      value = raw.toString("latin1");
      score = language === 0 ? 1 : 0;
    } else continue;
    const prev = best.get(nameId);
    if (prev === undefined || score > prev.score) best.set(nameId, { score, value: value.replace(/\u0000/g, "").trim() });
  }
  const get = (id: number) => best.get(id)?.value || undefined;
  return {
    copyright: get(0),
    family: get(16) ?? get(1),
    fullName: get(4),
    version: get(5),
    manufacturer: get(8),
    designer: get(9),
    license: get(13),
    licenseUrl: get(14),
  };
}

/** The SPDX id that a font's license description or URL names, or null. */
export function fontLicenseId(names: FontNames): string | null {
  const text = `${names.license ?? ""} ${names.licenseUrl ?? ""}`;
  if (/open font licen[cs]e|scripts\.sil\.org\/ofl|openfontlicense\.org|\bOFL\b/i.test(text)) return "OFL-1.1";
  if (/apache licen[cs]e|apache\.org\/licenses\/LICENSE-2\.0/i.test(text)) return "Apache-2.0";
  if (/ubuntu font licen[cs]e/i.test(text)) return "LicenseRef-Ubuntu-Font-1.0";
  if (/creativecommons\.org\/publicdomain\/zero|CC0/i.test(text)) return "CC0-1.0";
  if (/\bMIT licen[cs]e\b|opensource\.org\/licenses\/MIT/i.test(text)) return "MIT";
  return null;
}
