import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { builderConfig } from "../src/builder.js";
import {
  KEEP_VERSIONS,
  SERVICES_BUNDLE_FORMAT,
  installServices,
  pinServices,
  readClients,
  servicesAction,
  servicesStatus,
  serviceTarget,
  stageServices,
  uninstallServices,
  withServicesLock,
} from "../src/services.js";

const tar = process.platform === "win32" ? path.join(process.env.SystemRoot ?? process.env.windir ?? "", "System32", "tar.exe") : "tar";

function scratch(): { root: string; env: NodeJS.ProcessEnv; services: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), "memex-services-"));
  const env: NodeJS.ProcessEnv = {
    MEMEX_HOME: path.join(root, "Memex"),
    MEMEX_APPS_DIR: path.join(root, "apps"),
    MEMEX_PACKS_DIR: path.join(root, "packs"),
    MEMEX_ARCHIVE_HOME: path.join(root, "archive"),
    LOCALAPPDATA: path.join(root, "local"),
  };
  return { root, env, services: path.join(root, "services") };
}

/** A packaged service as the packaging scripts write it: the folder, its .tar.gz and the .json record. */
function packageService(out: string, app: string, version: string, target: string): void {
  const name = `memex-${app}-${version}-${target}`;
  const folder = path.join(out, name);
  mkdirSync(path.join(folder, "lib"), { recursive: true });
  writeFileSync(path.join(folder, "service.json"), JSON.stringify({ format: "memex.service/1", app, version, command: `memex-${app}.exe`, args: [] }));
  writeFileSync(path.join(folder, `memex-${app}.exe`), `${app} ${version}`);
  writeFileSync(path.join(folder, "lib", "part.txt"), "a part");
  const archive = path.join(out, `${name}.tar.gz`);
  const result = spawnSync(tar, ["-czf", archive, "-C", out, name]);
  expect(result.status).toBe(0);
  const sha256 = createHash("sha256").update(readFileSync(archive)).digest("hex");
  writeFileSync(path.join(out, `${name}.json`), JSON.stringify({ app, version, target, archive: path.basename(archive), sha256 }));
}

/** An app's resources folder with staged services, as pack makes it. */
function resourcesWith(root: string, versions: Record<string, string>, target = serviceTarget()): string {
  const payloads = mkdtempSync(path.join(root, "payloads-"));
  for (const [app, version] of Object.entries(versions)) packageService(payloads, app, version, target);
  const pins = path.join(payloads, "services.json");
  pinServices({ from: payloads, file: pins });
  const resources = mkdtempSync(path.join(root, "resources-"));
  stageServices({ pins, from: payloads, target, out: path.join(resources, "services") });
  return resources;
}

function program(root: string, name: string): string {
  const file = path.join(root, "programs", name, `${name}.exe`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, "");
  return file;
}

describe("services.json and staging", () => {
  it("pins the packaged archives per target and stages a target", () => {
    const { root } = scratch();
    const payloads = path.join(root, "payloads");
    mkdirSync(payloads);
    packageService(payloads, "node", "0.1.0", "win-x64");
    packageService(payloads, "node", "0.1.0", "osx-arm64");
    packageService(payloads, "user", "0.1.0", "win-x64");
    const pins = pinServices({ from: payloads, file: path.join(root, "services.json") });
    expect(Object.keys(pins.services.node!.targets).sort()).toEqual(["osx-arm64", "win-x64"]);
    expect(pins.services.user!.targets["win-x64"]!.sha256).toMatch(/^[0-9a-f]{64}$/);

    const out = path.join(root, "staged");
    const bundle = stageServices({ pins: path.join(root, "services.json"), from: payloads, target: "win-x64", out });
    expect(bundle.format).toBe(SERVICES_BUNDLE_FORMAT);
    expect(readFileSync(path.join(out, "node", "0.1.0", "memex-node.exe"), "utf8")).toBe("node 0.1.0");
    expect(JSON.parse(readFileSync(path.join(out, "services.json"), "utf8")).services.user.version).toBe("0.1.0");
    // user has no osx-arm64 archive
    expect(() => stageServices({ pins: path.join(root, "services.json"), from: payloads, target: "osx-arm64", out: path.join(root, "staged-mac") })).toThrow(/pins no osx-arm64 archive for user/);
  });

  it("refuses an archive whose SHA-256 is not the pinned one", () => {
    const { root } = scratch();
    const payloads = path.join(root, "payloads");
    mkdirSync(payloads);
    packageService(payloads, "node", "0.1.0", "win-x64");
    pinServices({ from: payloads, file: path.join(root, "services.json") });
    writeFileSync(path.join(payloads, "memex-node-0.1.0-win-x64.tar.gz"), "changed");
    expect(() => stageServices({ pins: path.join(root, "services.json"), from: payloads, target: "win-x64", out: path.join(root, "staged") })).toThrow(/not the pinned/);
  });

  it("packs the staged services with the NSIS hooks and the dmg note", () => {
    const config = builderConfig({ app: "hello", productName: "Memex Hello", files: ["main.mjs"], services: "build/services" });
    expect(config.extraResources).toContainEqual({ from: "build/services", to: "services", filter: ["**/*"] });
    expect(String((config.nsis as { include?: string }).include)).toMatch(/installer\.nsh$/);
    expect(JSON.stringify((config.dmg as { contents?: unknown }).contents)).toMatch(/About Memex services\.txt/);
    const without = builderConfig({ app: "hello", productName: "Memex Hello", files: ["main.mjs"] });
    expect((without.nsis as { include?: string }).include).toBeUndefined();
  });

  it("reads the installer hook from the command line", () => {
    expect(servicesAction(["app.exe", "--memex-services=install"])).toBe("install");
    expect(servicesAction(["app.exe", "--memex-services=uninstall"])).toBe("uninstall");
    expect(servicesAction(["app.exe", "--memex-services"])).toBeNull();
  });
});

