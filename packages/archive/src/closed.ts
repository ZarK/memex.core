import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

export const PARTIAL_SUFFIX = ".partial";

const RENAME_RETRIES = 6;

export class SourceChangedError extends Error {
  readonly code = "source-changed";
  constructor(source: string) {
    super(`The file changed while it was copied: ${source}`);
    this.name = "SourceChangedError";
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Rename, retrying briefly when Windows reports the target busy (a sync client or a virus scanner). */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const busy = code === "EPERM" || code === "EBUSY" || code === "EACCES";
      if (!busy || attempt >= RENAME_RETRIES) throw error;
      await sleep(25 * 2 ** attempt);
    }
  }
}

async function syncDirectory(dir: string): Promise<void> {
  if (process.platform === "win32") return;
  try {
    const handle = await fs.open(dir, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Some file systems do not allow a directory sync. The file itself is already synced.
  }
}

/** True for the error a no-replace closed write throws when the file is already there. */
export function isAlreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "EEXIST";
}

function alreadyExists(file: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(`The file already exists: ${file}`);
  error.code = "EEXIST";
  return error;
}

/**
 * Publishes the partial under the final name without replacing a file that is there: an exists
 * check, then a rename. No hard links: archives live in sync folders (Proton Drive, iCloud Drive,
 * OneDrive), where links are not dependable. The check is enough because the run lock gives one
 * run at a time a source folder, and writeRunChunk reserves its chunk within the process.
 */
async function publishNoReplace(partial: string, file: string): Promise<void> {
  if (await exists(file)) throw alreadyExists(file);
  await renameWithRetry(partial, file);
}

export interface ClosedWriteOptions {
  /**
   * true (the default) replaces an existing file, as status.json needs. false never replaces
   * one: the write then fails with an EEXIST error (see isAlreadyExists).
   */
  replace?: boolean;
}

/**
 * A closed write (contracts/archive.md): write <file>.<pid>-<random>.partial, fsync it, then
 * publish it as <file>. Each write has its own partial, so concurrent writes do not share one.
 * The callback writes the content through the open file handle.
 */
export async function writeClosedWith(
  file: string,
  write: (handle: fs.FileHandle) => Promise<void>,
  beforeRename?: () => void | Promise<void>,
  options: ClosedWriteOptions = {},
): Promise<void> {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true });
  const partial = `${file}.${process.pid}-${randomBytes(6).toString("hex")}${PARTIAL_SUFFIX}`;
  const handle = await fs.open(partial, "wx");
  try {
    try {
      await write(handle);
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    await fs.rm(partial, { force: true });
    throw error;
  }
  if (beforeRename !== undefined) {
    try {
      await beforeRename();
    } catch (error) {
      await fs.rm(partial, { force: true });
      throw error;
    }
  }
  try {
    if (options.replace === false) await publishNoReplace(partial, file);
    else await renameWithRetry(partial, file);
  } catch (error) {
    await fs.rm(partial, { force: true });
    throw error;
  }
  await syncDirectory(dir);
}

/** Writes a whole file with a closed write. */
export async function writeFileClosed(
  file: string,
  data: string | Uint8Array,
  options?: ClosedWriteOptions,
): Promise<void> {
  await writeClosedWith(file, async (handle) => {
    await handle.writeFile(data);
  }, undefined, options);
}

/**
 * Copies a file with a closed write and returns the SHA-256 and size of the bytes written.
 * With expectedSha256, a copy whose bytes differ (the source changed) is not renamed into place.
 */
export async function copyFileClosed(
  source: string,
  file: string,
  expectedSha256?: string,
  options?: ClosedWriteOptions,
): Promise<{ sha256: string; size: number }> {
  const hash = createHash("sha256");
  let size = 0;
  let digest = "";
  await writeClosedWith(file, async (handle) => {
    for await (const chunk of createReadStream(source)) {
      const buffer = chunk as Buffer;
      hash.update(buffer);
      size += buffer.length;
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset);
        offset += bytesWritten;
      }
    }
  }, () => {
    digest = hash.digest("hex");
    if (expectedSha256 !== undefined && digest !== expectedSha256) {
      throw new SourceChangedError(source);
    }
  }, options);
  return { sha256: digest, size };
}

export async function sha256File(file: string): Promise<{ sha256: string; size: number }> {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk as Buffer);
    size += (chunk as Buffer).length;
  }
  return { sha256: hash.digest("hex"), size };
}

export function sha256Bytes(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}
