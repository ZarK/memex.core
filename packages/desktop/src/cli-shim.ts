import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile, chmod } from "node:fs/promises";
import path from "node:path";

/**
 * The CLI shim: a small program in <resources>/bin that runs the app's memex-<app> CLI with the Node.js inside the
 * installed Electron program (ELECTRON_RUN_AS_NODE), so the CLI and the stdio MCP server need no separate Node.js.
 * The app record names the shim as its mcp command. Call the shim by its full path, or put the bin folder on PATH;
 * a link to the shim does not work, because the shim finds the program from its own folder.
 *
 * On Windows the shim is a small console program (memex-<app>.exe), not a .cmd file: cmd.exe parses the arguments of
 * a .cmd again, so an argument with & or | in quotes (a JSON input with outside text) could run other commands, and
 * Node.js refuses to start a .cmd without a shell. The program passes its own command line, after its name, unchanged
 * to the Electron program, so the CLI gets exactly the arguments its caller gave. It is compiled at pack time with
 * the C# compiler of the .NET Framework 4 that is part of Windows.
 */
export interface CliShimOptions {
  app: string;
  /** The file name of the program: "Memex Photos.exe" on Windows, "Memex Photos" on macOS, "memex-photos" on Linux. */
  executableName: string;
  /** The CLI module inside the app archive, relative to app.asar, for example "cli.mjs". */
  cliEntry: string;
}

const SAFE_NAME = /^[A-Za-z0-9 ._()+-]+$/;
const SAFE_ENTRY = /^[A-Za-z0-9._/-]+$/;

function check(options: CliShimOptions): void {
  if (!/^[a-z][a-z0-9]*$/.test(options.app)) throw new Error(`The app id ${options.app} must be lower case letters and digits.`);
  if (!SAFE_NAME.test(options.executableName)) throw new Error(`The program name ${options.executableName} has characters a shim cannot quote safely.`);
  if (!SAFE_ENTRY.test(options.cliEntry) || options.cliEntry.split("/").includes("..") || options.cliEntry.startsWith("/")) {
    throw new Error(`The CLI entry ${options.cliEntry} must be a plain path inside app.asar.`);
  }
}

/** The shim's file name on a platform. */
export function cliShimName(app: string, platform: string = process.platform): string {
  return platform === "win32" ? `memex-${app}.exe` : `memex-${app}`;
}

/**
 * The C# source of the Windows shim. It starts <resources>\..\<executableName> with ELECTRON_RUN_AS_NODE=1, the CLI
 * entry in app.asar, and the rest of its own command line as it came; it shares its standard streams, waits, and
 * exits with the program's exit code. A job object stops the program when the shim is stopped; programs that the CLI
 * starts are not in the job.
 *
 * The program inherits only its three standard handles, not every inheritable handle the shim got from its caller.
 * When standard output or error is a pipe or a file (a caller that reads the output), the shim copies the program's
 * output through pipes of its own. Otherwise a program that the CLI starts (open starts the app) would inherit the
 * caller's pipe, and the caller would wait for the end of the output until the app quits. A console is passed on.
 */
