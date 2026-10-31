import path from "node:path";

const WINDOWS_SHIMS = new Set(["npm", "npx", "pnpm", "yarn"]);

export function buildArgvCommandPlan(command, args, options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    return { command, args: [...args], windowsVerbatimArguments: false };
  }
  const lowerCommand = command.toLowerCase();
  const isShimPath = lowerCommand.endsWith(".cmd") || lowerCommand.endsWith(".bat");
  const shim = isShimPath
    ? command
    : (WINDOWS_SHIMS.has(path.basename(lowerCommand)) ? `${command}.cmd` : null);
  if (!shim) {
    return { command, args: [...args], windowsVerbatimArguments: false };
  }
  return {
    command: options.comspec ?? process.env.ComSpec ?? process.env.COMSPEC ?? "cmd.exe",
    args: ["/d", "/s", "/c", shim, ...args],
    windowsVerbatimArguments: false,
  };
}

export function buildShellCommandPlan(command, options = {}) {
  if (String(command).trim() === "") {
    throw Object.assign(new Error("Shell command must not be empty."), { reasonCode: "empty-command" });
  }
  const platform = options.platform ?? process.platform;
  return platform === "win32"
    ? {
        command: options.comspec ?? process.env.ComSpec ?? process.env.COMSPEC ?? "cmd.exe",
        args: ["/d", "/s", "/c", `"${command}"`],
        windowsVerbatimArguments: true,
      }
    : { command: "/bin/sh", args: ["-c", command], windowsVerbatimArguments: false };
}
