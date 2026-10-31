import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { builderConfig, executableName } from "../src/builder.js";
import { desktopProgram, findWindowsCsc, unixCliShim, windowsCliLauncherSource, writeCliShim } from "../src/cli-shim.js";
import { checkSafeStorage, CookieKeyTimeoutError, cookieKeyFailureNeedsNewProcess, cookieName, isLaunchToken, setTokenCookie, tokenCookieDetails, type AsyncSafeStorage } from "../src/cookie.js";
import { assertOutsideInstall, isInsideDirectory, packagedInstallDirectory } from "../src/home.js";
import { buildIcns, buildIco } from "../src/icons.js";
import { aboutPageHtml, crashPageHtml, escapeHtml, parseNotices } from "../src/pages.js";
import { createReadyLineReader, formatReadyLine, isAllowedAppUrl, isAllowedExternalUrl, parseReadyLine } from "../src/ready-line.js";
import { FIRST_PARTY_MODULES, assertPackedAppFiles, assertReleaseVersion, artifactPattern, extractAsar, extractRelease, isReleaseCandidate, listAsarFiles, mergeBuilderChecksums, nonRegistryPackages, normalizeLinuxArtifactNames, packageOfPath, parseReleaseTag, readPackageVersion, writeChecksums } from "../src/release.js";
import { SMOKE_ENV, createSmokeRecorder, pageOutcome, smokeEventLine, smokeFolder } from "../src/smoke.js";
import { DESKTOP_ENV, announceReady, desktopLaunch, macAppBundle, onDesktopStop, openCommand, openDesktopApp } from "../src/server.js";

const TOKEN_FILE = process.platform === "win32" ? "C:\\Users\\ada\\State\\token" : "/home/ada/state/token";