export function windowsCliLauncherSource(options: CliShimOptions): string {
  check(options);
  const entryParts = options.cliEntry.split("/").map((part) => `"${part}"`).join(", ");
  return `// memex-${options.app}: starts the CLI of ${options.executableName} with the program's own Node.js.
// Written by @tjalve/memex-desktop; do not edit.
using System;
using System.ComponentModel;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;

static class MemexCliShim {
  const string Program = "${options.executableName}";
  static readonly string[] Entry = new string[] { ${entryParts} };

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct STARTUPINFO {
    public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
    public int dwX; public int dwY; public int dwXSize; public int dwYSize; public int dwXCountChars; public int dwYCountChars;
    public int dwFillAttribute; public int dwFlags; public short wShowWindow; public short cbReserved2; public IntPtr lpReserved2;
    public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }

  [StructLayout(LayoutKind.Sequential)]
  struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId; }

  [StructLayout(LayoutKind.Sequential)]
  struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public int LimitFlags; public UIntPtr MinimumWorkingSetSize;
    public UIntPtr MaximumWorkingSetSize; public int ActiveProcessLimit; public UIntPtr Affinity; public int PriorityClass; public int SchedulingClass;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct IO_COUNTERS { public ulong a; public ulong b; public ulong c; public ulong d; public ulong e; public ulong f; }

  [StructLayout(LayoutKind.Sequential)]
  struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo; public UIntPtr ProcessMemoryLimit;
    public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed;
  }

  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool CreateProcessW(string app, System.Text.StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, int flags, IntPtr env, string cwd, ref STARTUPINFOEX si, out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr list, int flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returnSize);
  [DllImport("kernel32.dll")] static extern IntPtr GetCommandLineW();
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int which);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint ms);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
  [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, int length);
  [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  delegate bool ConsoleHandler(int ctrlType);
  [DllImport("kernel32.dll")] static extern bool SetConsoleCtrlHandler(ConsoleHandler handler, bool add);
  [StructLayout(LayoutKind.Sequential)]
  struct SECURITY_ATTRIBUTES { public int nLength; public IntPtr lpSecurityDescriptor; public bool bInheritHandle; }
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref SECURITY_ATTRIBUTES sa, int size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetHandleInformation(IntPtr handle, int mask, int flags);
  [DllImport("kernel32.dll")] static extern int GetFileType(IntPtr handle);
  [DllImport("kernel32.dll")] static extern bool PeekNamedPipe(IntPtr pipe, IntPtr buffer, int size, IntPtr read, out int available, IntPtr left);
  [DllImport("kernel32.dll")] static extern bool ReadFile(IntPtr file, byte[] buffer, int size, out int read, IntPtr overlapped);
  [DllImport("kernel32.dll")] static extern bool WriteFile(IntPtr file, byte[] buffer, int size, out int written, IntPtr overlapped);

  const int STARTF_USESTDHANDLES = 0x100;
  const int CREATE_SUSPENDED = 0x4;
  const int CREATE_UNICODE_ENVIRONMENT = 0x400;
  const int EXTENDED_STARTUPINFO_PRESENT = 0x80000;
  static readonly IntPtr PROC_THREAD_ATTRIBUTE_HANDLE_LIST = new IntPtr(0x20002);
  const int JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
  const int JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK = 0x1000;
  static readonly ConsoleHandler IgnoreCtrl = delegate(int ctrlType) { return true; };
  const int HANDLE_FLAG_INHERIT = 1;

  // An output the shim copies: the program writes to a pipe of the shim's, the shim writes to the caller's handle.
  sealed class Relay {
    public IntPtr Read; public IntPtr Write; public IntPtr Target; public bool Open = true;
  }

  // A pipe or a file is copied; a console (or no handle) is passed on.
  static Relay MakeRelay(IntPtr target) {
    int type = GetFileType(target);
    if (type != 1 && type != 3) return null;
    var sa = new SECURITY_ATTRIBUTES();
    sa.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
    sa.bInheritHandle = true;
    IntPtr read, write;
    if (!CreatePipe(out read, out write, ref sa, 65536)) return null;
    SetHandleInformation(read, HANDLE_FLAG_INHERIT, 0);
    SetHandleInformation(target, HANDLE_FLAG_INHERIT, 0);
    var relay = new Relay();
    relay.Read = read; relay.Write = write; relay.Target = target;
    return relay;
  }

  static readonly byte[] Buffer = new byte[65536];

  // Copies what is waiting in the pipe; returns whether it copied anything.
  static bool Pump(Relay relay) {
    if (relay == null || !relay.Open) return false;
    int available;
    if (!PeekNamedPipe(relay.Read, IntPtr.Zero, 0, IntPtr.Zero, out available, IntPtr.Zero)) {
      relay.Open = false;
      return false;
    }
    if (available == 0) return false;
    int read;
    if (!ReadFile(relay.Read, Buffer, Math.Min(available, Buffer.Length), out read, IntPtr.Zero) || read == 0) {
      relay.Open = false;
      return false;
    }
    int offset = 0;
    while (offset < read) {
      int written;
      byte[] chunk = Buffer;
      if (offset > 0) {
        chunk = new byte[read - offset];
        Array.Copy(Buffer, offset, chunk, 0, read - offset);
      }
      if (!WriteFile(relay.Target, chunk, read - offset, out written, IntPtr.Zero) || written == 0) break;
      offset += written;
    }
    return true;
  }

  // The command line after the shim's own name, unchanged. The name is skipped the way the C runtime skips argv[0]:
  // up to the closing quote when it starts with a quote, else up to the first space or tab.
  static string Tail(string line) {
    int i = 0;
    if (line.Length > 0 && line[0] == '"') {
      i = line.IndexOf('"', 1);
      i = i < 0 ? line.Length : i + 1;
    } else {
      while (i < line.Length && line[i] != ' ' && line[i] != '\\t') i++;
    }
    while (i < line.Length && (line[i] == ' ' || line[i] == '\\t')) i++;
    return line.Substring(i);
  }

  static int Main() {
    try {
      string self = Assembly.GetExecutingAssembly().Location;
      string resources = Path.GetDirectoryName(Path.GetDirectoryName(self));
      string program = Path.Combine(Path.GetDirectoryName(resources), Program);
      string entry = Path.Combine(resources, "app.asar");
      foreach (string part in Entry) entry = Path.Combine(entry, part);
      if (!File.Exists(program)) {
        Console.Error.WriteLine("memex-${options.app}: the program " + program + " is missing. Reinstall the app.");
        return 1;
      }
      string tail = Tail(Marshal.PtrToStringUni(GetCommandLineW()) ?? "");
      var command = new System.Text.StringBuilder("\\"" + program + "\\" \\"" + entry + "\\"" + (tail.Length > 0 ? " " + tail : ""));
      Environment.SetEnvironmentVariable("ELECTRON_RUN_AS_NODE", "1");
      var si = new STARTUPINFOEX();
      si.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
      si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
      si.StartupInfo.hStdInput = GetStdHandle(-10);
      Relay output = MakeRelay(GetStdHandle(-11));
      Relay errors = MakeRelay(GetStdHandle(-12));
      si.StartupInfo.hStdOutput = output != null ? output.Write : GetStdHandle(-11);
      si.StartupInfo.hStdError = errors != null ? errors.Write : GetStdHandle(-12);
      // The program inherits these three handles and nothing else.
      var inherit = new System.Collections.Generic.List<IntPtr>();
      foreach (IntPtr handle in new IntPtr[] { si.StartupInfo.hStdInput, si.StartupInfo.hStdOutput, si.StartupInfo.hStdError }) {
        if (handle == IntPtr.Zero || handle == new IntPtr(-1) || inherit.Contains(handle)) continue;
        if (SetHandleInformation(handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT)) inherit.Add(handle);
      }
      int flags = CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT;
      if (inherit.Count > 0) {
        IntPtr size = IntPtr.Zero;
        InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
        si.lpAttributeList = Marshal.AllocHGlobal(size);
        IntPtr list = Marshal.AllocHGlobal(IntPtr.Size * inherit.Count);
        for (int i = 0; i < inherit.Count; i++) Marshal.WriteIntPtr(list, i * IntPtr.Size, inherit[i]);
        if (!InitializeProcThreadAttributeList(si.lpAttributeList, 1, 0, ref size) ||
            !UpdateProcThreadAttribute(si.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, list, new IntPtr(IntPtr.Size * inherit.Count), IntPtr.Zero, IntPtr.Zero)) {
          Console.Error.WriteLine("memex-${options.app}: the handle list could not be set: " + new Win32Exception(Marshal.GetLastWin32Error()).Message);
          return 1;
        }
        flags |= EXTENDED_STARTUPINFO_PRESENT;
      }
      PROCESS_INFORMATION pi;
      // Ctrl+C reaches the program too; the shim waits for it to finish instead of leaving first.
      SetConsoleCtrlHandler(IgnoreCtrl, true);
      if (!CreateProcessW(program, command, IntPtr.Zero, IntPtr.Zero, inherit.Count > 0, flags, IntPtr.Zero, null, ref si, out pi)) {
        Console.Error.WriteLine("memex-${options.app}: " + program + " did not start: " + new Win32Exception(Marshal.GetLastWin32Error()).Message);
        return 1;
      }
      IntPtr job = CreateJobObjectW(IntPtr.Zero, null);
      if (job != IntPtr.Zero) {
        var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        // Only the CLI process is in the job: programs it starts (open starts the app) are not, so they outlive the shim.
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK;
        SetInformationJobObject(job, 9, ref info, Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)));
        AssignProcessToJobObject(job, pi.hProcess);
      }
      ResumeThread(pi.hThread);
      CloseHandle(pi.hThread);
      if (output != null) CloseHandle(output.Write);
      if (errors != null) CloseHandle(errors.Write);
      if (output == null && errors == null) {
        WaitForSingleObject(pi.hProcess, 0xFFFFFFFF);
      } else {
        // Copy while the program runs; when it has exited, copy what is left and stop, even if a program it started
        // still holds the pipe.
        bool exited = false;
        while (true) {
          bool copied = Pump(output) | Pump(errors);
          if (exited && !copied) break;
          if (!copied) exited = WaitForSingleObject(pi.hProcess, 5) == 0;
        }
      }
      uint code;
      GetExitCodeProcess(pi.hProcess, out code);
      CloseHandle(pi.hProcess);
      return unchecked((int)code);
    } catch (Exception error) {
      Console.Error.WriteLine("memex-${options.app}: " + error.Message);
      return 1;
    }
  }
}
`;
}

