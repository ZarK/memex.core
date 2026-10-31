import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { isLinkTag } from "./attributes.js";
import { FolderListingError } from "./errors.js";
import { fileSystemName } from "./keys.js";
import type { ListingBackend, RawEntry, RawFolder, VolumeFacts } from "./types.js";

/**
 * The Windows listing helper. Node.js does not give file attributes on Windows, so a small C# class, compiled by
 * Windows PowerShell's Add-Type, lists each folder with one handle: GetFileInformationByHandleEx with
 * FILE_ID_EXTD_DIR_INFO returns every entry's attributes, reparse tag, size, times, and 128-bit file id
 * (FILE_ID_BOTH_DIR_INFO and a 64-bit id on file systems without 128-bit ids). The same calls as
 * Memex.Photos FileSystemListing.cs, so the ids are the same. Nothing is opened but the folder, so nothing is
 * downloaded, and \\?\ paths work at any length.
 *
 * Protocol, one UTF-8 line per request and response line:
 *   "L\t<\\?\ path>" -> "H\t<volume id>\t<folder id>", then "E\t<name>\t<attributes>\t<size>\t<modified FILETIME>
 *                       \t<created FILETIME>\t<reparse tag>\t<file id>\t<lone surrogate 0|1>" per entry, then "D";
 *                       or "X\t<win32 error>\t<message>" (after any H or E lines, which are dropped).
 *   UTF-8 cannot hold a lone surrogate (it becomes U+FFFD), so the helper flags one in the last field: such a
 *   name is not valid Unicode and is left out.
 *   "F\t<path>"        -> "F\t<file system>\t<drive type>" or "X\t<error>\t<message>".
 */
const HELPER_SOURCE = String.raw`
using System;
using System.ComponentModel;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

public static class MemexFolderLister
{
  const uint FileListDirectory = 0x0001;
  const uint ShareAll = 0x0007;
  const uint OpenExisting = 3;
  const uint BackupSemantics = 0x02000000;
  const int BufferSize = 64 * 1024;

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);

  [DllImport("kernel32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  static extern bool GetFileInformationByHandleEx(SafeFileHandle handle, int informationClass, IntPtr buffer, uint size);

  public static void Serve(TextReader input, TextWriter output)
  {
    IntPtr buffer = Marshal.AllocHGlobal(BufferSize);
    try
    {
      string line;
      while ((line = input.ReadLine()) != null)
      {
        if (line.Length < 3) continue;
        string target = line.Substring(2);
        try
        {
          if (line[0] == 'L') List(target, buffer, output);
          else if (line[0] == 'F') Format(target, output);
          else output.WriteLine("X\t0\tUnknown request.");
        }
        catch (Exception ex)
        {
          output.WriteLine("X\t0\t" + Clean(ex.Message));
        }
        output.Flush();
      }
    }
    finally
    {
      Marshal.FreeHGlobal(buffer);
    }
  }

  static string Clean(string text)
  {
    return text.Replace('\r', ' ').Replace('\n', ' ').Replace('\t', ' ');
  }

  static string Hex(IntPtr p, int offset, int length)
  {
    var sb = new StringBuilder(length * 2);
    for (int i = 0; i < length; i++) sb.Append(Marshal.ReadByte(p, offset + i).ToString("x2", CultureInfo.InvariantCulture));
    return sb.ToString();
  }

  static bool HasLoneSurrogate(string name)
  {
    for (int i = 0; i < name.Length; i++)
    {
      char c = name[i];
      if (char.IsHighSurrogate(c))
      {
        if (i + 1 < name.Length && char.IsLowSurrogate(name[i + 1])) { i++; continue; }
        return true;
      }
      if (char.IsLowSurrogate(c)) return true;
    }
    return false;
  }

  static void Fail(TextWriter output, int error)
  {
    output.WriteLine("X\t" + error.ToString(CultureInfo.InvariantCulture) + "\t" + Clean(new Win32Exception(error).Message));
  }

  static void List(string folder, IntPtr buffer, TextWriter output)
  {
    using (SafeFileHandle handle = CreateFileW(folder, FileListDirectory, ShareAll, IntPtr.Zero, OpenExisting, BackupSemantics, IntPtr.Zero))
    {
      if (handle.IsInvalid) { Fail(output, Marshal.GetLastWin32Error()); return; }
      string volume = "", folderId = "";
      IntPtr info = Marshal.AllocHGlobal(24);
      try
      {
        if (GetFileInformationByHandleEx(handle, 18, info, 24))
        {
          volume = ((ulong)Marshal.ReadInt64(info, 0)).ToString("x16", CultureInfo.InvariantCulture);
          folderId = Hex(info, 8, 16);
        }
      }
      finally { Marshal.FreeHGlobal(info); }
      output.WriteLine("H\t" + volume + "\t" + folderId);

      bool extended = true, first = true;
      var sb = new StringBuilder();
      while (true)
      {
        int informationClass = extended ? (first ? 20 : 19) : (first ? 11 : 10);
        if (!GetFileInformationByHandleEx(handle, informationClass, buffer, BufferSize))
        {
          int error = Marshal.GetLastWin32Error();
          if (error == 18) { output.WriteLine("D"); return; }
          if (extended && first && (error == 87 || error == 50 || error == 124)) { extended = false; continue; }
          Fail(output, error);
          return;
        }
        first = false;
        int offset = 0;
        while (true)
        {
          IntPtr p = IntPtr.Add(buffer, offset);
          int next = Marshal.ReadInt32(p, 0);
          long created = Marshal.ReadInt64(p, 8);
          long modified = Marshal.ReadInt64(p, 24);
          long size = Marshal.ReadInt64(p, 40);
          uint attributes = (uint)Marshal.ReadInt32(p, 56);
          int nameLength = Marshal.ReadInt32(p, 60);
          uint eaSizeOrTag = (uint)Marshal.ReadInt32(p, 64);
          uint tag;
          string id;
          int nameOffset;
          if (extended)
          {
            tag = (uint)Marshal.ReadInt32(p, 68);
            id = Hex(p, 72, 16);
            nameOffset = 88;
          }
          else
          {
            tag = (attributes & 0x400) != 0 ? eaSizeOrTag : 0;
            id = ((ulong)Marshal.ReadInt64(p, 96)).ToString("x16", CultureInfo.InvariantCulture);
            nameOffset = 104;
          }
          string name = Marshal.PtrToStringUni(IntPtr.Add(p, nameOffset), nameLength / 2);
          if (name != "." && name != "..")
          {
            sb.Length = 0;
            sb.Append("E\t").Append(name).Append('\t').Append(attributes.ToString(CultureInfo.InvariantCulture)).Append('\t')
              .Append(size.ToString(CultureInfo.InvariantCulture)).Append('\t').Append(modified.ToString(CultureInfo.InvariantCulture)).Append('\t')
              .Append(created.ToString(CultureInfo.InvariantCulture)).Append('\t').Append(tag.ToString(CultureInfo.InvariantCulture)).Append('\t')
              .Append(id).Append('\t').Append(HasLoneSurrogate(name) ? '1' : '0');
            output.WriteLine(sb.ToString());
          }
          if (next == 0) break;
          offset += next;
        }
      }
    }
  }

  static void Format(string target, TextWriter output)
  {
    string root = Path.GetPathRoot(target);
    if (root.StartsWith(@"\\", StringComparison.Ordinal)) { output.WriteLine("F\tsmb\tNetwork"); return; }
    var drive = new DriveInfo(root);
    string type = drive.DriveType.ToString();
    output.WriteLine("F\t" + (drive.DriveType == DriveType.Network ? "smb" : drive.DriveFormat) + "\t" + type);
  }
}
`;

