import fs from "node:fs/promises";
import path from "node:path";
import { writeFileWhole } from "./write.js";

/** The version of the README text below. Raise it when the text changes, so apps write it again. */
export const MEMEX_README_VERSION = 1;

const MARKER = /memex-readme (\d+)/;

export const MEMEX_README_TEXT = `This is your Memex folder.

Each Memex app keeps your data in its own folder here: Photos, Study, Finance, Health, and the others.
This is everything you would lose: databases, settings, corrections, and the files you made.

Back up this folder with your own tool. Memex does not make, schedule, or check backups.
Close the Memex apps before you copy this folder, so that no database is copied in the middle of a write.

Caches, logs, and downloaded models are not in here. They are in your system's cache and app folders,
and the apps can make or download them again.

Keep this folder out of OneDrive, Dropbox, iCloud Drive, and other sync clients: a sync client can copy
a database while an app writes to it. The archive folder is the exception; it is made to be synchronized.

Your photos, documents, and other source files are not in here. They stay where they are.

memex-readme ${MEMEX_README_VERSION}
`;

/**
 * Writes README.txt in the Memex root (memexRoot()) when it is missing or has a memex-readme line older than
 * MEMEX_README_VERSION. A README.txt without that line is the user's own file and stays as it is. Makes the root.
 * Returns whether it wrote the file.
 */
export async function writeMemexReadme(root: string, options: { platform?: string } = {}): Promise<boolean> {
  const file = path.join(root, "README.txt");
  try {
    const match = MARKER.exec(await fs.readFile(file, "utf8"));
    if (match === null || Number(match[1]) >= MEMEX_README_VERSION) return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const text = (options.platform ?? process.platform) === "win32" ? MEMEX_README_TEXT.replace(/\n/g, "\r\n") : MEMEX_README_TEXT;
  await writeFileWhole(file, text);
  return true;
}
