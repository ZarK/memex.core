import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { isAccepted, type AcceptancesOptions } from "./acceptances.js";
import { hashFile, renameWithRetry, writeFileWhole } from "./files.js";
import { acquireLockFile, acquireStoreLock, type HeldLockFile } from "./lock.js";
import {
  MANIFEST_FILE,
  PackError,
  STORE_FORMAT,
  checkPackManifest,
  isLicenseUnknown,
  licenseFile,
  packBytes,
  packDigest,
  packFolder,
  type PackFile,
  type PackManifest,
} from "./manifest.js";
import { STAGING_FOLDER, STORE_INDEX, packStoreFolder, resolvePack, type ResolvedPack } from "./store.js";

/** The download lock in a staging folder, as Memex.Node names it: one download writes a staging folder at a time. */
export const DOWNLOAD_LOCK = ".download.lock";

export interface StageOptions {
  /** The store folder. Default packStoreFolder(). */
  root?: string;
  /** Where acceptances are read for a license that needs acceptance. Default Memex.Node's acceptances.json. */
  acceptances?: AcceptancesOptions;
  /** The program name in the download lock and the store lock. Default "memex-packs". */
  program?: string;
}

/** The staging folders that a download of this process writes now: a second stagePack of one gets install_busy. */
const stagingGates = new Set<string>();

/** A pack version that downloads into .staging/<id>/<version>-<sha8>/. */
export interface StagedPack {
  readonly root: string;
  readonly manifest: PackManifest;
  readonly digest: string;
  /** <id>/<version>-<sha8>. */
  readonly folder: string;
  /** The absolute staging folder. */
  readonly staging: string;
  /** Where a file of the pack goes in the staging folder. */
  filePath(file: PackFile): string;
  /** Where a file downloads first: <file>.part. A rename gives it its name once its size and SHA-256 match. */
  partPath(file: PackFile): string;
  /** Lets go of the staging folder without activating it. The files stay, so a later run continues. */
  close(): Promise<void>;
}

