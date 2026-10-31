import { createHash } from "node:crypto";
import path from "node:path";
import { readIndex } from "./index-file.js";
import { ArchiveError } from "./layout.js";
import { openPack, type Pack } from "./pack.js";

/**
 * A file as it was at its latest revision, or at the given run, as a stream: its last full
 * revision at or before that run, followed by the later appends in run order. Each append must
 * start at the size reached so far, and its base must be the SHA-256 reached so far; the manifests
 * are checked before the first byte. The SHA-256 after each revision is checked as its bytes pass,
 * so a mismatch fails the stream at the end of that revision, after its bytes were yielded.
 * A file of any size passes through without being held in memory.
 */
export async function openFileVersion(dir: string, id: string, options: { run?: string } = {}): Promise<AsyncIterable<Buffer>> {
  const index = await readIndex(dir);
  const file = index?.files.find((f) => f.id === id);
  if (file === undefined) throw new ArchiveError("not-found", `No file ${id} in ${dir}`);
  const revisions = file.revisions.filter((r) => options.run === undefined || r.run <= options.run);
  let start = -1;
  for (let i = revisions.length - 1; i >= 0; i--) {
    if (revisions[i]!.kind === "full") {
      start = i;
      break;
    }
  }
  if (start < 0) throw new ArchiveError("not-found", `No full revision of ${id}${options.run ? ` at run ${options.run}` : ""}`);

  const packs = new Map<string, Pack>();
  const pack = async (rel: string): Promise<Pack> => {
    let p = packs.get(rel);
    if (p === undefined) {
      p = await openPack(path.join(dir, ...rel.split("/")));
      packs.set(rel, p);
    }
    return p;
  };
  const mismatch = (message: string) => new ArchiveError("version-mismatch", `${id}: ${message}`);

  // The chain as the manifests describe it: every append starts where the revision before it ends.
  const chain = revisions.slice(start);
  let size = 0;
  let sha256 = "";
  for (const r of chain) {
    const described = (await pack(r.file)).manifest.entries.find((e) => "entry" in e && e.entry === r.entry);
    if (described === undefined) throw mismatch(`${r.file} does not describe ${r.entry}`);
    if (described.kind === "append") {
      if (described.offset !== size) throw mismatch(`the append in ${r.file} starts at ${described.offset}, not at ${size}`);
      if (described.base !== sha256) throw mismatch(`the append in ${r.file} does not follow the revision before it`);
      size += described.size;
    } else if (described.kind === "full") {
      size = described.size;
    } else {
      throw mismatch(`${r.entry} in ${r.file} is not a file revision`);
    }
    sha256 = r.sha256;
  }

  return (async function* () {
    const hash = createHash("sha256");
    for (const r of chain) {
      for await (const chunk of await (await pack(r.file)).open(r.entry)) {
        hash.update(chunk as Buffer);
        yield chunk as Buffer;
      }
      if (hash.copy().digest("hex") !== r.sha256) throw mismatch(`the SHA-256 after ${r.entry} in ${r.file} does not match`);
    }
  })();
}

/**
 * A file as it was at its latest revision, or at the given run (see openFileVersion), read into
 * memory. Use openFileVersion for a file too large to hold in memory.
 */
export async function readFileVersion(dir: string, id: string, options: { run?: string } = {}): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of await openFileVersion(dir, id, options)) chunks.push(chunk);
  return Buffer.concat(chunks);
}
