import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  THIRD_PARTY_FORMAT,
  buildInventory,
  checkInventory,
  classify,
  creditLines,
  electronComponent,
  identifyLicenseText,
  importReview,
  loadConfig,
  memexLicensesVite,
  packComponent,
  parseYaml,
  readFontNames,
  readLicenseText,
  readLockfile,
  readNpmPackage,
  territoriesFromLimits,
  readViteBuild,
  readZipEntries,
  unhashedName,
  writeNotices,
  type Config,
  type PackManifest,
} from "../src/index.js";
import { main } from "../src/cli.js";
import { BSD3_TEXT, GPL3_TEXT, MIT_TEXT, npmPackage, ttfWithNames, woff2WithNames, woffWithNames, write, writeJson, zipOf } from "./helpers.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "memex-licenses-test-")));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function run(argv: string[]): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  return main(argv, { out: (l) => lines.push(l) }).then((code) => ({ code, out: lines.join("\n") }));
}

describe("SPDX expressions", () => {
  it("picks the least restrictive choice", () => {
    expect(classify("MIT OR GPL-3.0-only").class).toBe("permissive");
    expect(classify("(MIT AND GPL-2.0-only)").class).toBe("copyleft");
    expect(classify("GPL-2.0-or-later WITH Classpath-exception-2.0").class).toBe("weak-copyleft");
    expect(classify("OFL-1.1 AND (OFL-1.1 OR GPL-2.0-or-later WITH Font-exception-2.0)").class).toBe("permissive");
  });

  it("knows non-commercial, public-domain, first-party and unknown licenses", () => {
    expect(classify("CC-BY-NC-SA-4.0").class).toBe("non-commercial");
    expect(classify("LicenseRef-FLUX-Non-Commercial-2.1").class).toBe("non-commercial");
    expect(classify("CC0-1.0").needsCredit).toBe(false);
    expect(classify("LicenseRef-Memex-AI-Art").class).toBe("first-party");
    expect(classify("Frobnicate-1.0").unknownIds).toEqual(["Frobnicate-1.0"]);
    expect(classify("MIT AND").parseError).toBeDefined();
    expect(classify("Apache 2.0").expression).toBe("Apache-2.0");
  });
});

describe("pnpm lockfile YAML", () => {
  it("reads the pnpm style and the Prettier style", () => {
    const pnpm = parseYaml("lockfileVersion: '9.0'\nimporters:\n\n  .:\n    dependencies:\n      '@a/b':\n        specifier: 1.0.0\n        version: 1.0.0(react@19.0.0)\npackages:\n  '@a/b@1.0.0':\n    resolution: {integrity: sha512-x, tarball: 'https://x/y.tgz'}\n    cpu: [x64, arm64]\n") as Record<string, any>;
    expect(pnpm.importers["."].dependencies["@a/b"].version).toBe("1.0.0(react@19.0.0)");
    expect(pnpm.packages["@a/b@1.0.0"].cpu).toEqual(["x64", "arm64"]);
    const pretty = parseYaml('lockfileVersion: "9.0"\npackages:\n  "x@1.0.0":\n    resolution:\n      {\n        integrity: sha512-abc==,\n      }\n    engines: { node: ">=12" }\n') as Record<string, any>;
    expect(pretty.packages["x@1.0.0"].resolution.integrity).toBe("sha512-abc==");
    expect(pretty.packages["x@1.0.0"].engines.node).toBe(">=12");
    const seq = parseYaml("list:\n  - a\n  - name: b\n    v: 2\n") as Record<string, any>;
    expect(seq.list).toEqual(["a", { name: "b", v: "2" }]);
  });
});

describe("license texts", () => {
  it("names common texts and combined files", () => {
    expect(identifyLicenseText(MIT_TEXT("A"))).toBe("MIT");
    expect(identifyLicenseText(BSD3_TEXT)).toBe("BSD-3-Clause");
    expect(identifyLicenseText(GPL3_TEXT)).toBe("GPL-3.0-only");
    expect(identifyLicenseText(`${BSD3_TEXT}\n\nParts:\n${MIT_TEXT("B")}`)).toBe("BSD-3-Clause AND MIT");
    expect(identifyLicenseText("Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted.")).toBe("0BSD");
    expect(identifyLicenseText("SQLite is Public Domain\n\nhttps://sqlite.org/copyright.html")).toBe("LicenseRef-Public-Domain");
    expect(identifyLicenseText("All rights reserved.")).toBeNull();
    // The OFL quotes the MIT opening sentence; it is still one license.
    expect(identifyLicenseText("SIL OPEN FONT LICENSE Version 1.1\nPermission is hereby granted, free of charge, to any person obtaining a copy of the Font Software")).toBe("OFL-1.1");
  });

  it("reads a license file as a known license only when it is the standard text with nothing added", () => {
    expect(readLicenseText(MIT_TEXT("A"))).toEqual({ id: "MIT" });
    expect(readLicenseText(BSD3_TEXT)).toEqual({ id: "BSD-3-Clause" });
    expect(readLicenseText(GPL3_TEXT)).toEqual({ id: "GPL-3.0-only" });
    const commonsClause = `"Commons Clause" License Condition v1.0\n\nThe grant of rights under the License will not include, and the License does not grant to you, the right to Sell the Software.\n\nLicense: MIT\n\n${MIT_TEXT("Demo")}`;
    expect(readLicenseText(commonsClause)).toMatchObject({ id: "MIT", custom: expect.stringContaining("commons clause") });
    const fsl = "# Functional Source License, Version 1.1, ALv2 Future License\n\n## Restrictions\n\nYou may not use the Software for a Competing Use.\n\n## Grant of Future License\n\nWe grant you an additional license to use the Software under the Apache License, Version 2.0 that takes effect on the second anniversary of the release.";
    expect(readLicenseText(fsl).custom).toBeDefined();
    const preamble = `Use of this software is permitted only for evaluation by the licensee named in the order form, and the licensee may not pass it on or deploy it in production without a separate written agreement with the vendor.\n\n${MIT_TEXT("Vendor")}`;
    expect(readLicenseText(preamble, { named: true }).custom).toMatch(/before the MIT text/);
    // A library that names no license is read by its file: a scope note before the text is fine there.
    expect(readLicenseText(preamble)).toEqual({ id: "MIT" });
  });
});