describe("the services folder", () => {
  it("installs the carried copies once, lists the app as a client, and a second app reuses them", async () => {
    const { root, env, services } = scratch();
    const resources = resourcesWith(root, { node: "0.1.0", user: "0.1.0" });
    const hello = program(root, "hello");
    const first = await installServices({ resources, services, env, client: { app: "hello", productName: "Memex Hello", version: "0.1.0", program: hello } });
    expect(first!.copies.map((c) => `${c.app} ${c.action}`)).toEqual(["node installed", "user installed"]);
    expect(readFileSync(path.join(services, "user", "0.1.0", "lib", "part.txt"), "utf8")).toBe("a part");

    const two = program(root, "hellotwo");
    const second = await installServices({ resources, services, env, client: { app: "hellotwo", productName: "Memex Hello Two", version: "0.1.0", program: two } });
    expect(second!.copies.map((c) => c.action)).toEqual(["present", "present"]);
    expect(second!.clients).toEqual(["hello", "hellotwo"]);
    expect(readdirSync(path.join(services, "node"))).toEqual(["0.1.0"]);
  });

  it("keeps the newest two versions and does not install a version older than both", async () => {
    const { root, env, services } = scratch();
    const client = { app: "hello", productName: "Memex Hello", version: "0.1.0", program: program(root, "hello") };
    for (const version of ["1.0.0", "1.1.0", "1.2.0"]) {
      await installServices({ resources: resourcesWith(root, { user: version }), services, env, client });
    }
    expect(KEEP_VERSIONS).toBe(2);
    expect(servicesStatus({ services, env }).installed.user).toEqual(["1.2.0", "1.1.0"]);
    const old = await installServices({ resources: resourcesWith(root, { user: "1.0.0" }), services, env, client });
    expect(old!.copies[0]!.action).toBe("skipped");
    expect(servicesStatus({ services, env }).installed.user).toEqual(["1.2.0", "1.1.0"]);
  });

  it("refuses a services folder inside the Memex folder or the pack store", async () => {
    const { root, env } = scratch();
    const resources = resourcesWith(root, { user: "0.1.0" });
    const client = { app: "hello", productName: "Memex Hello", version: "0.1.0", program: program(root, "hello") };
    await expect(installServices({ resources, services: path.join(env.MEMEX_HOME!, "Services"), env, client })).rejects.toThrow(/outside the Memex folder/);
    await expect(installServices({ resources, services: path.join(env.MEMEX_PACKS_DIR!, "x"), env, client })).rejects.toThrow(/outside the pack store/);
  });

  it("the last uninstaller removes the services and nothing else; an app removed without one stops counting", async () => {
    const { root, env, services } = scratch();
    mkdirSync(path.join(env.MEMEX_HOME!, "User"), { recursive: true });
    writeFileSync(path.join(env.MEMEX_HOME!, "User", "user.db"), "data");
    mkdirSync(env.MEMEX_PACKS_DIR!, { recursive: true });
    writeFileSync(path.join(env.MEMEX_PACKS_DIR!, "packs.json"), "{}");
    const resources = resourcesWith(root, { node: "0.1.0", user: "0.1.0" });
    const hello = program(root, "hello");
    const two = program(root, "hellotwo");
    const gone = path.join(root, "programs", "removed", "removed.exe");
    await installServices({ resources, services, env, client: { app: "hello", productName: "Memex Hello", version: "0.1.0", program: hello } });
    await installServices({ resources, services, env, client: { app: "hellotwo", productName: "Memex Hello Two", version: "0.1.0", program: two } });
    mkdirSync(path.join(services, "clients"), { recursive: true });
    writeFileSync(path.join(services, "clients", "removed.json"), JSON.stringify({ format: "memex.services-client/1", app: "removed", productName: "Removed", version: "0.1.0", program: gone, services: {}, updatedAt: "" }));

    const firstOut = await uninstallServices({ app: "hellotwo", services, env });
    expect(firstOut.clients).toEqual(["hello"]);
    expect(firstOut.removed).toEqual([]);
    expect(existsSync(path.join(services, "memex-services.json"))).toBe(true);
    expect(readClients(services).map((c) => c.app)).toEqual(["hello"]);

    const lastOut = await uninstallServices({ app: "hello", services, env });
    expect(lastOut.clients).toEqual([]);
    expect(lastOut.removed).toEqual(["node", "user"]);
    expect(existsSync(services)).toBe(false);
    expect(readFileSync(path.join(env.MEMEX_HOME!, "User", "user.db"), "utf8")).toBe("data");
    expect(readFileSync(path.join(env.MEMEX_PACKS_DIR!, "packs.json"), "utf8")).toBe("{}");
  });

  it("never changes or removes what is not a service, and refuses a folder that is not a services folder", async () => {
    const { root, env, services } = scratch();
    const client = { app: "hello", productName: "Memex Hello", version: "0.1.0", program: program(root, "hello") };
    // A folder a person uses for other files is refused: it is not empty and has no marker.
    const used = path.join(root, "used");
    mkdirSync(path.join(used, "notes"), { recursive: true });
    writeFileSync(path.join(used, "notes", "todo.txt"), "mine");
    const resources = resourcesWith(root, { user: "1.0.0" });
    await expect(installServices({ resources, services: used, env, client })).rejects.toThrow(/not a Memex services folder/);
    const refusedOut = await uninstallServices({ app: "hello", services: used, env });
    expect(refusedOut.removed).toEqual([]);
    expect(readdirSync(used)).toEqual(["notes"]);

    // In a services folder, other files put there later stay: through pruning and through the last uninstall.
    await installServices({ resources, services, env, client });
    expect(readFileSync(path.join(services, "memex-services.json"), "utf8")).toContain("memex.services-folder/1");
    mkdirSync(path.join(services, "projects"), { recursive: true });
    writeFileSync(path.join(services, "projects", "chapter1.txt"), "text");
    for (const version of ["1.0.0", "2.0.0", "3.0.0"]) {
      mkdirSync(path.join(services, "projects2", version), { recursive: true });
      writeFileSync(path.join(services, "projects2", version, "data.txt"), version);
    }
    // A service folder with a foreign file in it is not a service either.
    mkdirSync(path.join(services, "node", "0.1.0"), { recursive: true });
    writeFileSync(path.join(services, "node", "0.1.0", "service.json"), JSON.stringify({ format: "memex.service/1", app: "node", version: "0.1.0", command: "n.exe", args: [] }));
    writeFileSync(path.join(services, "node", "readme.txt"), "not a version");
    const lines: string[] = [];
    for (const version of ["1.1.0", "1.2.0"]) {
      await installServices({ resources: resourcesWith(root, { user: version, node: "0.2.0" }), services, env, client, log: (l) => lines.push(l) });
    }
    expect(servicesStatus({ services, env }).installed.user).toEqual(["1.2.0", "1.1.0"]);
    expect(readdirSync(path.join(services, "projects2")).sort()).toEqual(["1.0.0", "2.0.0", "3.0.0"]);
    expect(readdirSync(path.join(services, "node")).sort()).toEqual(["0.1.0", "readme.txt"]);
    expect(lines.some((l) => /node 0.2.0 is not installed: .* not a Memex service/.test(l))).toBe(true);

    const lastOut = await uninstallServices({ app: "hello", services, env, log: (l) => lines.push(l) });
    expect(lastOut.removed).toEqual(["user"]);
    expect(readdirSync(services).sort()).toEqual(["memex-services.json", "node", "projects", "projects2"]);
    expect(readFileSync(path.join(services, "projects", "chapter1.txt"), "utf8")).toBe("text");
    expect(readFileSync(path.join(services, "node", "readme.txt"), "utf8")).toBe("not a version");
    expect(lines.some((l) => l.includes("stays: it also holds"))).toBe(true);
  });

  it("lets one installer at a time hold the lock and takes over a lock whose process is gone", async () => {
    const { services } = scratch();
    const order: string[] = [];
    await Promise.all([
      withServicesLock(services, 5000, async () => {
        order.push("a start");
        await new Promise((r) => setTimeout(r, 300));
        order.push("a end");
      }),
      new Promise((r) => setTimeout(r, 50)).then(() => withServicesLock(services, 5000, async () => void order.push("b"))),
    ]);
    expect(order).toEqual(["a start", "a end", "b"]);
    writeFileSync(path.join(services, "services.lock"), JSON.stringify({ pid: 2 ** 22 + 12345, hostname: os.hostname(), startedAt: "" }));
    expect(await withServicesLock(services, 2000, async () => "taken over")).toBe("taken over");
  });
});
