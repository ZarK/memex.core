import fs from "node:fs";
import path from "node:path";
import { isDir, isFile, tryReadJson, walkFiles } from "./files.js";

export const VITE_MODULES_FILE = ".vite/memex-licenses.json";
export const VITE_MODULES_FORMAT = "memex.vite-modules/1";

export interface ViteBuild {
  dir: string;
  /** Package folders that the build holds code from, by `name@version`. */
  packages: Map<string, { name: string; version: string; dir: string | null }>;
  /** True when the build holds Vite's own helper code (module preload). */
  viteHelpers: boolean;
  /** How the module list was read: the plugin file, source maps, or nothing. */
  from: "plugin" | "sourcemaps" | "none";
  maps: number;
}

const HELPER = /(^|[\\/\0])vite[\\/](preload-helper|modulepreload-polyfill)/;

/** The package folder of a module path inside node_modules, and the package name. */
export function packageOfModule(file: string): { name: string; dir: string } | null {
  const norm = file.replace(/\\/g, "/").replace(/^\0/, "").replace(/\?.*$/, "");
  const i = norm.lastIndexOf("/node_modules/");
  if (i === -1) return null;
  const rest = norm.slice(i + "/node_modules/".length).split("/");
  const name = rest[0]?.startsWith("@") ? `${rest[0]}/${rest[1] ?? ""}` : rest[0];
  if (name === undefined || name === "" || name.endsWith("/") || name.startsWith(".")) return null;
  return { name, dir: norm.slice(0, i) + "/node_modules/" + name };
}

function addModule(build: ViteBuild, file: string): void {
  if (HELPER.test(file)) {
    build.viteHelpers = true;
    return;
  }
  const hit = packageOfModule(file);
  if (hit === null) return;
  const dir = path.resolve(hit.dir);
  const pkg = tryReadJson(path.join(dir, "package.json")) as { name?: unknown; version?: unknown } | undefined;
  if (pkg && typeof pkg.name === "string" && typeof pkg.version === "string") {
    build.packages.set(`${pkg.name}@${pkg.version}`, { name: pkg.name, version: pkg.version, dir });
  } else {
    const key = `${hit.name}@?`;
    if (!build.packages.has(key)) build.packages.set(key, { name: hit.name, version: "?", dir: null });
  }
}

/** Reads which packages a Vite build holds, from the plugin file or from its source maps. */
export function readViteBuild(dir: string): ViteBuild {
  const build: ViteBuild = { dir, packages: new Map(), viteHelpers: false, from: "none", maps: 0 };
  if (!isDir(dir)) return build;
  const pluginFile = path.join(dir, VITE_MODULES_FILE);
  if (isFile(pluginFile)) {
    const doc = tryReadJson(pluginFile) as { format?: unknown; modules?: unknown } | undefined;
    if (doc && doc.format === VITE_MODULES_FORMAT && Array.isArray(doc.modules)) {
      build.from = "plugin";
      for (const m of doc.modules) if (typeof m === "string") addModule(build, m);
      return build;
    }
  }
  const maps = walkFiles(dir, { skipDir: (name) => name === "node_modules" }).filter((f) => f.endsWith(".map"));
  for (const mapFile of maps) {
    let map: { sources?: unknown; sourceRoot?: unknown };
    try {
      map = JSON.parse(fs.readFileSync(mapFile, "utf8"));
    } catch {
      continue;
    }
    if (!Array.isArray(map.sources)) continue;
    build.maps++;
    const base = path.resolve(path.dirname(mapFile), typeof map.sourceRoot === "string" ? map.sourceRoot : "");
    for (const s of map.sources) {
      if (typeof s !== "string") continue;
      if (HELPER.test(s)) {
        build.viteHelpers = true;
        continue;
      }
      const clean = s.replace(/^\0/, "").replace(/^[a-z]+:\/\/\/?/i, "");
      addModule(build, path.isAbsolute(clean) ? clean : path.resolve(base, clean));
    }
  }
  if (build.maps > 0) build.from = "sourcemaps";
  return build;
}

/** The structural part of a Rollup output chunk that the plugin reads. */
interface ChunkLike {
  type: string;
  modules?: Record<string, unknown>;
}

/**
 * A Vite plugin that writes `.vite/memex-licenses.json` into the build: the id of every module
 * in every chunk. `memex-licenses notices --vite <dist>` then lists exactly the packages the
 * build holds, without source maps. It has no dependencies.
 */
export function memexLicensesVite(): {
  name: string;
  apply: "build";
  generateBundle(this: { emitFile(file: { type: "asset"; fileName: string; source: string }): string }, options: unknown, bundle: Record<string, ChunkLike>): void;
} {
  return {
    name: "memex-licenses",
    apply: "build",
    generateBundle(_options, bundle) {
      const modules = new Set<string>();
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== "chunk" || chunk.modules === undefined) continue;
        for (const id of Object.keys(chunk.modules)) modules.add(id);
      }
      this.emitFile({
        type: "asset",
        fileName: VITE_MODULES_FILE,
        source: JSON.stringify({ format: VITE_MODULES_FORMAT, modules: [...modules].sort() }, null, 2) + "\n",
      });
    },
  };
}
