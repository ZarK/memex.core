import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

const RETRY_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

/** Renames, with a few retries: Windows refuses a rename while a virus scanner or indexer holds a new file for a moment. */
export async function renameWithRetry(from: string, to: string, attempts = 20): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (error) {
      if (attempt >= attempts || !RETRY_CODES.has((error as NodeJS.ErrnoException).code ?? "")) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
    }
  }
}

/** Writes a file whole: a temporary file in the same folder, then a rename (a full replace). */
export async function writeFileWhole(file: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`;
  try {
    await fs.writeFile(temp, text, { flag: "wx" });
    await renameWithRetry(temp, file, 5);
  } finally {
    await fs.rm(temp, { force: true });
  }
}

/** The size and SHA-256 (lowercase hex) of a file. */
export async function hashFile(file: string): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(file, { highWaterMark: 1 << 20 })) {
    bytes += (chunk as Buffer).length;
    hash.update(chunk as Buffer);
  }
  return { bytes, sha256: hash.digest("hex") };
}
