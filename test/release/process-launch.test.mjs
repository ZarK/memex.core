import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildArgvCommandPlan, buildShellCommandPlan } from "../../scripts/process-launch.mjs";

describe("release process launch", () => {
  it("runs POSIX argv and command strings without Node shell mode", () => {
    assert.deepEqual(buildArgvCommandPlan("npm", ["pack"], { platform: "linux" }), {
      command: "npm",
      args: ["pack"],
      windowsVerbatimArguments: false,
    });
    assert.deepEqual(buildShellCommandPlan("pnpm run build && pnpm test", { platform: "linux" }), {
      command: "/bin/sh",
      args: ["-c", "pnpm run build && pnpm test"],
      windowsVerbatimArguments: false,
    });
  });

  it("runs Windows shims and command strings through cmd.exe explicitly", () => {
    const comspec = "system\\cmd.exe";
    assert.deepEqual(buildArgvCommandPlan("pnpm", ["run", "build"], { platform: "win32", comspec }), {
      command: comspec,
      args: ["/d", "/s", "/c", "pnpm.cmd", "run", "build"],
      windowsVerbatimArguments: false,
    });
    assert.deepEqual(buildShellCommandPlan("pnpm run build && pnpm test", { platform: "win32", comspec }), {
      command: comspec,
      args: ["/d", "/s", "/c", "\"pnpm run build && pnpm test\""],
      windowsVerbatimArguments: true,
    });
  });

  it("keeps native Windows executables direct and rejects empty command strings", () => {
    assert.deepEqual(buildArgvCommandPlan("tools\\node js\\node.exe", ["script.mjs"], { platform: "win32" }), {
      command: "tools\\node js\\node.exe",
      args: ["script.mjs"],
      windowsVerbatimArguments: false,
    });
    assert.throws(() => buildShellCommandPlan("  ", { platform: "win32" }), { reasonCode: "empty-command" });
  });
});
