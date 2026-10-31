import fs from "node:fs/promises";
import path from "node:path";
import { writeFileClosed } from "./closed.js";
import { README_FILE } from "./layout.js";

/** The version of the README text below. Raise it when the text changes, so runs write it again. */
export const README_VERSION = 1;

const MARKER = /<!-- memex-archive readme (\d+) -->/;

export const README_TEXT = `<!-- memex-archive readme ${README_VERSION} -->
# Memex archive

This folder is a Memex archive: the raw originals of one person's data (messages, calls, mail,
contacts, coding sessions, and more), as collectors read them from their sources. It is an open
format: any zip tool and any JSON reader can read it. The full specification is the archive
contract (contracts/archive.md in the memex.core repository).

## Layout

\`\`\`
README.md                                 this file
<domain>/<source>/<device>/
  packs/<yyyy>/<run-id>.zip               one zip pack per collector run (parts: <run-id>.2.zip, ...)
  databases/<name>/<run-id>.<ext>.gz      the latest copies of a source database (three kept)
  index.jsonl                             what the packs hold: one JSON line per item, with metadata
  status.json                             the state of this source: last run, last success, counts
imports/<yyyy-mm-dd>-<name>/              one-time imports, in the same shape
\`\`\`

A run id is the UTC start time of the run and a random suffix, for example
\`20261024T031500Z-3f9a0c1e\`, so run ids sort by time. Files ending in \`.partial\` are
unfinished copies: ignore them.

## Finding things

Start with \`index.jsonl\` of a source. Its first line describes the source and lists its packs.
Each other line is one item:

- \`file\`: a file, with its revisions (which pack and entry holds each one) and \`meta\`.
- \`attachment\`: a media file, stored once under its SHA-256.
- \`records\`: the records of one run, as JSON Lines.
- \`database\`: the snapshots of a source database.
- \`item\`: something that is not a file, for example a chat, with \`meta\`.

\`meta\` is a small JSON object that describes the item (for a coding session: project, first
prompt, times, message counts). Search it to decide what is worth opening.

## Reading a pack

A pack is a standard zip file. \`manifest.json\` inside it describes every entry. With Python:

\`\`\`python
import json, zipfile

with zipfile.ZipFile("packs/2026/20261024T031500Z-3f9a0c1e.zip") as pack:
    manifest = json.loads(pack.read("manifest.json"))
    for entry in manifest["entries"]:
        print(entry["kind"], entry.get("entry"), entry.get("size"))
    records = pack.read("records/records.jsonl").decode("utf-8").splitlines()
\`\`\`

With the Memex tool:

\`\`\`
memex-archive ls code-sessions/editor/main-pc --type file --grep demo
memex-archive cat code-sessions/editor/main-pc home/projects/demo/s1.jsonl --out s1.jsonl
\`\`\`

## How a file is stored

- \`files/<path>\` holds a whole file: the first time it is seen, or after it changed in another way
  than growing.
- \`appends/<path>\` holds only the bytes that were added to the end since the revision before.

The latest version of a file is its last \`files/\` revision followed by every later
\`appends/\` revision, in run order. In the manifest, an append's \`offset\` is the size reached
so far, \`base\` is the SHA-256 reached so far, and \`sha256\` is the SHA-256 of the whole file after
the append. \`memex-archive cat\` joins them and checks each step.

## What the archive does not keep

- No credentials: collectors filter them out.
- No backups: Memex does not make, schedule or check copies of this folder. Back it up with your
  own tool.
- Database snapshots are working copies, and only the latest three are kept. Everything in the
  packs is kept.
`;

/**
 * Writes README.md at the archive root when it is missing or older than README_VERSION.
 * Returns whether it wrote the file.
 */
export async function writeArchiveReadme(root: string): Promise<boolean> {
  const file = path.join(root, README_FILE);
  try {
    const match = MARKER.exec(await fs.readFile(file, "utf8"));
    if (match !== null && Number(match[1]) >= README_VERSION) return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await writeFileClosed(file, README_TEXT);
  return true;
}