describe("ready line", () => {
  it("round-trips an announcement", () => {
    const line = formatReadyLine({ app: "photos", url: "http://127.0.0.1:53124", tokenFile: TOKEN_FILE });
    expect(parseReadyLine(line, "photos")).toEqual({ app: "photos", port: 53124, url: "http://127.0.0.1:53124", tokenFile: TOKEN_FILE });
  });

  it.each([
    ["another app", formatReadyLine({ app: "study", url: "http://127.0.0.1:1", tokenFile: TOKEN_FILE })],
    ["localhost", formatReadyLine({ app: "photos", url: "http://localhost:5000", tokenFile: TOKEN_FILE })],
    ["https", formatReadyLine({ app: "photos", url: "https://127.0.0.1:5000", tokenFile: TOKEN_FILE })],
    ["a path", formatReadyLine({ app: "photos", url: "http://127.0.0.1:5000/x", tokenFile: TOKEN_FILE })],
    ["no port", formatReadyLine({ app: "photos", url: "http://127.0.0.1", tokenFile: TOKEN_FILE })],
    ["a user", formatReadyLine({ app: "photos", url: "http://a:b@127.0.0.1:5000", tokenFile: TOKEN_FILE })],
    ["a relative token file", formatReadyLine({ app: "photos", url: "http://127.0.0.1:5000", tokenFile: "state/token" })],
    ["not JSON", "MEMEX_READY {"],
    ["an array", "MEMEX_READY []"],
    ["another line", "Server on http://127.0.0.1:5000"],
  ])("refuses %s", (_name, line) => {
    expect(parseReadyLine(line, "photos")).toBeNull();
  });

  it("reads split chunks and keeps the other lines", () => {
    const seen: string[] = [];
    const reader = createReadyLineReader("photos", (line) => seen.push(line));
    const line = formatReadyLine({ app: "photos", url: "http://127.0.0.1:4000", tokenFile: TOKEN_FILE });
    expect(reader.push("starting\r\nMEMEX_RE")).toBeNull();
    expect(reader.push(`${line.slice("MEMEX_RE".length)}\nafter\n`)?.port).toBe(4000);
    expect(seen).toEqual(["starting", "after"]);
    expect(reader.tail()).toEqual(["starting", "after"]);
  });

  it("keeps only the last 40 lines", () => {
    const reader = createReadyLineReader("photos");
    reader.push(Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n") + "\n");
    expect(reader.tail()).toHaveLength(40);
    expect(reader.tail()[0]).toBe("line 20");
  });

  it("allows only the app's own pages and https links to other hosts", () => {
    expect(isAllowedAppUrl("http://127.0.0.1:4000/x?y", 4000)).toBe(true);
    expect(isAllowedAppUrl("http://127.0.0.1:4001/", 4000)).toBe(false);
    expect(isAllowedAppUrl("http://localhost:4000/", 4000)).toBe(false);
    expect(isAllowedExternalUrl("https://example.org/a")).toBe(true);
    for (const url of ["http://example.org", "https://localhost/", "https://127.0.0.2/", "https://[::1]/", "https://[::ffff:7f00:1]/", "https://u:p@example.org", "file:///etc/passwd", "javascript:alert(1)"]) {
      expect(isAllowedExternalUrl(url), url).toBe(false);
    }
  });
});

describe("server helpers", () => {
  it("reads what the shell set", () => {
    expect(desktopLaunch({})).toEqual({ desktop: false });
    expect(desktopLaunch({ [DESKTOP_ENV.app]: "photos", [DESKTOP_ENV.executable]: "C:\\P\\Memex Photos.exe", [DESKTOP_ENV.cli]: "C:\\P\\resources\\bin\\memex-photos.exe" })).toEqual({
      desktop: true,
      app: "photos",
      executable: "C:\\P\\Memex Photos.exe",
      mcp: { command: "C:\\P\\resources\\bin\\memex-photos.exe", args: ["mcp"] },
    });
    expect(desktopLaunch({ [DESKTOP_ENV.app]: "photos", [DESKTOP_ENV.cli]: "" }).mcp).toBeUndefined();
  });

  it("writes one ready line", () => {
    let text = "";
    announceReady({ app: "photos", url: "http://127.0.0.1:9", tokenFile: TOKEN_FILE }, (t) => (text += t));
    expect(text.endsWith("\n")).toBe(true);
    expect(parseReadyLine(text, "photos")?.port).toBe(9);
  });

  it("does nothing without a stop mode", () => {
    let exited: number | null = null;
    onDesktopStop(() => undefined, { env: {}, exit: (code) => (exited = code) });
    expect(exited).toBeNull();
  });
});

describe("token cookie", () => {
  const token = "a".repeat(43);
  it("is HttpOnly, SameSite=Strict, Path=/ and named per app", () => {
    expect(cookieName("photos")).toBe("memex_photos_token");
    expect(tokenCookieDetails("photos", "http://127.0.0.1:5", token)).toEqual({
      url: "http://127.0.0.1:5",
      name: "memex_photos_token",
      value: token,
      path: "/",
      httpOnly: true,
      secure: false,
      sameSite: "strict",
    });
  });
  it("refuses what is not a launch token", () => {
    expect(isLaunchToken(`${token}=`)).toBe(false);
    expect(() => tokenCookieDetails("photos", "http://127.0.0.1:5", "short")).toThrow();
  });
  it("gives up on a cookie that is never stored, and passes a refusal on", async () => {
    await expect(setTokenCookie(() => Promise.resolve(), 1000)).resolves.toBeUndefined();
    await expect(setTokenCookie(() => new Promise<void>(() => {}), 20)).rejects.toThrow(/not stored within 20 ms/);
    await expect(setTokenCookie(() => Promise.reject(new Error("denied")), 1000)).rejects.toThrow("denied");
  });
  it("checks the cookie key: a round trip passes; refused, unanswered or broken keys fail", async () => {
    const key = 7;
    const working: AsyncSafeStorage = {
      isAsyncEncryptionAvailable: async () => true,
      encryptStringAsync: async (text) => Buffer.from(Buffer.from(text).map((b) => b ^ key)),
      decryptStringAsync: async (sealed) => ({ result: Buffer.from(sealed.map((b) => b ^ key)).toString() }),
    };
    await expect(checkSafeStorage(working, "Memex Hello", 1000)).resolves.toBeUndefined();
    await expect(checkSafeStorage({ ...working, isAsyncEncryptionAvailable: async () => false }, "Memex Hello", 1000)).rejects.toThrow(/"Memex Hello Safe Storage"\) is not available/);
    await expect(checkSafeStorage({ ...working, encryptStringAsync: () => new Promise<Buffer>(() => {}) }, "Memex Hello", 20)).rejects.toThrow(/not available within 20 ms.*locked.*denied/);
    await expect(checkSafeStorage({ ...working, encryptStringAsync: async (text) => Buffer.from(text) }, "Memex Hello", 1000)).rejects.toThrow(/did not encrypt/);
    await expect(checkSafeStorage({ ...working, decryptStringAsync: async () => ({ result: "other" }) }, "Memex Hello", 1000)).rejects.toThrow(/did not decrypt/);
    await expect(checkSafeStorage({ ...working, encryptStringAsync: () => Promise.reject(new Error("errSecAuthFailed")) }, "Memex Hello", 1000)).rejects.toThrow(/could not be used: the login keychain may be locked, or access to the key was denied \(errSecAuthFailed\)/);
 
  });
  it("restarts in a new process after a refused cookie key, and only the server after a timeout", async () => {
    const working: AsyncSafeStorage = {
      isAsyncEncryptionAvailable: async () => true,
      encryptStringAsync: async (text) => Buffer.from(Buffer.from(text).map((b) => b ^ 7)),
      decryptStringAsync: async (sealed) => ({ result: Buffer.from(sealed.map((b) => b ^ 7)).toString() }),
    };
    const failure = (storage: AsyncSafeStorage, timeoutMs: number) => checkSafeStorage(storage, "Memex Hello", timeoutMs).then(() => null, (error: unknown) => error);
    const timedOut = await failure({ ...working, encryptStringAsync: () => new Promise<Buffer>(() => {}) }, 20);
    expect(timedOut).toBeInstanceOf(CookieKeyTimeoutError);
    expect(cookieKeyFailureNeedsNewProcess(timedOut)).toBe(false);
    for (const refused of [
      await failure({ ...working, encryptStringAsync: () => Promise.reject(new Error("errSecAuthFailed")) }, 1000),
      await failure({ ...working, isAsyncEncryptionAvailable: async () => false }, 1000),
      await failure({ ...working, decryptStringAsync: async () => ({ result: "other" }) }, 1000),
    ]) {
      expect(refused).toBeInstanceOf(Error);
      expect(cookieKeyFailureNeedsNewProcess(refused)).toBe(true);
    }
  });
});