const SCRIPT = `
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding $false
$reader = New-Object System.IO.StreamReader ([Console]::OpenStandardInput()), $utf8
$writer = New-Object System.IO.StreamWriter ([Console]::OpenStandardOutput()), $utf8, 65536
$writer.AutoFlush = $false
Add-Type -TypeDefinition @'
${HELPER_SOURCE}
'@
$writer.WriteLine('READY')
$writer.Flush()
[MemexFolderLister]::Serve($reader, $writer)
`;

/** FILETIME (100 ns since 1601) to integer milliseconds since 1970. */
export function fileTimeToMs(value: string): number | null {
  const ticks = BigInt(value);
  if (ticks <= 0n) return null;
  return Number(ticks / 10000n) - 11_644_473_600_000;
}

type Pending = { lines: string[]; resolve: (lines: string[]) => void; reject: (error: Error) => void; terminal: (line: string) => boolean };

/** One running helper process. Requests are answered in order, so several may be in flight. */
class Helper {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly queue: Pending[] = [];
  private failure: Error | null = null;
  private readonly ready: Promise<void>;
  private stderr = "";

  constructor(env: NodeJS.ProcessEnv) {
    const root = env.SystemRoot ?? env.windir ?? "C:\\Windows";
    const exe = path.win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const encoded = Buffer.from(SCRIPT, "utf16le").toString("base64");
    this.child = spawn(exe, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], { windowsHide: true });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      if (this.stderr.length < 4000) this.stderr += chunk;
    });
    let started: (() => void) | null = null;
    let notStarted: ((error: Error) => void) | null = null;
    this.ready = new Promise<void>((resolve, reject) => {
      started = resolve;
      notStarted = reject;
    });
    const fail = (error: Error): void => {
      if (this.failure === null) this.failure = error;
      notStarted?.(error);
      for (const pending of this.queue.splice(0)) pending.reject(error);
    };
    this.child.on("error", (error) => fail(new FolderListingError("helper-failed", `The Windows listing helper could not start: ${error.message}`)));
    this.child.on("close", (code) =>
      fail(new FolderListingError("helper-failed", `The Windows listing helper stopped (exit ${String(code)}). ${this.stderr.trim()}`.trim())),
    );
    const lines = createInterface({ input: this.child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
    lines.on("line", (line) => {
      if (started !== null) {
        if (line === "READY") {
          const s = started;
          started = null;
          notStarted = null;
          s();
        }
        return;
      }
      const head = this.queue[0];
      if (head === undefined) return;
      head.lines.push(line);
      if (head.terminal(line)) {
        this.queue.shift();
        head.resolve(head.lines);
      }
    });
  }

  async request(line: string, terminal: (line: string) => boolean): Promise<string[]> {
    await this.ready;
    if (this.failure !== null) throw this.failure;
    return new Promise<string[]>((resolve, reject) => {
      this.queue.push({ lines: [], resolve, reject, terminal });
      this.child.stdin.write(`${line}\n`, "utf8");
    });
  }

  close(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
      this.child.once("close", () => resolve());
      this.child.stdin.end();
    });
  }
}

