import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { LicenseFile } from "./types.js";

export const LICENSE_FILE = /^(licen[cs]e|copying|notice|copyright|third[-_ ]?party[-_ ]?notices?|thirdpartynotices|ofl|unlicense|authors)([-_. ].*)?$/i;

export function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
}

export function tryReadJson(file: string): unknown {
  try {
    return readJson(file);
  } catch {
    return undefined;
  }
}

export function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

export function realpath(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
}

/** Reads a text file as UTF-8 or UTF-16 with a byte order mark. */
export function readText(file: string): string {
  const buf = fs.readFileSync(file);
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString("utf16le");
  if (buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.subarray(2));
    swapped.swap16();
    return swapped.toString("utf16le");
  }
  return buf.toString("utf8").replace(/^﻿/, "");
}

export function licenseFileFromPath(file: string, name = path.basename(file)): LicenseFile {
  const data = fs.readFileSync(file);
  return { name, path: file, bytes: data.length, sha256: sha256(data) };
}

export function licenseFileFromText(name: string, text: string): LicenseFile {
  const data = Buffer.from(text, "utf8");
  return { name, text, bytes: data.length, sha256: sha256(data) };
}

/** The license, notice and copyright files at the top of a folder, sorted by name. */
export function licenseFilesIn(dir: string): LicenseFile[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: LicenseFile[] = [];
  for (const name of names.sort()) {
    if (!LICENSE_FILE.test(name)) continue;
    if (/\.(js|cjs|mjs|ts|json|d\.ts|map|png|svg)$/i.test(name)) continue;
    const full = path.join(dir, name);
    if (!isFile(full)) continue;
    out.push(licenseFileFromPath(full));
  }
  return out;
}

/** The text of a license file, from disk or from memory. Returns "" for an HTML or binary file. */
export function licenseText(file: LicenseFile): string {
  if (file.text !== undefined) return file.text;
  if (file.path === undefined) return "";
  if (/\.html?$/i.test(file.name)) return "";
  return readText(file.path);
}

export function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

/** A path relative to the root, with forward slashes. */
export function rel(root: string, p: string): string {
  const r = toPosix(path.relative(root, p));
  if (r.startsWith("..") || path.isAbsolute(r)) return toPosix(path.resolve(p));
  return r === "" ? "." : r;
}

/** A file or folder name that is safe on Windows, macOS and Linux. */
export function safeName(s: string): string {
  return s.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "+").replace(/[. ]+$/, "_").slice(0, 120) || "_";
}

export interface WalkOptions {
  skipDir: (name: string, full: string) => boolean;
}

/** Every file under a folder. It does not follow links. */
export function walkFiles(dir: string, options: WalkOptions, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) {
      if (!options.skipDir(e.name, full)) walkFiles(full, options, out);
    } else if (e.isFile()) out.push(full);
  }
  return out;
}