describe("install folder", () => {
  it("finds the installation folder", () => {
    expect(packagedInstallDirectory({ packaged: false, exePath: "C:\\P\\a.exe" })).toBeNull();
    expect(packagedInstallDirectory({ packaged: true, platform: "win32", exePath: "C:\\Users\\ada\\AppData\\Local\\Programs\\Memex Photos\\Memex Photos.exe" })).toBe(
      "C:\\Users\\ada\\AppData\\Local\\Programs\\Memex Photos",
    );
    expect(packagedInstallDirectory({ packaged: true, platform: "darwin", exePath: "/Applications/Memex Photos.app/Contents/MacOS/Memex Photos" })).toBe("/Applications/Memex Photos.app");
  });

  it("refuses data inside it", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "memex-desktop-"));
    const install = path.join(root, "Programs", "App");
    mkdirSync(install, { recursive: true });
    const outside = { data: path.join(root, "Data"), state: path.join(root, "State"), cache: path.join(root, "Cache"), logs: path.join(root, "Logs") };
    expect(() => assertOutsideInstall(outside, install)).not.toThrow();
    expect(() => assertOutsideInstall({ ...outside, data: path.join(install, "data") }, install)).toThrow(/data folder/);
    expect(isInsideDirectory(install, install)).toBe(true);
    expect(isInsideDirectory(`${install}2`, install)).toBe(false);
  });
});

describe("pages", () => {
  it("escapes everything it shows", () => {
    expect(escapeHtml(`<a href="x">'&`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;");
    const html = crashPageHtml({ productName: "Memex <Photos>", reason: "x", code: 3, output: ["<script>alert(1)</script>"] });
    expect(html).not.toContain("<script>alert(1)");
    expect(html).toContain("Exit code 3.");
    expect(html).toContain('id="restart"');
  });

  it("reads notices.json and lists every component in About", () => {
    const notices = parseNotices(
      JSON.stringify({
        format: "memex.notices/1",
        product: "Memex Photos",
        components: [
          { name: "zod", version: "4.6.5", license: "MIT", homepage: "https://zod.dev", copyright: ["Copyright (c) 2025 Colin McDonnell"] },
          { name: "evil", homepage: "javascript:alert(1)", license: null, copyright: [] },
        ],
      }),
    );
    const html = aboutPageHtml({ productName: "Memex Photos", version: "1.0.0", license: "AGPL-3.0-or-later", notices, canOpenNotices: true });
    expect(html).toContain('<a href="https://zod.dev"');
    expect(html).not.toContain("javascript:alert");
    expect(html).toContain("2 components");
    expect(html).toContain("license unknown");
    expect(() => parseNotices('{"format":"other","components":[]}')).toThrow();
  });
});

describe("CLI shims", () => {
  const options = { app: "photos", executableName: "Memex Photos.exe", cliEntry: "cli/main.mjs" };
  it("run the CLI with the program's own Node.js", () => {
    const source = windowsCliLauncherSource(options);
    expect(source).toContain('const string Program = "Memex Photos.exe";');
    expect(source).toContain('new string[] { "cli", "main.mjs" }');
    expect(source).toContain('SetEnvironmentVariable("ELECTRON_RUN_AS_NODE", "1")');
    expect(source).not.toContain("%*");
    expect(unixCliShim({ ...options, executableName: "Memex Photos" }, "darwin")).toContain('exec "$here/../../MacOS/Memex Photos" "$here/../app.asar/cli/main.mjs" "$@"');
    expect(unixCliShim({ ...options, executableName: "memex-photos" }, "linux")).toContain('exec "$here/../../memex-photos"');
  });
  it("refuse names they cannot quote", () => {
    expect(() => windowsCliLauncherSource({ ...options, executableName: 'a"&b.exe' })).toThrow();
    expect(() => windowsCliLauncherSource({ ...options, cliEntry: "../x.mjs" })).toThrow();
    expect(() => windowsCliLauncherSource({ ...options, app: "Photos" })).toThrow();
  });
  it("are written per platform", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "memex-shim-"));
    const file = await writeCliShim(dir, { ...options, executableName: "memex-photos" }, "linux");
    expect(path.basename(file)).toBe("memex-photos");
    expect(readFileSync(file, "utf8")).toContain("ELECTRON_RUN_AS_NODE=1");
  });
  it.runIf(process.platform === "win32" && findWindowsCsc() !== undefined)(
    "on Windows: pass every argument unchanged, without cmd.exe, with stdin and the exit code",
    async () => {
      // An installed layout: <root>/<program>, <root>/resources/bin/<shim>, <root>/resources/app.asar/<entry>. The
      // program is a copy of this Node.js, and app.asar is a plain folder that Node.js reads.
      const root = mkdtempSync(path.join(os.tmpdir(), "memex-shim-run-"));
      copyFileSync(process.execPath, path.join(root, "Memex Photos.exe"));
      mkdirSync(path.join(root, "resources", "app.asar", "cli"), { recursive: true });
      writeFileSync(
        path.join(root, "resources", "app.asar", "cli", "main.mjs"),
        "import { spawn } from 'node:child_process'; " +
          // A program the CLI starts (as open starts the app) must outlive the shim.
          `spawn(process.execPath, ['-e', 'setTimeout(() => require("fs").writeFileSync(process.argv[1], "ok"), 4000)', ${JSON.stringify(path.join(root, "later.txt"))}], { detached: true, stdio: 'ignore' }).unref(); ` +
          "let input = ''; process.stdin.on('data', (c) => (input += c)); process.stdin.on('end', () => { " +
          "process.stdout.write(JSON.stringify({ args: process.argv.slice(2), runAsNode: process.env.ELECTRON_RUN_AS_NODE, input })); process.exitCode = 7 })",
      );
      const shim = await writeCliShim(path.join(root, "resources", "bin"), options, "win32");
      expect(path.basename(shim)).toBe("memex-photos.exe");
      const args = ["call", "photos.items.get", '{"name":"x & echo INJECTED & rem "}', 'a "quoted" word', "100%", "^|<>", "", "trailing\\"];
      const started = Date.now();
      const result = spawnSync(shim, args, { input: '{"from":"stdin"}', encoding: "utf8", shell: false });
      expect(result.status).toBe(7);
      // The started program holds no handle to this caller's pipes, so the caller does not wait for it.
      expect(Date.now() - started).toBeLessThan(3500);
      expect(existsSync(path.join(root, "later.txt"))).toBe(false);
      expect(result.stdout).not.toContain("INJECTED\r\n");
      expect(JSON.parse(result.stdout)).toEqual({ args, runAsNode: "1", input: '{"from":"stdin"}' });
      for (let i = 0; i < 200 && !existsSync(path.join(root, "later.txt")); i++) await new Promise((r) => setTimeout(r, 50));
      expect(existsSync(path.join(root, "later.txt"))).toBe(true);
    },
    60_000,
  );
  it("name the AppImage itself as the program, and no shim, because its mount goes away", () => {
    expect(
      desktopProgram({ app: "photos", packaged: true, exePath: "/tmp/.mount_MemexAb12/memex-photos", resourcesPath: "/tmp/.mount_MemexAb12/resources", platform: "linux", env: { APPIMAGE: "/home/alex/Apps/Memex.Photos-1.0.0-linux-x64.AppImage" } }),
    ).toEqual({ executable: "/home/alex/Apps/Memex.Photos-1.0.0-linux-x64.AppImage", cli: undefined });
    expect(desktopProgram({ app: "photos", packaged: true, exePath: "/opt/Memex Photos/memex-photos", resourcesPath: "/nowhere", platform: "linux", env: {} })).toEqual({
      executable: "/opt/Memex Photos/memex-photos",
      cli: undefined,
    });
  });
});