/** A repository with a pnpm lockfile and a flat node_modules. */
function makeRepo(extra: { lockSnapshots?: string; importerDeps?: string } = {}): string {
  const repo = path.join(tmp, "repo");
  writeJson(path.join(repo, "package.json"), { name: "demo-app", private: true });
  write(
    path.join(repo, "pnpm-lock.yaml"),
    [
      "lockfileVersion: '9.0'",
      "importers:",
      "  .:",
      "    dependencies:",
      "      app-lib:",
      "        specifier: 1.0.0",
      "        version: 1.0.0",
      "      gpl-lib:",
      "        specifier: 2.0.0",
      "        version: 2.0.0",
      extra.importerDeps ?? "",
      "    devDependencies:",
      "      electron:",
      "        specifier: 40.0.0",
      "        version: 40.0.0",
      "      build-tool:",
      "        specifier: 3.0.0",
      "        version: 3.0.0",
      "snapshots:",
      "  app-lib@1.0.0:",
      "    dependencies:",
      "      helper: 1.1.0",
      "    optionalDependencies:",
      "      native-other-os: 1.0.0",
      "  helper@1.1.0: {}",
      "  native-other-os@1.0.0:",
      "    optional: true",
      "  gpl-lib@2.0.0: {}",
      "  build-tool@3.0.0: {}",
      extra.lockSnapshots ?? "",
    ].join("\n"),
  );
  const nm = path.join(repo, "node_modules");
  npmPackage(path.join(nm, "app-lib"), { name: "app-lib", version: "1.0.0", license: "MIT", repository: "github:example/app-lib" }, MIT_TEXT("App Lib Authors"));
  npmPackage(path.join(nm, "helper"), { name: "helper", version: "1.1.0", license: "ISC", author: "Helper Author <h@example.com>" });
  npmPackage(path.join(nm, "gpl-lib"), { name: "gpl-lib", version: "2.0.0", license: "GPL-3.0-only" }, GPL3_TEXT);
  npmPackage(path.join(nm, "build-tool"), { name: "build-tool", version: "3.0.0", license: "Frobnicate-1.0" });
  npmPackage(path.join(nm, "electron"), { name: "electron", version: "40.0.0", license: "MIT" }, MIT_TEXT("Electron contributors"));
  return repo;
}