/** The C# compiler of the .NET Framework 4 that comes with Windows, or undefined. */
export function findWindowsCsc(env: Readonly<Record<string, string | undefined>> = process.env): string | undefined {
  const windows = env.WINDIR || env.SystemRoot;
  if (!windows) return undefined;
  for (const framework of ["Framework64", "Framework"]) {
    const file = path.join(windows, "Microsoft.NET", framework, "v4.0.30319", "csc.exe");
    if (existsSync(file)) return file;
  }
  return undefined;
}

/** Compiles the Windows shim into dir. Needs Windows (the .NET Framework 4 C# compiler). Returns its path. */
export async function buildWindowsCliLauncher(dir: string, options: CliShimOptions): Promise<string> {
  const csc = findWindowsCsc();
  if (!csc) throw new Error("The Windows CLI shim needs the C# compiler of the .NET Framework 4 (csc.exe), which comes with Windows. Pack the Windows installer on Windows.");
  await mkdir(dir, { recursive: true });
  const source = path.join(dir, `memex-${options.app}.cs`);
  const file = path.join(dir, cliShimName(options.app, "win32"));
  await writeFile(source, windowsCliLauncherSource(options));
  const result = spawnSync(csc, ["/nologo", "/target:exe", "/platform:anycpu", "/optimize+", `/out:${file}`, source], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`csc.exe could not compile the CLI shim: ${result.stdout}${result.stderr}${result.error?.message ?? ""}`);
  return file;
}