describe("open", () => {
  it("starts the program without ELECTRON_RUN_AS_NODE and the shell's variables", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "memex-open-"));
    const out = path.join(dir, "env.json");
    const script = `require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify({ runAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null, app: process.env.MEMEX_DESKTOP_APP ?? null }))`;
    await openDesktopApp({ executable: process.execPath, args: ["-e", script], env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", MEMEX_DESKTOP_APP: "photos" } });
    for (let i = 0; i < 100 && !existsSync(out); i++) await new Promise((r) => setTimeout(r, 50));
    expect(JSON.parse(readFileSync(out, "utf8"))).toEqual({ runAsNode: null, app: null });
  });

  it("opens a macOS app bundle through LaunchServices with the MEMEX_* variables, and other programs directly", () => {
    const program = "/Applications/Memex Photos.app/Contents/MacOS/Memex Photos";
    expect(macAppBundle(program)).toBe("/Applications/Memex Photos.app");
    expect(macAppBundle("/usr/local/bin/memex-photos")).toBeUndefined();
    const env = { MEMEX_PHOTOS_HOME: "/tmp/p", PATH: "/usr/bin", MEMEX_HOME: "/tmp/m" };
    expect(openCommand(program, [], env, "darwin")).toEqual({
      command: "/usr/bin/open",
      args: ["-a", "/Applications/Memex Photos.app", "--env", "MEMEX_HOME=/tmp/m", "--env", "MEMEX_PHOTOS_HOME=/tmp/p"],
    });
    expect(openCommand(program, ["--x"], {}, "darwin").args).toEqual(["-a", "/Applications/Memex Photos.app", "--args", "--x"]);
    expect(openCommand("/opt/Memex Photos/memex-photos", ["--x"], env, "linux")).toEqual({ command: "/opt/Memex Photos/memex-photos", args: ["--x"] });
    expect(openCommand(program, [], env, "win32").command).toBe(program);
  });
});

