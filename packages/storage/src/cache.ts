import fs from "node:fs/promises";
import path from "node:path";

/** The signature that starts every cache directory tag (https://bford.info/cachedir/). */
export const CACHEDIR_SIGNATURE = "Signature: 8a477f597d28d172789f06886806bc55";

export const CACHEDIR_TAG_TEXT =
  `${CACHEDIR_SIGNATURE}\n` +
  "# This file is a cache directory tag created by Memex.\n" +
  "# The files in this folder can be made again. Backup tools can leave this folder out.\n" +
  "# For information about cache directory tags, see https://bford.info/cachedir/\n";

/** The macOS marker that keeps Spotlight from indexing a folder. */
export const SPOTLIGHT_MARKER = ".metadata_never_index";

async function writeIfMissing(file: string, text: string, valid: (current: string) => boolean): Promise<boolean> {
  try {
    if (valid(await fs.readFile(file, "utf8"))) return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await fs.writeFile(file, text);
  return true;
}

/**
 * Marks a folder as a cache, so that backup tools and indexers leave it out. Makes the folder. Writes
 * CACHEDIR.TAG (restic, Borg, tar, and other tools honor it), and on macOS also .metadata_never_index (Spotlight).
 * Time Machine already leaves out ~/Library/Caches, the default cache root on macOS; a cache folder somewhere else
 * needs `tmutil addexclusion`, which this function does not run. Returns the files it wrote.
 */
export async function markCacheFolder(dir: string, options: { platform?: string } = {}): Promise<string[]> {
  await fs.mkdir(dir, { recursive: true });
  const written: string[] = [];
  const tag = path.join(dir, "CACHEDIR.TAG");
  if (await writeIfMissing(tag, CACHEDIR_TAG_TEXT, (t) => t.startsWith(CACHEDIR_SIGNATURE))) written.push(tag);
  if ((options.platform ?? process.platform) === "darwin") {
    const marker = path.join(dir, SPOTLIGHT_MARKER);
    if (await writeIfMissing(marker, "", () => true)) written.push(marker);
  }
  return written;
}
