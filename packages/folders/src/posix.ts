import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { SF_DATALESS } from "./attributes.js";
import { fileSystemName } from "./keys.js";
import type { ListingBackend, RawEntry, RawFolder, VolumeFacts } from "./types.js";
import { probeIgnoresCase } from "./windows.js";

const decoder = new TextDecoder("utf-8", { fatal: true });
const STAT_CONCURRENCY = 32;
const FLAGS_BATCH = 100;

function hex16(value: bigint): string {
  return value.toString(16).padStart(16, "0");
}

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

/**
 * The BSD file flags of files on macOS, from /usr/bin/stat -f %Xf (one hex number per file). Node.js does not
 * give st_flags. Returns null when stat fails; the caller then treats the files as online-only.
 */
export async function readMacFlags(paths: string[], runStat: (args: string[]) => Promise<string> = (args) => run("/usr/bin/stat", args)): Promise<number[] | null> {
  const out: number[] = [];
  for (let i = 0; i < paths.length; i += FLAGS_BATCH) {
    const batch = paths.slice(i, i + FLAGS_BATCH);
    let text: string;
    try {
      text = await runStat(["-f", "%Xf", "--", ...batch]);
    } catch {
      return null;
    }
    const lines = text.split("\n").filter((l) => l.trim() !== "");
    if (lines.length !== batch.length) return null;
    for (const line of lines) {
      const value = Number.parseInt(line.trim(), 16);
      if (!Number.isFinite(value)) return null;
      out.push(value);
    }
  }
  return out;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

/** The mount type that holds a path, from /proc/self/mounts (Linux) or mount's output (macOS). */
function mountType(text: string, target: string, darwin: boolean): string {
  let best: { point: string; type: string } | null = null;
  for (const line of text.split("\n")) {
    let point: string;
    let type: string;
    if (darwin) {
      const m = /^.+? on (.+) \(([^,)]+)/.exec(line);
      if (m === null) continue;
      point = m[1]!;
      type = m[2]!;
    } else {
      const fields = line.trim().split(/\s+/);
      if (fields.length < 3) continue;
      point = fields[1]!.replace(/\\([0-7]{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8)));
      type = fields[2]!;
    }
    const inside = point === "/" || target === point || target.startsWith(point.endsWith("/") ? point : `${point}/`);
    if (inside && (best === null || point.length >= best.point.length)) best = { point, type };
  }
  return best?.type ?? "unknown";
}

/**
 * The backend for Linux, macOS, and other POSIX systems: readdir and lstat. On macOS a file whose size is not 0 but
 * whose blocks are 0 may be dataless; its flags are read to confirm (SF_DATALESS). When they cannot be read, the
 * file counts as online-only, so that the app asks before reading it.
 */
export function posixBackend(platform: string = process.platform): ListingBackend {
  const darwin = platform === "darwin";
  return {
    platform,
    async readFolder(absolutePath: string): Promise<RawFolder> {
      let folderStat: import("node:fs").BigIntStats;
      let dirents: import("node:fs").Dirent<Buffer>[];
      try {
        folderStat = await fs.stat(absolutePath, { bigint: true });
        dirents = await fs.readdir(absolutePath, { withFileTypes: true, encoding: "buffer" });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        return { complete: false, code: code === "ENOENT" ? "missing" : "unreadable", error: (error as Error).message };
      }
      const named = dirents.map((d) => {
        let name: string;
        let invalidName = false;
        try {
          name = decoder.decode(d.name);
        } catch {
          name = d.name.toString("utf8");
          invalidName = true;
        }
        return { name, raw: d.name, invalidName };
      });
      const stats = await mapLimit(named, STAT_CONCURRENCY, async (n) => {
        try {
          return await fs.lstat(Buffer.concat([Buffer.from(`${absolutePath}/`), n.raw]), { bigint: true });
        } catch {
          return null;
        }
      });
      const entries: RawEntry[] = [];
      const dataless: number[] = [];
      for (let i = 0; i < named.length; i++) {
        const st = stats[i];
        if (st === null || st === undefined) continue; // Gone since the folder was read.
        const n = named[i]!;
        const type = st.isSymbolicLink() ? "link" : st.isDirectory() ? "folder" : st.isFile() ? "file" : "other";
        const birth = Number(st.birthtimeMs);
        const entry: RawEntry = {
          name: n.name,
          type,
          size: type === "file" ? Number(st.size) : 0,
          modifiedMs: Math.floor(Number(st.mtimeMs)),
          createdMs: birth > 0 ? Math.floor(birth) : null,
          attributes: 0,
          reparseTag: 0,
          flags: 0,
          fileId: st.dev === folderStat.dev && st.ino > 0n ? hex16(st.ino) : null,
          ...(n.invalidName ? { invalidName: true } : {}),
        };
        if (darwin && type === "file" && st.size > 0n && st.blocks === 0n) dataless.push(entries.length);
        entries.push(entry);
      }
      if (dataless.length > 0) {
        const flags = await readMacFlags(dataless.map((i) => path.posix.join(absolutePath, entries[i]!.name)));
        dataless.forEach((index, k) => {
          entries[index]!.flags = flags === null ? SF_DATALESS : flags[k]!;
        });
      }
      return { complete: true, volumeId: hex16(folderStat.dev), folderId: hex16(folderStat.ino), entries };
    },
    async volume(root: string): Promise<VolumeFacts> {
      let type = "unknown";
      try {
        const real = await fs.realpath(root);
        const text = darwin ? await run("/sbin/mount", []) : await fs.readFile("/proc/self/mounts", "utf8");
        type = mountType(text, real, darwin);
      } catch {
        // Unknown file system: file ids are not used.
      }
      return { fileSystem: fileSystemName(type), ignoresCase: await probeIgnoresCase(root, platform) };
    },
    async exists(absolutePath: string): Promise<boolean> {
      try {
        return (await fs.stat(absolutePath)).isDirectory();
      } catch {
        return false;
      }
    },
    async close(): Promise<void> {},
  };
}