describe("builder config", () => {
  it("builds per-user NSIS, an arm64 dmg, AppImage and deb, with to.memex.<app>", () => {
    const config = builderConfig({ app: "photos", productName: "Memex Photos", files: ["main.mjs"], notices: "build/notices", cliShims: "build/cli-shims" }) as Record<string, any>;
    expect(config.appId).toBe("to.memex.photos");
    expect(config.files).toEqual(["main.mjs", "!**/*.map"]);
    expect(config.publish).toBeNull();
    expect(config.nsis).toMatchObject({ oneClick: false, perMachine: false, allowElevation: false, deleteAppDataOnUninstall: false });
    expect(config.win.target).toEqual([{ target: "nsis", arch: ["x64"] }]);
    expect(config.win.artifactName).toBe("Memex.Photos-${version}-windows-${arch}.${ext}");
    expect(config.mac.target).toEqual([{ target: "dmg", arch: ["arm64"] }]);
    // Ad-hoc until a Developer ID is chosen: Apple silicon stops a bundle whose fuses changed after its signature.
    // The hardened runtime always; an ad-hoc signature also turns library validation off, and nothing allows DYLD_ variables.
    expect(config.mac).toMatchObject({ identity: "-", hardenedRuntime: true });
    expect(config.mac.entitlements).toBe(config.mac.entitlementsInherit);
    const adhoc = readFileSync(config.mac.entitlements, "utf8");
    expect(adhoc).toContain("<key>com.apple.security.cs.allow-jit</key>");
    expect(adhoc).toContain("<key>com.apple.security.cs.disable-library-validation</key>");
    expect(adhoc).not.toContain("<key>com.apple.security.cs.allow-dyld-environment-variables</key>");
    const signed = (builderConfig({ app: "photos", productName: "Memex Photos", files: [], macIdentity: "Developer ID Application: Example" }) as Record<string, any>).mac;
    expect(signed).toMatchObject({ identity: "Developer ID Application: Example", hardenedRuntime: true });
    const signedText = readFileSync(signed.entitlements, "utf8");
    expect(signedText).toContain("<key>com.apple.security.cs.allow-jit</key>");
    expect(signedText).not.toContain("<key>com.apple.security.cs.disable-library-validation</key>");
    expect(signedText).not.toContain("<key>com.apple.security.cs.allow-dyld-environment-variables</key>");
    expect(config.linux.target.map((t: { target: string }) => t.target)).toEqual(["AppImage", "deb"]);
    expect(config.linux.executableName).toBe("memex-photos");
    expect(config.extraResources).toEqual([{ from: "build/notices", to: "notices", filter: ["**/*"] }]);
    expect(config.win.extraResources).toEqual([{ from: "build/cli-shims/win32", to: "bin", filter: ["memex-photos.exe"] }]);
    expect(config.linux.extraResources).toEqual([{ from: "build/cli-shims/linux", to: "bin", filter: ["memex-photos"] }]);
    expect(config.electronFuses).toMatchObject({ runAsNode: false, onlyLoadAppFromAsar: true, enableNodeOptionsEnvironmentVariable: false });
    expect((builderConfig({ app: "photos", productName: "Memex Photos", files: [], runAsNode: true }) as Record<string, any>).electronFuses.runAsNode).toBe(true);
    expect(executableName({ app: "photos", productName: "Memex Photos" }, "win32")).toBe("Memex Photos.exe");
    const deb = builderConfig({ app: "photos", productName: "Memex Photos", files: [], homepage: "https://example.org/photos", maintainer: "Example Maintainer <maintainer@example.org>" }) as Record<string, any>;
    expect(deb.extraMetadata).toEqual({ homepage: "https://example.org/photos" });
    expect(deb.linux.maintainer).toBe("Example Maintainer <maintainer@example.org>");
    expect(() => builderConfig({ app: "Photos", productName: "x", files: [] })).toThrow();
  });
});

