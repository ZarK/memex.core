import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { electronPackageDir, fetchElectron } from "./fetch-electron.js";
import { pack } from "./pack.js";
import { pinServices, serviceTarget, servicesStatus, stageServices } from "./services.js";
import { runSmoke } from "./smoke-run.js";
import { assertReleaseVersion, extractRelease, findPnpmLockfile, inspectReleaseAsar, mergeBuilderChecksums, nonRegistryPackages, readPackageVersion, releaseTagFromEnv, writeChecksums } from "./release.js";

const USAGE = `Usage: memex-desktop <command>

  pack [--config memex-desktop.config.mjs] [--dir] [--require-tag]
      Packs the app: CLI shims, electron-builder with the Memex base config, the app.asar check, SHA256SUMS.txt.
  fetch-electron [--platform <os>] [--arch <arch>] [--cache <dir>]
      Downloads the Electron program of the installed electron package, checks it against its checksums.json,
      and unpacks it into node_modules/electron/dist.
  icons <icon.svg> <out-dir>
      Renders <size>x<size>.png, icon.png, icon.ico and icon.icns with Electron.
  checksums <release-dir> --base <name> [--merge]
      Writes SHA256SUMS.txt for <name>-<version>-<os>-<arch> installers (--merge: from SHA256SUMS-<os>.txt files).
  inspect-asar <release-dir> [--require <path>]... [--forbid <prefix>]...
      Checks every app.asar: no source maps, required files present, nothing under a forbidden prefix.
  extract <release-dir> --out <dir> [--lockfile <pnpm-lock.yaml>]
      Writes the files of every app.asar and the rest of its resources folder (CLI shims, notices) into <dir>,
      so that other tools can read what the build ships. Packages that are not from the registry (workspace, file,
      git; read from the nearest pnpm-lock.yaml) and @tjalve/* packages go under node_modules.first-party.
  smoke --program <path> --out <dir> [--timeout <seconds>] [--expect <text>] [-- <program arguments>]
      Starts an installed app with MEMEX_DESKTOP_SMOKE=<dir>: it must start its server, show its first page (HTTP 2xx,
      with text, and with <text> when --expect is given) and quit.
  version [--files package.json,...] [--require-tag]
      Checks that the package versions agree with each other and with the v<version> tag.
  services pin --from <dir> [--pins services.json]
      Pins the service archives in <dir> (memex-<service>-<version>-<target>.tar.gz with the .json record that the
      packaging scripts of memex.node and memex.user write) into services.json, after checking each SHA-256.
  services stage --from <dir> --out <empty dir> [--pins services.json] [--target <target>]
      Checks the pinned archives of a target and unpacks them as pack does (<resources>/services).
  services status [--services <dir>]
      The installed versions of each shared service and the apps that carry them (MEMEX_SERVICES_DIR is honoured).
`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const value = args[i + 1];
  if (value === undefined || value.startsWith("--")) throw new UsageError(`${name} needs a value.`);
  return value;
}

function flags(args: string[], name: string): string[] {
  const out: string[] = [];
  args.forEach((arg, i) => {
    if (arg === name && args[i + 1] !== undefined) out.push(args[i + 1]!);
  });
  return out;
}

function positionals(args: string[], valued: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (valued.includes(arg)) i++;
    else if (!arg.startsWith("--")) out.push(arg);
  }
  return out;
}

class UsageError extends Error {}