describe("inventory and check", () => {
  it("reads the run-time closure, skips dev dependencies, and finds copyleft", () => {
    const repo = makeRepo();
    const inv = buildInventory({ root: repo, config: { electron: false } });
    const keys = inv.components.map((c) => c.key);
    expect(keys).toEqual(expect.arrayContaining(["npm:app-lib@1.0.0", "npm:helper@1.1.0", "npm:gpl-lib@2.0.0"]));
    expect(keys).not.toContain("npm:build-tool@3.0.0");
    const result = checkInventory(inv);
    const errors = result.findings.filter((f) => f.severity === "error");
    expect(errors.map((f) => `${f.rule} ${f.key}`)).toEqual(["copyleft npm:gpl-lib@2.0.0"]);
    // helper has no LICENSE file, but an author: the notices get the standard ISC text.
    expect(result.findings.some((f) => f.rule === "generated-text" && f.key === "npm:helper@1.1.0")).toBe(true);
    expect(result.findings.some((f) => f.rule === "not-installed" && f.key === "npm:native-other-os@1.0.0")).toBe(true);
    expect(result.errors).toBe(1);
  });

  it("an allow entry with a reason silences copyleft for that exact license only", () => {
    const repo = makeRepo();
    const allow = [{ match: "gpl-lib", license: "GPL-3.0-only", reason: "Separate program, called as a process." }];
    const result = checkInventory(buildInventory({ root: repo, config: { electron: false } }), allow);
    expect(result.errors).toBe(0);
    expect(result.findings.find((f) => f.key === "npm:gpl-lib@2.0.0")?.severity).toBe("allowed");
    const other = checkInventory(buildInventory({ root: repo, config: { electron: false } }), [{ ...allow[0]!, license: "GPL-2.0-only" }]);
    expect(other.errors).toBe(1);
    expect(other.findings.some((f) => f.rule === "unused-allow")).toBe(true);
  });

  it("reads SEE LICENSE IN files with added terms as custom licenses that need a decision", () => {
    const repo = makeRepo({
      importerDeps: "      cc-pkg:\n        specifier: 1.0.0\n        version: 1.0.0\n      plain-pkg:\n        specifier: 1.0.0\n        version: 1.0.0",
      lockSnapshots: "  cc-pkg@1.0.0: {}\n  plain-pkg@1.0.0: {}",
    });
    const nm = path.join(repo, "node_modules");
    npmPackage(path.join(nm, "cc-pkg"), { name: "cc-pkg", version: "1.0.0", license: "SEE LICENSE IN LICENSE" }, `"Commons Clause" License Condition v1.0\n\nThe License does not grant to you the right to Sell the Software.\n\n${MIT_TEXT("Demo")}`);
    npmPackage(path.join(nm, "plain-pkg"), { name: "plain-pkg", version: "1.0.0", license: "SEE LICENSE IN LICENSE" }, MIT_TEXT("Plain"));
    const cc = readNpmPackage(path.join(nm, "cc-pkg"))!;
    expect(cc.license).toMatch(/^LicenseRef-Custom-[0-9a-f]{12}$/);
    expect(readNpmPackage(path.join(nm, "plain-pkg"))!.license).toBe("MIT");
    const inv = buildInventory({ root: repo, config: { electron: false } });
    const errors = checkInventory(inv).findings.filter((f) => f.severity === "error").map((f) => `${f.rule} ${f.key}`);
    expect(errors).toContain("custom-license npm:cc-pkg@1.0.0");
    expect(errors.some((e) => e.endsWith("plain-pkg@1.0.0"))).toBe(false);
    const allowed = checkInventory(inv, [{ match: "cc-pkg", license: cc.license!, rules: ["custom-license"], reason: "Read: we do not sell it." }]);
    expect(allowed.findings.find((f) => f.key === "npm:cc-pkg@1.0.0" && f.rule === "custom-license")?.severity).toBe("allowed");
  });

  it("gives a platform package without a license file the license file of its main package", () => {
    const repo = makeRepo({
      importerDeps: ["canvas-lib", "canvas-lib-linux-x64-gnu", "lone-linux-x64-gnu", "bundler", "@bundler/linux-x64", "@bundler/binding-linux-x64-gnu"]
        .map((n) => `      ${n}:\n        specifier: 1.0.0\n        version: 1.0.0`)
        .join("\n"),
      lockSnapshots: "  canvas-lib@1.0.0: {}\n  canvas-lib-linux-x64-gnu@1.0.0: {}\n  lone-linux-x64-gnu@1.0.0: {}",
    });
    const nm = path.join(repo, "node_modules");
    npmPackage(path.join(nm, "canvas-lib"), { name: "canvas-lib", version: "1.0.0", license: "MIT" }, MIT_TEXT("Canvas Authors"));
    npmPackage(path.join(nm, "canvas-lib-linux-x64-gnu"), { name: "canvas-lib-linux-x64-gnu", version: "1.0.0", license: "MIT" });
    npmPackage(path.join(nm, "lone-linux-x64-gnu"), { name: "lone-linux-x64-gnu", version: "1.0.0", license: "MIT" });
    npmPackage(path.join(nm, "bundler"), { name: "bundler", version: "1.0.0", license: "MIT" }, MIT_TEXT("Bundler Authors"));
    for (const name of ["@bundler/linux-x64", "@bundler/binding-linux-x64-gnu"]) npmPackage(path.join(nm, ...name.split("/")), { name, version: "1.0.0", license: "MIT" });
    const result = checkInventory(buildInventory({ root: repo, config: { electron: false } }));
    const about = (key: string) => result.findings.filter((f) => f.key === key).map((f) => `${f.severity} ${f.rule}`);
    expect(about("npm:canvas-lib-linux-x64-gnu@1.0.0")).toEqual(["note generated-text"]);
    expect(about("npm:@bundler/linux-x64@1.0.0")).toEqual(["note generated-text"]);
    expect(about("npm:@bundler/binding-linux-x64-gnu@1.0.0")).toEqual(["note generated-text"]);
    // Without its main package, a platform package still needs a license text.
    expect(about("npm:lone-linux-x64-gnu@1.0.0")).toEqual(["error missing-attribution"]);
  });

  it("reads git and tarball dependencies, installed and in the virtual store", () => {
    const url = "git+https://example.com/demo/demo-lib.git#f2dee5cd3425da08261f10a8676b66495619424d";
    const tar = "https://example.com/tar-lib-2.0.0.tgz";
    const repo = makeRepo({
      importerDeps: `      demo-lib:\n        specifier: git+https://example.com/demo/demo-lib.git\n        version: ${url}\n      tar-lib:\n        specifier: ${tar}\n        version: ${tar}`,
      lockSnapshots: `  demo-lib@${url}:\n    dependencies:\n      helper: 1.1.0\n  tar-lib@${tar}: {}\npackages:\n  demo-lib@${url}:\n    version: 1.2.3\n  tar-lib@${tar}:\n    version: 2.0.0`,
    });
    npmPackage(path.join(repo, "node_modules", "demo-lib"), { name: "demo-lib", version: "1.2.3", license: "MIT" }, MIT_TEXT("Demo"));
    // tar-lib is only in the virtual store, not linked at the top.
    npmPackage(
      path.join(repo, "node_modules", ".pnpm", "tar-lib@https+++example.com+tar-lib-2.0.0.tgz", "node_modules", "tar-lib"),
      { name: "tar-lib", version: "2.0.0", license: "ISC" },
      "ISC License\n\nCopyright (c) Tar\n\nPermission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.",
    );
    const inv = buildInventory({ root: repo, config: { electron: false } });
    const demo = inv.components.find((c) => c.name === "demo-lib");
    expect(demo?.key).toBe("npm:demo-lib@1.2.3");
    expect(demo?.missing).toBeFalsy();
    expect(demo?.licenseFiles.map((f) => f.name)).toEqual(["LICENSE"]);
    expect(inv.components.find((c) => c.name === "tar-lib")?.key).toBe("npm:tar-lib@2.0.0");
    const errors = checkInventory(inv).findings.filter((f) => f.severity === "error").map((f) => `${f.rule} ${f.key}`);
    expect(errors).toEqual(["copyleft npm:gpl-lib@2.0.0"]);
  });

  it("reports missing license texts and packages that are not installed", () => {
    const repo = makeRepo({ importerDeps: "      ghost:\n        specifier: 1.0.0\n        version: 1.0.0", lockSnapshots: "  ghost@1.0.0: {}" });
    npmPackage(path.join(repo, "node_modules", "helper"), { name: "helper", version: "1.1.0", license: "ISC" });
    const result = checkInventory(buildInventory({ root: repo, config: { electron: false } }));
    const errors = result.findings.filter((f) => f.severity === "error").map((f) => `${f.rule} ${f.key}`);
    expect(errors).toContain("missing-attribution npm:helper@1.1.0");
    expect(errors).toContain("unknown-license npm:ghost@1.0.0");
  });

  it("finds Electron's Chromium credits in a release zip, and reports them missing otherwise", () => {
    const repo = makeRepo();
    const zip = path.join(tmp, "electron-v40.0.0-win32-x64.zip");
    write(zip, zipOf({ LICENSE: MIT_TEXT("Electron contributors"), "LICENSES.chromium.html": "<html>Chromium credits</html>", "electron.exe": "x" }));
    const entries = readZipEntries(zip, (n) => n !== "electron.exe");
    expect([...entries.keys()].sort()).toEqual(["LICENSE", "LICENSES.chromium.html"]);
    const withZip = buildInventory({ root: repo, config: { electron: { zip } } });
    expect(withZip.components.find((c) => c.ecosystem === "electron")?.licenseFiles.map((f) => f.name)).toEqual(["LICENSE", "LICENSES.chromium.html"]);
    const notes: { source: string; message: string }[] = [];
    const without = electronComponent("40.0.0", path.join(repo, "node_modules", "electron"), "pnpm:.", { root: path.join(tmp, "nowhere") }, notes);
    const result = checkInventory({ root: repo, product: "x", components: [without], notes: [], sources: [] });
    expect(result.findings.map((f) => f.rule)).toContain("missing-attribution");
  });

  it("reads source maps and the plugin module list of a Vite build", () => {
    const repo = makeRepo();
    npmPackage(path.join(repo, "node_modules", "build-tool"), { name: "build-tool", version: "3.0.0", license: "MIT" }, MIT_TEXT("Build Tool"));
    npmPackage(path.join(repo, "node_modules", "vite"), { name: "vite", version: "8.0.0", license: "MIT" }, MIT_TEXT("Vite contributors"));
    const dist = path.join(repo, "dist");
    write(path.join(dist, "index.html"), "<!doctype html>");
    writeJson(path.join(dist, "assets", "index-abc.js.map"), {
      version: 3,
      sources: ["../../node_modules/build-tool/index.js", "../../src/main.ts", "\u0000vite/preload-helper.js"],
    });
    const build = readViteBuild(dist);
    expect(build.from).toBe("sourcemaps");
    expect([...build.packages.keys()]).toEqual(["build-tool@3.0.0"]);
    expect(build.viteHelpers).toBe(true);
    const inv = buildInventory({ root: repo, config: { electron: false, vite: ["dist"] } });
    expect(inv.components.map((c) => c.key)).toEqual(expect.arrayContaining(["npm:build-tool@3.0.0", "vite:vite@8.0.0"]));

    const emitted: { fileName: string; source: string }[] = [];
    const plugin = memexLicensesVite();
    plugin.generateBundle.call({ emitFile: (f) => (emitted.push(f), "id") }, {}, {
      "a.js": { type: "chunk", modules: { [path.join(repo, "node_modules", "build-tool", "index.js")]: {}, "/src/x.ts": {} } },
      "a.css": { type: "asset" },
    });
    expect(emitted[0]?.fileName).toBe(".vite/memex-licenses.json");
    const dist2 = path.join(tmp, "dist2");
    write(path.join(dist2, ".vite", "memex-licenses.json"), emitted[0]!.source);
    expect(readViteBuild(dist2).from).toBe("plugin");
    expect([...readViteBuild(dist2).packages.keys()]).toEqual(["build-tool@3.0.0"]);
  });

  it("reads fonts: TrueType, WOFF and WOFF2 name tables, with a license file next to the font", () => {
    const names = { 0: "Copyright 2020 The Demo Sans Project Authors", 1: "Demo Sans", 5: "Version 2.003", 13: "This Font Software is licensed under the SIL Open Font License, Version 1.1." };
    const dir = path.join(tmp, "fonts");
    write(path.join(dir, "demo.ttf"), ttfWithNames(names));
    write(path.join(dir, "demo.woff"), woffWithNames(names));
    write(path.join(dir, "demo.woff2"), woff2WithNames(names));
    for (const f of ["demo.ttf", "demo.woff", "demo.woff2"]) {
      const n = readFontNames(path.join(dir, f));
      expect(n.family).toBe("Demo Sans");
      expect(n.copyright).toContain("Demo Sans Project");
      expect(n.license).toContain("Open Font License");
    }
    expect(unhashedName("inter-latin-wght-normal-Dx4kXJAl.woff2")).toBe("inter-latin-wght-normal.woff2");
    // Rollup hashes are base64url, so they can hold "-".
    expect(unhashedName("geist-cyrillic-ext-wght-normal-DjL33-gN.woff2")).toBe("geist-cyrillic-ext-wght-normal.woff2");
    expect(unhashedName("source-serif-4-vietnamese-wght-normal-D-yuW59g.woff2")).toBe("source-serif-4-vietnamese-wght-normal.woff2");

    const repo = path.join(tmp, "fontrepo");
    write(path.join(repo, "web", "fonts", "demo.woff2"), woff2WithNames(names));
    write(path.join(repo, "web", "fonts", "DemoSans-OFL.txt"), "Copyright 2020 The Demo Sans Project Authors\n\nSIL OPEN FONT LICENSE Version 1.1\n");
    write(path.join(repo, "web", "fonts", "nameless.ttf"), ttfWithNames({ 1: "Mystery" }));
    const result = checkInventory(buildInventory({ root: repo, config: {} }));
    const demo = buildInventory({ root: repo, config: {} }).components.find((c) => c.name === "Demo Sans");
    expect(demo?.license).toBe("OFL-1.1");
    expect(demo?.version).toBe("2.003");
    expect(demo?.licenseFiles.map((f) => f.name)).toEqual(["DemoSans-OFL.txt"]);
    expect(result.findings.filter((f) => f.severity === "error").map((f) => `${f.rule} ${f.key}`)).toEqual(["unknown-license font:Mystery@"]);
  });

  it("reads .NET assets files: runtime packages only, licenses from the nuspec, test projects skipped", () => {
    const repo = path.join(tmp, "dotnet");
    const nuget = path.join(tmp, "nuget");
    const nuspec = (id: string, license: string, copyright: string) =>
      `<?xml version="1.0"?><package><metadata><id>${id}</id><version>1.0.0</version><authors>Someone</authors>${license}<copyright>${copyright}</copyright><projectUrl>https://example.com/${id}</projectUrl></metadata></package>`;
    write(path.join(nuget, "runtime.lib", "1.0.0", "runtime.lib.nuspec"), nuspec("Runtime.Lib", '<license type="expression">MIT</license>', "Copyright (c) Runtime Lib Authors"));
    write(path.join(nuget, "filelicensed", "1.0.0", "filelicensed.nuspec"), nuspec("FileLicensed", '<license type="file">LICENSE.txt</license>', "Example Maps"));
    write(path.join(nuget, "filelicensed", "1.0.0", "LICENSE.txt"), BSD3_TEXT);
    write(path.join(nuget, "analyzer.only", "1.0.0", "analyzer.only.nuspec"), nuspec("Analyzer.Only", '<license type="expression">GPL-3.0-only</license>', "x"));
    const assets = (project: string, extraDeps: Record<string, unknown> = {}) => ({
      version: 3,
      targets: {
        "net10.0": {
          "Runtime.Lib/1.0.0": { type: "package", runtime: { "lib/net10.0/Runtime.Lib.dll": {} } },
          "FileLicensed/1.0.0": { type: "package", runtimeTargets: { "runtimes/win-x64/native/x.dll": { assetType: "native", rid: "win-x64" } } },
          "Analyzer.Only/1.0.0": { type: "package", compile: { "lib/netstandard2.0/_._": {} }, build: { "build/x.props": {} } },
          "Other.Project/1.0.0": { type: "project" },
        },
      },
      libraries: {
        "Runtime.Lib/1.0.0": { type: "package", path: "runtime.lib/1.0.0", files: ["runtime.lib.nuspec"] },
        "FileLicensed/1.0.0": { type: "package", path: "filelicensed/1.0.0", files: ["filelicensed.nuspec", "LICENSE.txt"] },
        "Analyzer.Only/1.0.0": { type: "package", path: "analyzer.only/1.0.0", files: ["analyzer.only.nuspec"] },
      },
      packageFolders: { [nuget + path.sep]: {} },
      project: { restore: { projectName: project }, frameworks: { "net10.0": { dependencies: extraDeps } } },
    });
    writeJson(path.join(repo, "src", "App", "obj", "project.assets.json"), assets("App"));
    write(path.join(repo, "src", "App", "App.csproj"), "<Project />");
    writeJson(path.join(repo, "src", "App.Tests", "obj", "project.assets.json"), assets("App.Tests", { "Microsoft.NET.Test.Sdk": { target: "Package" } }));
    write(path.join(repo, "src", "App.Tests", "App.Tests.csproj"), "<Project />");
    const inv = buildInventory({ root: repo, config: { dotnet: ["src/App"] } });
    const nugetKeys = inv.components.filter((c) => c.ecosystem === "nuget").map((c) => `${c.key} ${c.license}`);
    expect(nugetKeys).toEqual(["nuget:FileLicensed@1.0.0 BSD-3-Clause", "nuget:Runtime.Lib@1.0.0 MIT"]);
    expect(inv.components.find((c) => c.name === "Runtime.Lib")?.licenseFiles[0]?.name).toBe("LICENSE.generated.txt");
    const auto = buildInventory({ root: repo, config: {} });
    expect(auto.sources.some((s) => s.includes("test project App.Tests"))).toBe(true);
  });
});