describe("release scripts", () => {
  it("checks versions and tags", () => {
    expect(parseReleaseTag("v1.2.3")).toBe("1.2.3");
    expect(parseReleaseTag("1.2.3")).toBeNull();
    expect(assertReleaseVersion({ versions: ["1.2.3", "1.2.3"] })).toEqual({ version: "1.2.3", tag: null });
    expect(assertReleaseVersion({ versions: ["1.2.3"], releaseTag: "v1.2.3" }).tag).toBe("v1.2.3");
    expect(() => assertReleaseVersion({ versions: ["1.2.3", "1.2.4"] })).toThrow(/differ/);
    expect(() => assertReleaseVersion({ versions: ["1.2.3"], releaseTag: "v1.2.4" })).toThrow();
    expect(() => assertReleaseVersion({ versions: ["1.2.3"], requireTag: true })).toThrow();
  });

  it("takes release candidates (X.Y.Z-rc.N) for the beta channel", () => {
    expect(parseReleaseTag("v1.0.0-rc.1")).toBe("1.0.0-rc.1");
    expect(parseReleaseTag("v1.0.0-rc")).toBeNull();
    expect(parseReleaseTag("v1.0.0-beta.1")).toBeNull();
    expect(isReleaseCandidate("v1.0.0-rc.2")).toBe(true);
    expect(isReleaseCandidate("1.0.0-rc.2")).toBe(true);
    expect(isReleaseCandidate("v1.0.0")).toBe(false);
    expect(assertReleaseVersion({ versions: ["1.0.0-rc.1", "1.0.0-rc.1"], releaseTag: "v1.0.0-rc.1", requireTag: true }).tag).toBe("v1.0.0-rc.1");
    expect(() => assertReleaseVersion({ versions: ["1.0.0-rc.1"], releaseTag: "v1.0.0-rc.2" })).toThrow(/does not match/);
    expect(() => assertReleaseVersion({ versions: ["1.0.0"], releaseTag: "v1.0.0-rc.1" })).toThrow(/does not match/);
    const dir = mkdtempSync(path.join(os.tmpdir(), "memex-rc-"));
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version: "1.0.0-rc.1" }));
    expect(readPackageVersion(path.join(dir, "package.json"))).toBe("1.0.0-rc.1");
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version: "1.0.0-beta" }));
    expect(() => readPackageVersion(path.join(dir, "package.json"))).toThrow(/X\.Y\.Z-rc\.N/);
    expect(artifactPattern("Memex.Photos").test("Memex.Photos-1.0.0-rc.1-windows-x64.exe")).toBe(true);
    expect(artifactPattern("Memex.Photos").test("Memex.Photos-1.0.0-beta-windows-x64.exe")).toBe(false);
    writeFileSync(path.join(dir, "Memex.Photos-1.0.0-rc.1-linux-amd64.deb"), "deb");
    expect(normalizeLinuxArtifactNames(dir, "Memex.Photos")).toEqual([{ from: "Memex.Photos-1.0.0-rc.1-linux-amd64.deb", to: "Memex.Photos-1.0.0-rc.1-linux-x64.deb" }]);
  });

  it("names, renames and sums the installers", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "memex-release-"));
    writeFileSync(path.join(dir, "Memex.Photos-1.0.0-windows-x64.exe"), "exe");
    writeFileSync(path.join(dir, "Memex.Photos-1.0.0-linux-x86_64.AppImage"), "appimage");
    writeFileSync(path.join(dir, "Memex.Photos-1.0.0-windows-x64.exe.blockmap"), "map");
    expect(artifactPattern("Memex.Photos").test("Memex.Photos-1.0.0-macos-arm64.dmg")).toBe(true);
    expect(normalizeLinuxArtifactNames(dir, "Memex.Photos")).toEqual([{ from: "Memex.Photos-1.0.0-linux-x86_64.AppImage", to: "Memex.Photos-1.0.0-linux-x64.AppImage" }]);
    const sums = writeChecksums(dir, "Memex.Photos");
    expect(sums.names).toEqual(["Memex.Photos-1.0.0-linux-x64.AppImage", "Memex.Photos-1.0.0-windows-x64.exe"]);
    const text = readFileSync(sums.outputPath, "utf8");
    expect(text).toMatch(/^[a-f0-9]{64} {2}Memex\.Photos-1\.0\.0-linux-x64\.AppImage\n[a-f0-9]{64} {2}Memex\.Photos-1\.0\.0-windows-x64\.exe\n$/);

    const [linux, windows] = text.trim().split("\n");
    writeFileSync(path.join(dir, "SHA256SUMS-linux.txt"), `${linux}\n`);
    writeFileSync(path.join(dir, "SHA256SUMS-windows.txt"), `${windows}\n`);
    expect((await mergeBuilderChecksums(dir, "Memex.Photos")).names).toHaveLength(2);
    writeFileSync(path.join(dir, "Memex.Photos-1.0.0-windows-x64.exe"), "changed");
    await expect(mergeBuilderChecksums(dir, "Memex.Photos")).rejects.toThrow(/mismatch/);
  });

  it("checks the packed files", () => {
    expect(() => assertPackedAppFiles(["main.mjs", "a.js"], { required: ["main.mjs"] })).not.toThrow();
    expect(() => assertPackedAppFiles(["main.mjs", "a.js.map"])).toThrow(/source maps/);
    expect(() => assertPackedAppFiles(["a.js"], { required: ["main.mjs"] })).toThrow(/missing/);
    expect(() => assertPackedAppFiles(["server/x.mjs"], { forbiddenPrefixes: ["server/"] })).toThrow(/must not include/);
  });
});

describe("icons", () => {
  const png = (size: number) => {
    const b = Buffer.alloc(33);
    b.writeUInt32BE(0x89504e47, 0);
    b.writeUInt32BE(size, 16);
    b.writeUInt32BE(size, 20);
    return b;
  };
  it("writes ico and icns containers", () => {
    const ico = buildIco([png(16), png(256)]);
    expect(ico.readUInt16LE(4)).toBe(2);
    expect(ico.readUInt8(6)).toBe(16);
    expect(ico.readUInt8(22)).toBe(0);
    expect(ico.readUInt32LE(6 + 12)).toBe(6 + 32);
    const icns = buildIcns({ ic07: png(128), ic08: png(256), ic09: png(512) });
    expect(icns.subarray(0, 4).toString("ascii")).toBe("icns");
    expect(icns.readUInt32BE(4)).toBe(icns.length);
    expect(() => buildIco([Buffer.from("not png")])).toThrow();
  });
});

// An asar archive as electron-builder writes it: a pickled JSON header, then the file contents.
function asar(files: Record<string, unknown>, data: Buffer): Buffer {
  const json = Buffer.from(JSON.stringify({ files }));
  const padded = Math.ceil(json.length / 4) * 4;
  const head = Buffer.alloc(16 + padded);
  head.writeUInt32LE(4, 0);
  head.writeUInt32LE(padded + 8, 4);
  head.writeUInt32LE(padded + 4, 8);
  head.writeUInt32LE(json.length, 12);
  json.copy(head, 16);
  return Buffer.concat([head, data]);
}