/** The Electron program of the installed electron package, without starting its download. */
export function electronBinary(from: string): string {
  const dir = electronPackageDir(from);
  const pathFile = path.join(dir, "path.txt");
  const executable = existsSync(pathFile) ? readFileSync(pathFile, "utf8").trim() : "";
  const full = path.join(dir, "dist", executable);
  if (!executable || !existsSync(full)) throw new Error("Electron is not unpacked. Run memex-desktop fetch-electron first.");
  return full;
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  let args = rest;
  const out = (line: string) => process.stdout.write(`${line}\n`);
  try {
    switch (command) {
      case "pack": {
        await pack({ config: flag(args, "--config") ?? "memex-desktop.config.mjs", dir: args.includes("--dir"), requireTag: args.includes("--require-tag"), log: out });
        return 0;
      }
      case "fetch-electron": {
        const result = await fetchElectron({ platform: flag(args, "--platform"), arch: flag(args, "--arch"), cache: flag(args, "--cache"), log: out });
        out(`Electron ${result.version}: ${path.join(result.dist, result.executable)}${result.extracted ? "" : " (already unpacked)"}`);
        return 0;
      }
      case "icons": {
        const [svg, outDir] = positionals(args, []);
        if (!svg || !outDir) throw new UsageError("icons needs <icon.svg> <out-dir>.");
        const script = fileURLToPath(new URL("./render-icons.js", import.meta.url));
        const result = spawnSync(electronBinary(process.cwd()), [script, path.resolve(svg), path.resolve(outDir)], {
          stdio: "inherit",
          env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
        });
        return result.status ?? 1;
      }
      case "checksums": {
        const [dir] = positionals(args, ["--base"]);
        const base = flag(args, "--base");
        if (!dir || !base) throw new UsageError("checksums needs <release-dir> --base <name>.");
        const result = args.includes("--merge") ? await mergeBuilderChecksums(dir, base) : writeChecksums(dir, base);
        out(`Wrote ${result.names.length} checksums to ${result.outputPath}`);
        return 0;
      }
      case "inspect-asar": {
        const [dir] = positionals(args, ["--require", "--forbid"]);
        if (!dir) throw new UsageError("inspect-asar needs <release-dir>.");
        const result = inspectReleaseAsar(dir, { required: flags(args, "--require"), forbiddenPrefixes: flags(args, "--forbid") });
        out(`Checked ${result.archives.length} app.asar (${result.files} files).`);
        return 0;
      }
      case "extract": {
        const [dir] = positionals(args, ["--out", "--lockfile"]);
        const to = flag(args, "--out");
        if (!dir || !to) throw new UsageError("extract needs <release-dir> --out <dir>.");
        const given = flag(args, "--lockfile");
        const lockfile = given ? path.resolve(given) : findPnpmLockfile(process.cwd());
        if (!lockfile || !existsSync(lockfile)) throw new Error("extract needs the app's pnpm-lock.yaml (--lockfile <path>): it tells which packages are not from the registry.");
        const local = nonRegistryPackages(readFileSync(lockfile, "utf8"));
        out(`Packages not from the registry in ${path.relative(process.cwd(), lockfile) || lockfile}: ${[...local].sort().join(", ") || "none"}`);
        const firstParty = (name: string) => name.startsWith("@tjalve/") || local.has(name);
        for (const entry of extractRelease(path.resolve(dir), path.resolve(to), { firstParty })) {
          out(`Extracted ${entry.files} files from ${path.relative(process.cwd(), entry.archive)} into ${path.relative(process.cwd(), entry.out)}; first-party packages: ${entry.firstParty.join(", ") || "(none)"}`);
        }
        return 0;
      }
      case "smoke": {
        const split = args.indexOf("--");
        const programArgs = split === -1 ? [] : args.slice(split + 1);
        if (split !== -1) args = args.slice(0, split);
        const program = flag(args, "--program");
        const to = flag(args, "--out");
        if (!program || !to) throw new UsageError("smoke needs --program <path> --out <dir>.");
        const seconds = Number(flag(args, "--timeout") ?? "180");
        if (!Number.isFinite(seconds) || seconds <= 0) throw new UsageError("--timeout needs a number of seconds.");
        const expect = flag(args, "--expect");
        const { result } = await runSmoke({ program: path.resolve(program), out: path.resolve(to), args: programArgs, timeoutMs: seconds * 1000, expect, log: out });
        out(`Smoke test passed: ${result.productName} ${result.version} on ${result.platform}-${result.arch} showed "${result.title ?? ""}" (HTTP ${result.status ?? "?"}, ${result.textLength ?? 0} characters${expect ? `, with "${expect}"` : ""}) after ${result.elapsedMs} ms and quit.`);
        return 0;
      }
      case "services": {
        const [sub] = positionals(args, ["--from", "--pins", "--out", "--target", "--services"]);
        const pins = path.resolve(flag(args, "--pins") ?? "services.json");
        if (sub === "pin") {
          const from = flag(args, "--from");
          if (!from) throw new UsageError("services pin needs --from <dir>.");
          const result = pinServices({ from: path.resolve(from), file: pins });
          for (const [app, service] of Object.entries(result.services)) out(`${app} ${service.version}: ${Object.keys(service.targets).sort().join(", ")}`);
          out(`Wrote ${pins}`);
          return 0;
        }
        if (sub === "stage") {
          const from = flag(args, "--from");
          const to = flag(args, "--out");
          if (!from || !to) throw new UsageError("services stage needs --from <dir> --out <dir>.");
          stageServices({ pins, from: path.resolve(from), out: path.resolve(to), target: flag(args, "--target") ?? serviceTarget(), log: out });
          return 0;
        }
        if (sub === "status") {
          const dir = flag(args, "--services");
          out(JSON.stringify(servicesStatus({ services: dir ? path.resolve(dir) : undefined }), null, 2));
          return 0;
        }
        throw new UsageError("services needs pin, stage or status.");
      }
      case "version": {
        const files = (flag(args, "--files") ?? "package.json").split(",").filter(Boolean);
        const result = assertReleaseVersion({ versions: files.map(readPackageVersion), releaseTag: releaseTagFromEnv(), requireTag: args.includes("--require-tag") });
        out(`Release version ${result.version}${result.tag ? ` (${result.tag})` : ""} OK`);
        return 0;
      }
      case undefined:
      case "help":
      case "--help":
        out(USAGE);
        return command === undefined ? 2 : 0;
      default:
        throw new UsageError(`Unknown command: ${command}`);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    if (error instanceof UsageError) {
      process.stderr.write(USAGE);
      return 2;
    }
    return 1;
  }
}
