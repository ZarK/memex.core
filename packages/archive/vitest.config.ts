import { defineConfig } from "vitest/config";

// These tests start other programs (git, node, python, tar, Windows PowerShell). On a GitHub Windows runner that runs
// the other packages' tests at the same time, a cold program takes seconds to start: single tests took up to 15 s
// there, against well under 1 s on macOS and Linux. 60 s on Windows still stops a test that hangs.
export default defineConfig({ test: { testTimeout: process.platform === "win32" ? 60_000 : 5_000 } });