describe("extract", () => {
  it("writes the files of app.asar and the rest of the resources folder", () => {
    const release = mkdtempSync(path.join(os.tmpdir(), "memex-extract-"));
    const resources = path.join(release, "win-unpacked", "resources");
    mkdirSync(path.join(resources, "app.asar.unpacked", "native"), { recursive: true });
    mkdirSync(path.join(resources, "bin"), { recursive: true });
    mkdirSync(path.join(resources, "notices"), { recursive: true });
    writeFileSync(path.join(resources, "app.asar.unpacked", "native", "x.node"), "native");
    writeFileSync(path.join(resources, "bin", "memex-hello"), "#!/bin/sh");
    writeFileSync(path.join(resources, "notices", "notices.json"), "{}");
    writeFileSync(path.join(resources, "default_app.asar"), "electron's own");
    const files = {
      "main.mjs": { size: 5, offset: "0" },
      server: { files: { "a.mjs": { size: 3, offset: "5" } } },
      native: { files: { "x.node": { size: 6, unpacked: true } } },
    };
    writeFileSync(path.join(resources, "app.asar"), asar(files, Buffer.from("main!abc")));
    expect(listAsarFiles(path.join(resources, "app.asar"))).toEqual(["main.mjs", "native/x.node", "server/a.mjs"]);

    const out = path.join(mkdtempSync(path.join(os.tmpdir(), "memex-extracted-")), "ship");
    const result = extractRelease(release, out);
    expect(result).toHaveLength(1);
    expect(result[0]!.files).toBe(5);
    const build = path.join(out, "win-unpacked");
    expect(readFileSync(path.join(build, "app", "main.mjs"), "utf8")).toBe("main!");
    expect(readFileSync(path.join(build, "app", "server", "a.mjs"), "utf8")).toBe("abc");
    expect(readFileSync(path.join(build, "app", "native", "x.node"), "utf8")).toBe("native");
    expect(readFileSync(path.join(build, "resources", "bin", "memex-hello"), "utf8")).toBe("#!/bin/sh");
    expect(existsSync(path.join(build, "resources", "notices", "notices.json"))).toBe(true);
    expect(existsSync(path.join(build, "resources", "default_app.asar"))).toBe(false);
    expect(() => extractRelease(release, out)).toThrow(/not empty/);
  });

  it("puts first-party packages under their own folder, and keeps registry packages under node_modules", () => {
    const lock = [
      "importers:",
      "  apps/desktop:",
      "    dependencies:",
      "      '@tjalve/memex-desktop':",
      "        specifier: workspace:*",
      "        version: link:../../packages/desktop",
      "      local-kit:",
      "        specifier: file:../vendor/local-kit-1.0.0.tgz",
      "        version: file:../vendor/local-kit-1.0.0.tgz",
      "      zod:",
      "        specifier: 4.6.6",
      "        version: 4.6.6",
      "packages:",
      "  'git-kit@https://codeload.github.com/example/git-kit/tar.gz/0123456789abcdef':",
      "    resolution: {tarball: https://codeload.github.com/example/git-kit/tar.gz/0123456789abcdef}",
      "snapshots:",
      "  'local-kit@file:../vendor/local-kit-1.0.0.tgz':",
      "    dependencies:",
      "      nested-local: link:../nested",
      "      zod: 4.6.6",
    ].join("\n");
    expect([...nonRegistryPackages(lock)].sort()).toEqual(["@tjalve/memex-desktop", "git-kit", "local-kit", "nested-local"]);
    expect(packageOfPath(["node_modules", "@tjalve", "memex-storage", "dist", "index.js"])).toBe("@tjalve/memex-storage");
    expect(packageOfPath(["node_modules", "@tjalve", "memex-desktop", "node_modules", "zod", "index.js"])).toBe("zod");
    expect(packageOfPath(["main.mjs"])).toBeNull();

    const release = mkdtempSync(path.join(os.tmpdir(), "memex-extract-fp-"));
    const resources = path.join(release, "win-unpacked", "resources");
    mkdirSync(resources, { recursive: true });
    const plain = Buffer.from("export {};\n");
    const canary = Buffer.from("export const contact = 'canary@example.org';\n");
    const at = (buffer: Buffer, offset: number) => ({ size: buffer.length, offset: String(offset) });
    const files = {
      "main.mjs": at(plain, 0),
      node_modules: {
        files: {
          "@tjalve": { files: { "memex-storage": { files: { "canary.js": at(canary, plain.length) } } } },
          "local-kit": { files: { "index.js": at(plain, 0), node_modules: { files: { zod: { files: { "index.js": at(plain, 0) } } } } } },
          zod: { files: { "index.js": at(plain, 0) } },
        },
      },
    };
    writeFileSync(path.join(resources, "app.asar"), asar(files, Buffer.concat([plain, canary])));
    const out = path.join(mkdtempSync(path.join(os.tmpdir(), "memex-extracted-fp-")), "ship");
    const local = nonRegistryPackages(lock);
    const [entry] = extractRelease(release, out, { firstParty: (name) => name.startsWith("@tjalve/") || local.has(name) });
    expect(entry!.firstParty).toEqual(["@tjalve/memex-storage", "local-kit"]);
    const app = path.join(out, "win-unpacked", "app");
    expect(readFileSync(path.join(app, FIRST_PARTY_MODULES, "@tjalve", "memex-storage", "canary.js"), "utf8")).toContain("canary@example.org");
    expect(existsSync(path.join(app, FIRST_PARTY_MODULES, "local-kit", "index.js"))).toBe(true);
    expect(existsSync(path.join(app, "node_modules", "@tjalve", "memex-storage", "canary.js"))).toBe(false);
    // A registry package stays under node_modules, also inside a first-party package.
    expect(existsSync(path.join(app, "node_modules", "zod", "index.js"))).toBe(true);
    expect(existsSync(path.join(app, "node_modules", "local-kit", "node_modules", "zod", "index.js"))).toBe(true);
  });

  it("refuses unsafe names, links and entries outside the archive", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "memex-asar-"));
    const bad = (files: Record<string, unknown>, data = Buffer.from("x")) => {
      const file = path.join(mkdtempSync(path.join(dir, "a-")), "app.asar");
      writeFileSync(file, asar(files, data));
      return () => extractAsar(file, path.join(path.dirname(file), "out"));
    };
    expect(bad({ "..": { files: { "evil.js": { size: 1, offset: "0" } } } })).toThrow(/unsafe name/);
    expect(bad({ "a\\b.js": { size: 1, offset: "0" } })).toThrow(/unsafe name/);
    expect(bad({ "a/b.js": { size: 1, offset: "0" } })).toThrow(/unsafe name/);
    expect(bad({ "C:evil.js": { size: 1, offset: "0" } })).toThrow(/unsafe name/);
    expect(bad({ "link.js": { link: "../outside" } })).toThrow(/link/);
    expect(bad({ "big.js": { size: 100, offset: "0" } })).toThrow(/overruns/);
  });
});