class Staged implements StagedPack {
  #lock: HeldLockFile | null;
  #gate: string | null;
  constructor(
    readonly root: string,
    readonly manifest: PackManifest,
    readonly digest: string,
    readonly folder: string,
    readonly staging: string,
    lock: HeldLockFile,
    gate: string,
  ) {
    this.#lock = lock;
    this.#gate = gate;
  }
  filePath(file: PackFile): string {
    // checkPackManifest refused a path that leaves the folder; this is the second guard, where the files are written.
    const base = path.resolve(this.staging) + path.sep;
    const full = path.resolve(base, ...file.path.split("/"));
    if (!full.startsWith(base) || full.length === base.length) {
      throw new PackError("invalid_manifest", `The pack file path '${file.path}' is not inside the pack folder.`);
    }
    return full;
  }
  partPath(file: PackFile): string {
    return `${this.filePath(file)}.part`;
  }
  /** Closes and removes the download lock, as Memex.Node does before it renames the folder. The gate stays held. */
  async releaseLockFile(): Promise<void> {
    if (this.#lock === null) return;
    const lock = this.#lock;
    this.#lock = null;
    await lock.release().catch(() => undefined);
  }
  async close(): Promise<void> {
    await this.releaseLockFile();
    if (this.#gate !== null) stagingGates.delete(this.#gate);
    this.#gate = null;
  }
}

/**
 * Steps 1 and 2 of the install: the manifest with Memex.Node's rules, a license that is known, and an acceptance of
 * the license text when the license needs one. Nothing is staged or downloaded before these pass.
 */
async function checkBeforeDownload(manifestValue: unknown, options: StageOptions): Promise<PackManifest> {
  const manifest = checkPackManifest(manifestValue);
  if (isLicenseUnknown(manifest)) {
    throw new PackError(
      "license_unknown",
      `${manifest.id} ${manifest.version} is not installed: its license is unknown (spdx ${manifest.license.spdx}, commercial use ${manifest.license.commercial}).`,
      `The publisher states the license at ${manifest.license.url}. A manifest with a known license is needed.`,
    );
  }
  await requireAcceptance(manifest, options.acceptances);
  return manifest;
}

async function requireAcceptance(manifest: PackManifest, acceptances: AcceptancesOptions | undefined): Promise<void> {
  if (manifest.license.acceptance !== "required") return;
  const text = licenseFile(manifest)!;
  if (!(await isAccepted(manifest.id, text.sha256, acceptances))) {
    throw new PackError(
      "acceptance_required",
      `The license of ${manifest.id} ${manifest.version} (${manifest.license.spdx}) must be accepted before the download.`,
      "Show the license text to the user and record the acceptance (recordAcceptance, or Memex.Node's POST /v1/packs/{id}/accept).",
    );
  }
}

/**
 * Starts or continues the install of a pack version (contracts/packs.md, Install, steps 1 to 3 and 5): checks the
 * manifest with Memex.Node's rules, refuses a license that is unknown or not accepted, makes the staging folder,
 * takes its download lock, and writes memex.pack.json there, so that Memex.Node lists the version while it downloads.
 *
 * The download lock is made with an exclusive create and holds the holder JSON of .lock: another download of the same
 * version (in this process or another one) gets install_busy, and a lock whose process is gone is taken over. On
 * Windows, the open lock also keeps Memex.Node out of the folder. On macOS and Linux, Node's lock is advisory and this
 * library cannot take it, so do not let Node and this writer install the same pack version at the same time there.
 */
export async function stagePack(manifestValue: unknown, options: StageOptions = {}): Promise<StagedPack> {
  const manifest = await checkBeforeDownload(manifestValue, options);
  return stageChecked(manifest, options);
}

async function stageChecked(manifest: PackManifest, options: StageOptions): Promise<Staged> {
  const root = options.root ?? packStoreFolder().path;
  const folder = packFolder(manifest);
  const staging = path.join(root, STAGING_FOLDER, ...folder.split("/"));
  const gate = path.resolve(staging).toLowerCase();
  const busy = () => new PackError("install_busy", `Another program downloads ${manifest.id} ${manifest.version} now.`);
  if (stagingGates.has(gate)) throw busy();
  stagingGates.add(gate);
  try {
    await fs.mkdir(staging, { recursive: true });
    let lock: HeldLockFile;
    try {
      lock = await acquireLockFile(path.join(staging, DOWNLOAD_LOCK), { program: options.program ?? "memex-packs", waitMs: 0, keepOpen: true, busy });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EBUSY" || code === "EPERM" || code === "EACCES") throw busy();
      throw error;
    }
    try {
      const manifestPath = path.join(staging, MANIFEST_FILE);
      if (!(await exists(manifestPath))) await writeFileWhole(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    } catch (error) {
      await lock.release();
      throw error;
    }
    return new Staged(root, manifest, packDigest(manifest.files), folder, staging, lock, gate);
  } catch (error) {
    stagingGates.delete(gate);
    throw error;
  }
}

export interface FileCheck {
  path: string;
  state: "ok" | "missing" | "wrong-size" | "wrong-sha256";
  bytes?: number;
}

/** Checks the size and the SHA-256 of each file in the staging folder (step 4). */
export async function checkStaged(staged: StagedPack): Promise<FileCheck[]> {
  const out: FileCheck[] = [];
  for (const file of staged.manifest.files) out.push(await checkFile(file, staged.filePath(file)));
  return out;
}

async function checkFile(file: PackFile, target: string): Promise<FileCheck> {
  let stat;
  try {
    stat = await fs.stat(target);
  } catch {
    return { path: file.path, state: "missing" };
  }
  if (!stat.isFile()) return { path: file.path, state: "missing" };
  if (stat.size !== file.bytes) return { path: file.path, state: "wrong-size", bytes: stat.size };
  const { sha256 } = await hashFile(target);
  return { path: file.path, state: sha256 === file.sha256 ? "ok" : "wrong-sha256", bytes: stat.size };
}

export interface ActivateOptions {
  /** Where acceptances are read for a license that needs acceptance. Default Memex.Node's acceptances.json. */
  acceptances?: AcceptancesOptions;
  /** The program name in the store lock. Default "memex-packs". */
  program?: string;
  /** How long to wait for the store lock. Default 30 s. */
  lockWaitMs?: number;
  now?: () => Date;
}

/**
 * Activates a staged pack version (steps 2, 6 and 7): every file must have its size and SHA-256, and a license that
 * needs acceptance must be accepted (acceptance_required). Then, under .lock, the staging folder becomes
 * <id>/<version>-<sha8>/ and packs.json names it, written whole by a rename. When the version is installed already (by
 * Memex.Node or another program), the installed folder stays as it is and the staged copy goes.
 */
export async function activatePack(staged: StagedPack, options: ActivateOptions = {}): Promise<ResolvedPack> {
  const { manifest } = staged;
  const bad = (await checkStaged(staged)).filter((c) => c.state !== "ok");
  if (bad.length > 0) {
    throw new PackError("files_incomplete", `${manifest.id} ${manifest.version} is not complete: ${bad.map((b) => `${b.path} ${b.state}`).join(", ")}.`);
  }
  // The second guard: stagePack checked the acceptance before the download too.
  await requireAcceptance(manifest, options.acceptances);
  return activateVersion(staged.root, manifest, staged, options);
}

/**
 * Steps 6 and 7 under .lock. With a staged copy, the staging folder becomes <id>/<version>-<sha8>/, unless that folder
 * is installed already: then the installed folder stays as it is and the staged copy goes. Without one, the version
 * must be installed already, and only packs.json changes, as Memex.Node does for an installed version.
 */
async function activateVersion(root: string, manifest: PackManifest, staged: StagedPack | null, options: ActivateOptions): Promise<ResolvedPack> {
  const folder = packFolder(manifest);
  const target = path.join(root, ...folder.split("/"));
  const lock = await acquireStoreLock(root, { program: options.program, waitMs: options.lockWaitMs });
  try {
    const installed = await exists(path.join(target, MANIFEST_FILE));
    if (staged !== null) {
      if (installed) {
        // Another program installed the same bytes first. Its folder never changes; this copy goes.
        await staged.close();
        await fs.rm(staged.staging, { recursive: true, force: true });
      } else {
        // A folder without a manifest is a broken earlier attempt.
        await fs.rm(target, { recursive: true, force: true });
        await fs.mkdir(path.dirname(target), { recursive: true });
        // Memex.Node renames the folder with the download lock closed and removed; the gate of this process stays held.
        if (staged instanceof Staged) await staged.releaseLockFile();
        else await staged.close();
        await renameWithRetry(staged.staging, target);
      }
      await removeIfEmpty(path.dirname(staged.staging));
      await removeIfEmpty(path.join(root, STAGING_FOLDER));
    } else if (!installed) {
      throw new PackError("invalid_store", `${folder} is not installed.`);
    }
    const index = await readIndexForWrite(root);
    index.packs[manifest.id] = {
      version: manifest.version,
      digest: packDigest(manifest.files),
      folder,
      activatedAt: (options.now?.() ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z"),
    };
    await writeFileWhole(path.join(root, STORE_INDEX), JSON.stringify(index, null, 2) + "\n");
  } finally {
    await lock.release();
    if (staged !== null) await staged.close();
  }
  const resolved = await resolvePack(manifest.id, { root });
  if (resolved === null) throw new PackError("invalid_store", `${folder} is not in the store after the activation.`);
  return resolved;
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

/** packs.json as a plain object, with entries and keys that this version does not know kept. */
async function readIndexForWrite(root: string): Promise<{ format: string; packs: Record<string, unknown> } & Record<string, unknown>> {
  const file = path.join(root, STORE_INDEX);
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { format: STORE_FORMAT, packs: {} };
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new PackError("invalid_store", `${file} is not valid JSON: ${(error as Error).message}`);
  }
  const v = value as { format?: unknown; packs?: unknown } | null;
  if (typeof v !== "object" || v === null || v.format !== STORE_FORMAT || typeof v.packs !== "object" || v.packs === null || Array.isArray(v.packs)) {
    throw new PackError("invalid_store", `${file} must have "format": "${STORE_FORMAT}" and an object "packs".`);
  }
  return v as { format: string; packs: Record<string, unknown> };
}

async function removeIfEmpty(folder: string): Promise<void> {
  try {
    await fs.rmdir(folder);
  } catch {
    // not empty, or gone
  }
}

// ---------- a whole install with the app's own downloader ----------

export interface InstallProgress {
  file: string | null;
  bytesDone: number;
  bytesTotal: number;
  phase: "downloading" | "verifying" | "activating" | "done";
}

/**
 * Appends the bytes of url from the byte `from` to its end (`bytes` in all) to target, which may hold bytes of other
 * parts before them. Report each appended chunk with progress(bytes).
 */
export type Downloader = (request: { url: string; target: string; from: number; bytes: number; signal?: AbortSignal; progress: (bytes: number) => void }) => Promise<void>;

export interface InstallOptions extends StageOptions, ActivateOptions {
  /** The downloader. Default fetchDownloader (fetch with range requests). */
  download?: Downloader;
  onProgress?: (progress: InstallProgress) => void;
  signal?: AbortSignal;
}

/**
 * Installs a pack with the app's own downloader, in the layout and under the locks of Memex.Node (contracts/packs.md,
 * Install): stage, download each file into <file>.part (continuing a part that an earlier run left), check its size
 * and SHA-256 (a mismatch is downloaded again one time; a second one stops the install), rename it, and activate.
 */
export async function installPack(manifestValue: unknown, options: InstallOptions = {}): Promise<ResolvedPack> {
  const manifest = await checkBeforeDownload(manifestValue, options);
  const root = options.root ?? packStoreFolder().path;
  if (await exists(path.join(root, ...packFolder(manifest).split("/"), MANIFEST_FILE))) {
    // This version is installed already (by Memex.Node or an earlier run): only activate it, as Node does.
    const total = packBytes(manifest);
    options.onProgress?.({ file: null, bytesDone: total, bytesTotal: total, phase: "activating" });
    const resolved = await activateVersion(root, manifest, null, options);
    options.onProgress?.({ file: null, bytesDone: total, bytesTotal: total, phase: "done" });
    return resolved;
  }
  const staged = await stageChecked(manifest, { ...options, root });
  const download = options.download ?? fetchDownloader;
  const total = packBytes(staged.manifest);
  let done = 0;
  const report = (phase: InstallProgress["phase"], file: string | null) => options.onProgress?.({ file, bytesDone: done, bytesTotal: total, phase });
  try {
    for (const file of staged.manifest.files) {
      const target = staged.filePath(file);
      if ((await checkFile(file, target)).state === "ok") {
        done += file.bytes;
        report("downloading", file.path);
        continue;
      }
      await fs.rm(target, { force: true });
      await fs.mkdir(path.dirname(target), { recursive: true });
      const part = staged.partPath(file);
      for (let attempt = 1; ; attempt++) {
        const before = done;
        await downloadFile(file, part, download, options.signal, (fileBytes) => {
          done = before + fileBytes;
          report("downloading", file.path);
        });
        report("verifying", file.path);
        const check = await checkFile(file, part);
        if (check.state === "ok") {
          await renameWithRetry(part, target);
          done = before + file.bytes;
          break;
        }
        await fs.rm(part, { force: true });
        done = before;
        if (attempt >= 2) {
          throw new PackError("checksum_mismatch", `${file.path} of ${staged.manifest.id} does not match its manifest twice (${check.state}).`);
        }
      }
    }
    report("activating", null);
    const resolved = await activatePack(staged, options);
    report("done", null);
    return resolved;
  } finally {
    await staged.close();
  }
}

/**
 * Downloads a file into part, continuing what is there. A file with parts is joined in order; an interrupted part
 * starts again at its own first byte. progress gets the bytes of the file in part so far.
 */
async function downloadFile(file: PackFile, part: string, download: Downloader, signal: AbortSignal | undefined, progress: (fileBytes: number) => void): Promise<void> {
  let have = 0;
  try {
    have = (await fs.stat(part)).size;
  } catch {
    have = 0;
  }
  if (have > file.bytes) {
    await fs.writeFile(part, "");
    have = 0;
  }
  const pieces = file.parts ?? [{ url: file.url, bytes: file.bytes, sha256: file.sha256 }];
  let start = 0;
  for (const piece of pieces) {
    const end = start + piece.bytes;
    if (have < end) {
      // Continue inside a single file; with parts, cut back to the first byte of this part.
      const from = pieces.length === 1 ? have : 0;
      if (have !== start + from) await fs.truncate(part, start + from);
      let current = start + from;
      progress(current);
      await download({
        url: piece.url,
        target: part,
        from,
        bytes: piece.bytes,
        signal,
        progress: (n) => {
          current += n;
          progress(current);
        },
      });
      have = end;
    }
    start = end;
  }
}

/**
 * The default downloader: fetch, with a range request to continue a partial file. When a server ignores the range,
 * the bytes before `from` are skipped.
 */
export const fetchDownloader: Downloader = async ({ url, target, from, bytes, signal, progress }) => {
  if (from >= bytes) return;
  const headers: Record<string, string> = {};
  if (from > 0) headers.range = `bytes=${from}-`;
  const res = await fetch(url, { headers, redirect: "follow", signal });
  if (!res.ok || res.body === null) throw new PackError("download_failed", `Downloading ${url} failed: HTTP ${res.status}.`);
  let skip = from > 0 && res.status !== 206 ? from : 0;
  const out = createWriteStream(target, { flags: "a" });
  const body = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream<Uint8Array>);
  async function* skipped(source: AsyncIterable<Buffer>) {
    for await (const chunk of source) {
      let c = chunk;
      if (skip > 0) {
        const n = Math.min(skip, c.length);
        skip -= n;
        c = c.subarray(n);
      }
      if (c.length > 0) {
        progress(c.length);
        yield c;
      }
    }
  }
  await pipeline(body, skipped, out, { signal });
};