describe("third-party content and packs", () => {
  const item = (over: Record<string, unknown>) => ({
    id: "x",
    name: "X",
    kind: "data",
    delivery: "bundled",
    license: { spdx: "CC-BY-4.0", attribution: "X by Example, CC BY 4.0" },
    ...over,
  });

  it("flags non-commercial or territory-limited content that is bundled or hosted, and missing credit", () => {
    const repo = path.join(tmp, "content");
    writeJson(path.join(repo, "third-party.json"), {
      format: THIRD_PARTY_FORMAT,
      items: [
        item({ id: "ok" }),
        item({ id: "nc-bundled", license: { spdx: "CC-BY-NC-4.0", attribution: "NC data" } }),
        item({ id: "nc-download", delivery: "download", license: { spdx: "CC-BY-NC-4.0", attribution: "NC data" } }),
        item({ id: "territory-hosted", kind: "model", delivery: "hosted", license: { spdx: "LicenseRef-Some-Community", commercial: "restricted", limits: ["Not licensed in the European Union."], territories: ["European Union"], attribution: "M" } }),
        item({ id: "eea-hosted", kind: "model", delivery: "hosted", license: { spdx: "MIT", commercial: "allowed", limits: ["Not licensed in the EEA."], territories: ["EEA"], attribution: "E" } }),
        item({ id: "other-limit-bundled", license: { spdx: "CC-BY-4.0", limits: ["Show the credit line on every map view."], attribution: "L" } }),
        item({ id: "limit-download", delivery: "download", license: { spdx: "CC-BY-4.0", limits: ["Show the credit line on every map view."], attribution: "L" } }),
        item({ id: "no-credit", license: { spdx: "ODbL-1.0", attribution: null } }),
        item({ id: "pd-no-credit", license: { spdx: "CC0-1.0", attribution: null } }),
        item({ id: "custom-bundled", license: { spdx: "LicenseRef-Odd", attribution: "Odd" } }),
        item({ id: "blocked", delivery: "hosted", blocker: "Confirm the license first." }),
      ],
    });
    const result = checkInventory(buildInventory({ root: repo, config: {} }));
    const errors = result.findings.filter((f) => f.severity === "error").map((f) => `${f.rule} ${f.key}`);
    expect(errors).toEqual(
      expect.arrayContaining([
        "restricted-content third-party:nc-bundled",
        "restricted-content third-party:territory-hosted",
        "restricted-content third-party:eea-hosted",
        "limits third-party:other-limit-bundled",
        "missing-attribution third-party:no-credit",
        "unknown-license third-party:custom-bundled",
        "review-blocker third-party:blocked",
      ]),
    );
    for (const k of ["third-party:ok", "third-party:nc-download", "third-party:pd-no-credit", "third-party:limit-download"]) {
      expect(errors.some((e) => e.endsWith(k))).toBe(false);
    }
  });

  it("finds places in limits, and needs territories when a limit names one", () => {
    for (const l of ["Not licensed in the EEA.", "Not for use in Europe.", "May not be used in Russia or Belarus.", "Not in the U.S.", "Excluded: Hong Kong"]) {
      expect(territoriesFromLimits([l])).toEqual([l]);
    }
    expect(territoriesFromLimits(["Show the credit line on every map view.", "Keep the model card with the weights.", "Credit us in About."])).toEqual([]);
    const repo = path.join(tmp, "placed");
    writeJson(path.join(repo, "third-party.json"), { format: THIRD_PARTY_FORMAT, items: [item({ license: { spdx: "MIT", limits: ["Not for use in Europe."], attribution: "X" } })] });
    expect(() => buildInventory({ root: repo, config: {} })).toThrow(/territories is required/);
  });

  it("an allow entry decides limits and custom licenses, but never restricted or unknown content", () => {
    const memexPack = (id: string, spdx: string, commercial: "allowed" | "restricted", limits: string[]): PackManifest => ({
      format: "memex.pack/1",
      id,
      version: "1",
      title: id,
      kind: "model",
      origin: "memex",
      derivedFrom: { notice: "n" },
      license: { spdx, commercial, limits, attribution: "A", acceptance: "none" },
    });
    const comps = [
      packComponent(memexPack("eea", "MIT", "allowed", ["Not licensed in the EEA."]), "pack:eea"),
      packComponent(memexPack("lim", "MIT", "allowed", ["Keep the model card with the weights."]), "pack:lim"),
      packComponent(memexPack("nc", "CC-BY-NC-4.0", "restricted", []), "pack:nc"),
    ];
    const inv = { root: tmp, product: "x", components: comps, notes: [], sources: [] };
    expect(checkInventory(inv).findings.filter((f) => f.severity === "error").map((f) => `${f.rule} ${f.key}`).sort()).toEqual([
      "limits pack:lim@1",
      "restricted-content pack:eea@1",
      "restricted-content pack:nc@1",
    ]);
    const allow = [
      { match: "pack:lim@1", license: "MIT", rules: ["limits"], reason: "The model card ships with the pack." },
      { match: "pack:eea@1", license: "MIT", rules: ["restricted-content"], reason: "We think it is fine." },
      { match: "pack:nc@1", license: "CC-BY-NC-4.0", rules: ["restricted-content"], reason: "We think it is fine." },
    ];
    const result = checkInventory(inv, allow);
    expect(result.findings.filter((f) => f.severity === "error").map((f) => `${f.rule} ${f.key}`).sort()).toEqual(["restricted-content pack:eea@1", "restricted-content pack:nc@1"]);
    expect(result.findings.find((f) => f.key === "pack:lim@1")?.severity).toBe("allowed");

    const cfgDir = path.join(tmp, "cfg");
    for (const rule of ["restricted-content", "unknown-license", "review-blocker", "missing-attribution"]) {
      writeJson(path.join(cfgDir, "memex-licenses.json"), { format: "memex.licenses/1", allow: [{ match: "x", license: "MIT", rules: [rule], reason: "r" }] });
      expect(() => loadConfig(cfgDir)).toThrow(/cannot be allowed/);
    }
    writeJson(path.join(cfgDir, "memex-licenses.json"), { format: "memex.licenses/1", allow: [{ match: "x", license: "MIT", rules: ["copyleft", "custom-license", "limits"], reason: "r" }] });
    expect(loadConfig(cfgDir).config.allow).toHaveLength(1);
  });

  it("imports a license review, leaving out removed and scanned items", () => {
    const review = {
      format: "memex.license-review/0-draft",
      repos: [
        {
          repo: "ZarK/memex.demo",
          items: [
            { id: "corpus-a", kind: "corpus", name: "A", spdx: "LicenseRef-Public-Domain", action: "download", notice: "A, public domain." },
            { id: "npm:react@19", kind: "code", name: "react", spdx: "MIT", action: "ship", notice: "MIT" },
            { id: "gone", kind: "model", name: "Gone", spdx: "MIT", action: "remove" },
            { id: "map-b", kind: "map", name: "B", spdx: "CC-BY-NC-4.0", action: "host", notice: "B", blocker: "Ask first." },
          ],
        },
      ],
    };
    const imported = importReview(review, "memex.demo");
    expect(imported.file.items.map((i) => `${i.id} ${i.delivery} ${i.license.commercial}`)).toEqual(["corpus-a download allowed", "map-b hosted restricted"]);
    expect(imported.skipped.map((s) => s.reason)).toEqual(["found by the scanners", "remove"]);
    expect(() => importReview(review, "other")).toThrow(/no repository/);
  });

  it("makes credit lines and checks pack license fields", () => {
    const pack = (over: Partial<PackManifest>): PackManifest => ({
      format: "memex.pack/1",
      id: "e5",
      version: "1",
      title: "E5 small",
      kind: "model",
      origin: "upstream",
      source: { publisher: "intfloat" },
      license: { spdx: "MIT", commercial: "allowed", limits: [], attribution: null, acceptance: "none" },
      ...over,
    });
    const lines = creditLines([
      pack({}),
      pack({ id: "osm", title: "Basemap", license: { spdx: "ODbL-1.0", commercial: "allowed", limits: [], attribution: "© OpenStreetMap contributors", acceptance: "none" } }),
      pack({ id: "pd", title: "Natural Earth", license: { spdx: "LicenseRef-Public-Domain", commercial: "allowed", limits: [], attribution: null, acceptance: "none" } }),
    ]);
    expect(lines.map((l) => `${l.credit}|${l.required}`)).toEqual(["© OpenStreetMap contributors|true", "E5 small by intfloat, MIT|true", "Natural Earth by intfloat, LicenseRef-Public-Domain|false"]);
    const bad = [
      packComponent(pack({ id: "u", license: { spdx: "unknown", commercial: "unknown", limits: [], attribution: null, acceptance: "none" } }), "pack:u"),
      packComponent(pack({ id: "nc", origin: "memex", derivedFrom: { notice: "ONNX export" }, license: { spdx: "CC-BY-NC-4.0", commercial: "restricted", limits: [], attribution: "NC", acceptance: "none" } }), "pack:nc"),
    ];
    const result = checkInventory({ root: tmp, product: "x", components: bad, notes: [], sources: [] });
    const errors = result.findings.filter((f) => f.severity === "error").map((f) => `${f.rule} ${f.key}`);
    expect(errors).toContain("unknown-license pack:u@1");
    expect(errors).toContain("restricted-content pack:nc@1");
  });
});