describe("smoke test", () => {
  it("reads the folder from the environment", () => {
    expect(smokeFolder({})).toBeNull();
    expect(() => smokeFolder({ [SMOKE_ENV]: "relative/folder" })).toThrow(/absolute/);
    const absolute = path.resolve("smoke-results");
    expect(smokeFolder({ [SMOKE_ENV]: absolute })).toBe(absolute);
  });

  it("passes only an HTTP 2xx first page with text and a picture", async () => {
    expect(pageOutcome(200)).toEqual({ ok: true, status: 200 });
    expect(pageOutcome(500)).toEqual({ ok: false, reason: "The first page answered HTTP 500.", status: 500 });
    expect(pageOutcome(401).ok).toBe(false);
    expect(pageOutcome(null).ok).toBe(false);
    const info = { app: "hello", productName: "Memex Hello", version: "0.1.0", platform: "win32", arch: "x64", electron: "44.7.0" };
    const png = { toPNG: () => Buffer.from("png") };
    const win = (text: string, capture: () => Promise<typeof png>) => ({
      isDestroyed: () => false,
      getTitle: () => "Memex Hello",
      webContents: { executeJavaScript: async () => text, capturePage: capture },
    });
    const folder = () => mkdtempSync(path.join(os.tmpdir(), "memex-smoke-"));
    const good = await createSmokeRecorder(folder(), info).finish(win("Hello, Memex!", async () => png) as never, pageOutcome(200));
    expect(good).toMatchObject({ ok: true, status: 200, textLength: 13, title: "Memex Hello" });
    const empty = await createSmokeRecorder(folder(), info).finish(win("  ", async () => png) as never, pageOutcome(200));
    expect(empty).toMatchObject({ ok: false, reason: "The first page shows no text." });
    const noPicture = await createSmokeRecorder(folder(), info).finish(win("Hello", async () => { throw new Error("no picture"); }) as never, pageOutcome(200));
    expect(noPicture?.ok).toBe(false);
    expect(noPicture?.reason).toMatch(/could not be captured: no picture/);
    const serverError = await createSmokeRecorder(folder(), info).finish(win("Internal Server Error", async () => png) as never, pageOutcome(500));
    expect(serverError).toMatchObject({ ok: false, status: 500, reason: "The first page answered HTTP 500." });
    expect(await createSmokeRecorder(folder(), info).finish(null, pageOutcome(200))).toMatchObject({ ok: false });
    // The page fills in after load: the recorder waits for the expected text, and fails when it never comes.
    let reads = 0;
    const filling = { ...win("", async () => png), webContents: { executeJavaScript: async () => (++reads < 4 ? "Cookie request waiting" : "Cookie request 200 Hello, Memex!"), capturePage: async () => png } };
    const waited = await createSmokeRecorder(folder(), info, { expect: "Hello, Memex!", waitMs: 5000 }).finish(filling as never, pageOutcome(200));
    expect(waited).toMatchObject({ ok: true });
    expect(reads).toBeGreaterThanOrEqual(4);
    const never = await createSmokeRecorder(folder(), info, { expect: "Hello, Memex!", waitMs: 500 }).finish(win("Cookie request waiting", async () => png) as never, pageOutcome(200));
    expect(never).toMatchObject({ ok: false, reason: "The first page does not show \"Hello, Memex!\"." });
    // A capture that fails now and then (software drawing) is tried again.
    let captures = 0;
    const flaky = await createSmokeRecorder(folder(), info).finish(win("Hello", async () => { if (++captures < 3) throw new Error("UnknownVizError"); return png; }) as never, pageOutcome(200));
    expect(flaky).toMatchObject({ ok: true });
    expect(captures).toBe(3);
  });

  it("records only plain values of an event", () => {
    const line = smokeEventLine({ type: "server-ready", announcement: { app: "hello", url: "http://127.0.0.1:4000", tokenFile: TOKEN_FILE, port: 4000 }, pid: 7, window: { secret: true } }, new Date(0));
    expect(JSON.parse(line)).toEqual({ at: "1970-01-01T00:00:00.000Z", type: "server-ready", announcement: { app: "hello", url: "http://127.0.0.1:4000" }, pid: 7 });
    expect(line.endsWith("\n")).toBe(true);
  });
});
