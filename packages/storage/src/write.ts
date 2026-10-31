import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * Writes a file whole: to a .partial file next to it, then renamed over it, so a reader never sees half a file.
 * Makes the parent folder.
 */
export async function writeFileWhole(file: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const partial = `${file}.${process.pid}-${randomBytes(4).toString("hex")}.partial`;
  try {
    await fs.writeFile(partial, text, { flag: "wx" });
    for (let attempt = 0; ; attempt++) {
      try {
        await fs.rename(partial, file);
        return;
      } catch (error) {
        // Windows refuses the rename while another process has the file open for a moment.
        const code = (error as NodeJS.ErrnoException).code;
        if (attempt >= 4 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
      }
    }
  } finally {
    await fs.rm(partial, { force: true });
  }
}