describe("notices and the CLI", () => {
  it("writes THIRD-PARTY-NOTICES.md, notices.json and licenses/, the same bytes each time", async () => {
    const repo = makeRepo();
    const config: Config = { electron: false, allow: [{ match: "gpl-lib", license: "GPL-3.0-only", reason: "Test." }] };
    const a = writeNotices(buildInventory({ root: repo, config }), path.join(tmp, "out-a"));
    writeNotices(buildInventory({ root: repo, config }), path.join(tmp, "out-b"));
    const md = fs.readFileSync(path.join(a.outDir, "THIRD-PARTY-NOTICES.md"), "utf8");
    expect(md).toBe(fs.readFileSync(path.join(tmp, "out-b", "THIRD-PARTY-NOTICES.md"), "utf8"));
    expect(md).toContain("| app-lib | 1.0.0 | MIT | Copyright (c) 2024 App Lib Authors | https://github.com/example/app-lib |");
    expect(md).toContain("Copyright (c) Helper Author <h@example.com>");
    const json = JSON.parse(fs.readFileSync(path.join(a.outDir, "notices.json"), "utf8"));
    expect(json.format).toBe("memex.notices/1");
    expect(json.components.find((c: { name: string }) => c.name === "app-lib").files).toEqual(["licenses/npm/app-lib@1.0.0/LICENSE"]);
    expect(fs.existsSync(path.join(a.outDir, "licenses", "npm", "helper@1.1.0", "LICENSE.generated.txt"))).toBe(true);
  });

  it("check exits 1 on findings and 0 when clean; notices refuses a folder that is not empty", async () => {
    const repo = makeRepo();
    const failing = await run(["check", "--repo", repo]);
    expect(failing.code).toBe(1);
    expect(failing.out).toContain("copyleft");
    writeJson(path.join(repo, "memex-licenses.json"), {
      format: "memex.licenses/1",
      electron: false,
      allow: [{ match: "gpl-lib", license: "GPL-3.0-only", reason: "Separate process." }],
    });
    const clean = await run(["check", "--repo", repo, "--json"]);
    expect(clean.code).toBe(0);
    expect(JSON.parse(clean.out).errors).toBe(0);
    const out = path.join(tmp, "notices");
    expect((await run(["notices", "--repo", repo, "--out", out])).code).toBe(0);
    expect((await run(["notices", "--repo", repo, "--out", out])).code).toBe(2);
    writeJson(path.join(repo, "memex-licenses.json"), { allow: [{ match: "x", license: "MIT" }] });
    expect((await run(["check", "--repo", repo])).code).toBe(2);
    expect((await run(["frobnicate"])).code).toBe(2);
  });

  it("reads npm's package-lock.json without dev dependencies, and reports what is not installed", async () => {
    const repo = path.join(tmp, "npm-repo");
    writeJson(path.join(repo, "package.json"), { name: "npm-app", version: "1.0.0", license: "AGPL-3.0-or-later" });
    writeJson(path.join(repo, "package-lock.json"), {
      name: "npm-app",
      lockfileVersion: 3,
      packages: {
        "": { name: "npm-app", version: "1.0.0" },
        "node_modules/phone-lib": { version: "1.12.0", license: "MIT" },
        "node_modules/phone-lib/node_modules/inner-lib": { version: "0.2.0", license: "MIT" },
        "node_modules/test-tool": { version: "4.0.0", dev: true, license: "MIT" },
        "node_modules/native-win32-x64": { version: "1.0.0", optional: true, license: "MIT" },
        "node_modules/gone-lib": { version: "2.0.0", license: "MIT" },
        "node_modules/local-lib": { resolved: "packages/local-lib", link: true },
      },
    });
    npmPackage(path.join(repo, "node_modules", "phone-lib"), { name: "phone-lib", version: "1.12.0", license: "MIT" }, MIT_TEXT("Phone Lib Authors"));
    npmPackage(path.join(repo, "node_modules", "phone-lib", "node_modules", "inner-lib"), { name: "inner-lib", version: "0.2.0", license: "MIT" }, MIT_TEXT("Inner Authors"));
    npmPackage(path.join(repo, "node_modules", "test-tool"), { name: "test-tool", version: "4.0.0", license: "MIT" }, MIT_TEXT("Test Tool Authors"));
    const r = await run(["check", "--repo", repo, "--json"]);
    const result = JSON.parse(r.out);
    expect(r.code).toBe(1);
    expect(result.sources).toEqual(["package-lock.json (4 packages, no dev dependencies)"]);
    expect(result.components).toBe(3);
    const errors = result.findings.filter((f: { severity: string }) => f.severity === "error").map((f: { rule: string; key: string }) => `${f.rule} ${f.key}`);
    expect(errors).toEqual(["unknown-license npm:gone-lib@2.0.0"]);
    expect(result.findings.map((f: { rule: string; key: string }) => `${f.rule} ${f.key}`)).toContain("not-installed npm:native-win32-x64@1.0.0");
    npmPackage(path.join(repo, "node_modules", "gone-lib"), { name: "gone-lib", version: "2.0.0", license: "MIT" }, MIT_TEXT("Gone Authors"));
    expect((await run(["check", "--repo", repo])).code).toBe(0);
  });

  it("fails a check that reads no dependencies, unless noDependencies says why", async () => {
    const repo = path.join(tmp, "empty-repo");
    write(path.join(repo, "README.md"), "A product without third-party code.\n");
    const empty = await run(["check", "--repo", repo]);
    expect(empty.code).toBe(1);
    expect(empty.out).toContain("no-dependencies");
    writeJson(path.join(repo, "memex-licenses.json"), { format: "memex.licenses/1", noDependencies: "The nodes run in ComfyUI's own environment." });
    const said = await run(["check", "--repo", repo]);
    expect(said.code).toBe(0);
    expect(said.out).toContain("no third-party components: The nodes run in ComfyUI's own environment.");
    writeJson(path.join(repo, "memex-licenses.json"), { noDependencies: " " });
    expect((await run(["check", "--repo", repo])).code).toBe(2);
    // A Python package's _vendor folder is a copied library like vendor/.
    const py = path.join(tmp, "py-repo");
    write(path.join(py, "photo", "_vendor", "restore", "LICENSE"), MIT_TEXT("Restore Authors"));
    write(path.join(py, "photo", "_vendor", "restore", "__init__.py"), "\n");
    const vendored = JSON.parse((await run(["check", "--repo", py, "--json"])).out);
    expect(vendored.byEcosystem).toEqual({ vendor: 1 });
    expect(vendored.errors).toBe(0);
    const full = makeRepo();
    writeJson(path.join(full, "memex-licenses.json"), {
      electron: false,
      noDependencies: "None.",
      allow: [{ match: "gpl-lib", license: "GPL-3.0-only", reason: "Separate process." }],
    });
    const wrong = await run(["check", "--repo", full]);
    expect(wrong.code).toBe(1);
    expect(wrong.out).toContain("remove noDependencies");
  });

  it("packs and third-party commands write their files", async () => {
    const dir = path.join(tmp, "packs");
    writeJson(path.join(dir, "a", "memex.pack.json"), {
      format: "memex.pack/1", id: "a", version: "1", title: "Alpha", kind: "map", origin: "upstream",
      source: { publisher: "Pub" }, license: { spdx: "CC-BY-4.0", commercial: "allowed", limits: [], attribution: "Alpha by Pub, CC BY 4.0", acceptance: "none" },
    });
    const r = await run(["packs", dir, "--format", "text"]);
    expect(r.code).toBe(0);
    expect(r.out).toBe("Alpha by Pub, CC BY 4.0");
    const reviewFile = path.join(tmp, "review.json");
    writeJson(reviewFile, { format: "memex.license-review/0-draft", repos: [{ repo: "demo", items: [{ id: "d", kind: "data", name: "D", spdx: "CC0-1.0", action: "ship", notice: "" }] }] });
    const outFile = path.join(tmp, "tp", "third-party.json");
    expect((await run(["third-party", "--from-review", reviewFile, "--out", outFile])).code).toBe(0);
    expect(JSON.parse(fs.readFileSync(outFile, "utf8")).items[0].license.attribution).toBeNull();
  });

  it("parses every lockfile shape the closure needs", () => {
    const repo = makeRepo();
    const lock = readLockfile(path.join(repo, "pnpm-lock.yaml"));
    expect([...lock.importers.keys()]).toEqual(["."]);
    expect(lock.snapshots.get("native-other-os@1.0.0")?.optional).toBe(true);
  });
});