function parseEntry(fields: string[]): RawEntry {
  const attributes = Number(fields[2]);
  const tag = Number(fields[6]);
  const directory = (attributes & 0x10) !== 0;
  const link = (attributes & 0x400) !== 0 && isLinkTag(tag);
  const name = fields[1]!;
  return {
    name,
    type: link ? "link" : directory ? "folder" : "file",
    size: directory ? 0 : Number(fields[3]),
    modifiedMs: fileTimeToMs(fields[4]!) ?? 0,
    createdMs: fileTimeToMs(fields[5]!),
    attributes,
    reparseTag: tag,
    flags: 0,
    fileId: fields[7] === undefined || fields[7] === "" ? null : fields[7],
    // A lone surrogate became U+FFFD on the way out, a name that is not on the disk: the helper flags it.
    ...(fields[8] === "1" ? { invalidName: true } : {}),
  };
}

const NOT_FOUND = new Set([2, 3, 21, 53, 67, 161]);

/** The Windows backend: the helper process for listings, Node.js for the rest. */
export function windowsBackend(env: NodeJS.ProcessEnv = process.env): ListingBackend {
  let helper: Helper | null = null;
  const get = (): Helper => (helper ??= new Helper(env));
  return {
    platform: "win32",
    async readFolder(absolutePath: string): Promise<RawFolder> {
      const lines = await get().request(`L\t${path.win32.toNamespacedPath(absolutePath)}`, (l) => l === "D" || l.startsWith("X\t"));
      const last = lines[lines.length - 1]!;
      if (last.startsWith("X\t")) {
        const [, code, message] = last.split("\t");
        return { complete: false, code: NOT_FOUND.has(Number(code)) ? "missing" : "unreadable", error: message ?? "The folder could not be listed." };
      }
      let volumeId: string | null = null;
      let folderId: string | null = null;
      const entries: RawEntry[] = [];
      for (const line of lines) {
        const fields = line.split("\t");
        if (fields[0] === "H") {
          volumeId = fields[1] || null;
          folderId = fields[2] || null;
        } else if (fields[0] === "E") {
          entries.push(parseEntry(fields));
        }
      }
      return { complete: true, volumeId, folderId, entries };
    },
    async volume(root: string): Promise<VolumeFacts> {
      // The drive root only: Windows PowerShell's .NET refuses long paths, and the drive is all it needs.
      const [line] = await get().request(`F\t${path.win32.parse(root).root}`, () => true);
      const fields = (line ?? "").split("\t");
      const fileSystem = fields[0] === "F" ? fileSystemName(fields[1] ?? "") : "unknown";
      return { fileSystem, ignoresCase: await probeIgnoresCase(root, "win32") };
    },
    async exists(absolutePath: string): Promise<boolean> {
      try {
        return (await fs.stat(absolutePath)).isDirectory();
      } catch {
        return false;
      }
    },
    async close(): Promise<void> {
      await helper?.close();
      helper = null;
    },
  };
}

function swapCase(name: string): string | null {
  if (!/\p{L}/u.test(name)) return null;
  let out = "";
  for (const ch of name) out += ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase();
  return out === name ? null : out;
}

async function existsAt(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether the file system of a root ignores letter case: the root, or an entry of it, is looked up with its case
 * changed. Without a letter to change, the platform's rule applies (Linux does not ignore case).
 */
export async function probeIgnoresCase(root: string, platform: string): Promise<boolean> {
  const p = platform === "win32" ? path.win32 : path.posix;
  const name = p.basename(root);
  const swapped = swapCase(name);
  if (swapped !== null && p.dirname(root) !== root) return existsAt(p.join(p.dirname(root), swapped));
  try {
    for (const entry of await fs.readdir(root)) {
      const s = swapCase(entry);
      if (s !== null) return existsAt(p.join(root, s));
    }
  } catch {
    // Fall through to the platform's rule.
  }
  return platform !== "linux";
}
