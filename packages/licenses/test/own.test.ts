import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkOwnLicense } from "../src/index.js";
import { main } from "../src/cli.js";
import { GPL3_TEXT, MIT_TEXT, write, writeJson } from "./helpers.js";

// The opening of the GNU Affero text, enough for the text to be named.
const AGPL3_TEXT = `GNU AFFERO GENERAL PUBLIC LICENSE
Version 3, 19 November 2007
Copyright (C) 2007 Free Software Foundation, Inc. <https://fsf.org/>
Everyone is permitted to copy and distribute verbatim copies of this license document, but changing it is not allowed.`;

let tmp: string;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "memex-licenses-own-")));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function cli(argv: string[]): Promise<{ code: number; text: string }> {
  const lines: string[] = [];
  const code = await main(argv, { out: (l) => lines.push(l) });
  return { code, text: lines.join("\n") };
}

describe("the repository's own license", () => {
  it("accepts a LICENSE text and manifests of the group", () => {
    write(path.join(tmp, "LICENSE"), AGPL3_TEXT);
    writeJson(path.join(tmp, "package.json"), { name: "app", license: "AGPL-3.0-or-later" });
    const r = checkOwnLicense(tmp, "AGPL-3.0-or-later");
    expect(r).toMatchObject({ ok: true, licenseFile: "LICENSE", licenseText: "AGPL-3.0-only", problems: [] });
  });

  it("finds a missing file, another text, and a manifest that declares something else", () => {
    writeJson(path.join(tmp, "package.json"), { name: "app", license: "UNLICENSED" });
    expect(checkOwnLicense(tmp, "AGPL-3.0-or-later").problems.map((p) => p.file)).toEqual(["LICENSE", "package.json"]);
    write(path.join(tmp, "LICENSE"), GPL3_TEXT);
    writeJson(path.join(tmp, "package.json"), { name: "app", license: "GPL-3.0-only" });
    const r = checkOwnLicense(tmp, "AGPL-3.0-or-later");
    expect(r.problems.map((p) => p.detail)).toEqual([
      "holds the GPL-3.0-only text; expected AGPL-3.0-or-later",
      "declares GPL-3.0-only; expected AGPL-3.0-or-later",
    ]);
  });

  it("reads pyproject.toml and Directory.Build.props", () => {
    write(path.join(tmp, "LICENSE.md"), MIT_TEXT("Example Holder"));
    write(path.join(tmp, "pyproject.toml"), '[project]\nname = "x"\nlicense = "MIT"\n');
    write(path.join(tmp, "Directory.Build.props"), "<Project><PropertyGroup><PackageLicenseExpression>Apache-2.0</PackageLicenseExpression></PropertyGroup></Project>");
    const r = checkOwnLicense(tmp, "MIT");
    expect(r.manifests).toEqual([
      { file: "pyproject.toml", license: "MIT" },
      { file: "Directory.Build.props", license: "Apache-2.0" },
    ]);
    expect(r.problems).toEqual([{ file: "Directory.Build.props", detail: "declares Apache-2.0; expected MIT" }]);
  });

  it("reads a GNU text by its title, not by the other GNU licenses its body names", () => {
    // Section 13 of the GPL names the GNU Affero General Public License; the AGPL names the GPL.
    write(path.join(tmp, "LICENSE"), `${GPL3_TEXT}
13. Use with the GNU Affero General Public License.`);
    expect(checkOwnLicense(tmp, "GPL-3.0-or-later")).toMatchObject({ ok: true, licenseText: "GPL-3.0-only" });
    write(path.join(tmp, "LICENSE"), `${AGPL3_TEXT}
13. Remote Network Interaction; Use with the GNU General Public License.`);
    expect(checkOwnLicense(tmp, "AGPL-3.0-or-later")).toMatchObject({ ok: true, licenseText: "AGPL-3.0-only" });
  });

  it("runs from the CLI, with a pending step as a note", async () => {
    write(path.join(tmp, "LICENSE"), GPL3_TEXT);
    expect((await cli(["own", "--expect", "GPL-3.0-or-later", "--repo", tmp])).code).toBe(0);
    const wrong = await cli(["own", "--expect", "AGPL-3.0-or-later", "--repo", tmp]);
    expect(wrong.code).toBe(1);
    expect(wrong.text).toContain("own-license");
    const pending = await cli(["own", "--expect", "AGPL-3.0-or-later", "--repo", tmp, "--pending", "the license is set before the first release"]);
    expect(pending.code).toBe(0);
    expect(pending.text).toContain("Pending: the license is set before the first release");
    expect((await cli(["own", "--expect", "BSD-3-Clause", "--repo", tmp])).code).toBe(2);
  });
});