/** The text of the macOS or Linux shim. On macOS the program is Contents/MacOS/<executableName>. */
export function unixCliShim(options: CliShimOptions, platform: "darwin" | "linux"): string {
  check(options);
  const program = platform === "darwin" ? `$here/../../MacOS/${options.executableName}` : `$here/../../${options.executableName}`;
  return [
    "#!/bin/sh",
    'here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)',
    `ELECTRON_RUN_AS_NODE=1 exec "${program}" "$here/../app.asar/${options.cliEntry}" "$@"`,
    "",
  ].join("\n");
}

/**
 * Writes the shim for a platform into dir (the folder packed as <resources>/bin). Returns its path. The Windows shim
 * is compiled, so it can only be written on Windows.
 */
export async function writeCliShim(dir: string, options: CliShimOptions, platform: string = process.platform): Promise<string> {
  if (platform === "win32") return buildWindowsCliLauncher(dir, options);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, cliShimName(options.app, platform));
  await writeFile(file, unixCliShim(options, platform === "darwin" ? "darwin" : "linux"));
  await chmod(file, 0o755);
  return file;
}

/** The installed shim of the running app, or undefined when the app has none (or runs unpackaged). */
export function installedCliShim(app: string, resourcesPath: string | undefined, platform: string = process.platform): string | undefined {
  if (!resourcesPath) return undefined;
  const file = path.join(resourcesPath, "bin", cliShimName(app, platform));
  return existsSync(file) ? file : undefined;
}

/**
 * What the app record names as the program and the mcp command of the running app. An AppImage runs from a
 * temporary mount (/tmp/.mount_*) that is gone when the app quits, so its record names the AppImage file itself
 * ($APPIMAGE) as the program and has no mcp command: an AppImage has no shim at a stable path. Install the deb for
 * the CLI and MCP on Linux.
 */
export function desktopProgram(options: {
  app: string;
  packaged: boolean;
  exePath: string;
  resourcesPath: string | undefined;
  platform?: string;
  env?: Readonly<Record<string, string | undefined>>;
}): { executable: string; cli: string | undefined } {
  const platform = options.platform ?? process.platform;
  const appImage = platform === "linux" ? (options.env ?? process.env).APPIMAGE : undefined;
  if (appImage) return { executable: appImage, cli: undefined };
  return { executable: options.exePath, cli: options.packaged ? installedCliShim(options.app, options.resourcesPath, platform) : undefined };
}
