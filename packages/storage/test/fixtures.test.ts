import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  APP_IDS,
  MemexPathsError,
  dataSource,
  packsSource,
  describeLocation,
  electronPaths,
  locationWarningText,
  locationsFilePath,
  memexPaths,
  retiredVariables,
  syncWarnings,
  type FolderSize,
  type LocationDescription,
  type LocationsFile,
  type SyncCheckedKey,
} from "../src/index.js";

const fixtures = new URL("../../../contracts/fixtures/storage/", import.meta.url);
function load<T>(name: string): T {
  return JSON.parse(readFileSync(fileURLToPath(new URL(name, fixtures)), "utf8")) as T;
}

interface PathCase {
  name: string;
  input: { app: string; platform: string; home: string; env: Record<string, string>; flag?: string; locations?: LocationsFile };
  expected?: Record<string, string>;
  source?: string;
  packsSource?: string;
  error?: string;
}

describe("memexPaths fixtures", () => {
  const { cases } = load<{ cases: PathCase[] }>("paths.json");
  it("has cases", () => expect(cases.length).toBeGreaterThan(10));
  for (const c of cases) {
    it(c.name, () => {
      if (c.error !== undefined) {
        let caught: unknown;
        try {
          memexPaths(c.input);
        } catch (e) {
          caught = e;
        }
        expect(caught).toBeInstanceOf(MemexPathsError);
        expect((caught as MemexPathsError).code).toBe(c.error);
      } else {
        expect(memexPaths(c.input)).toEqual(c.expected);
        if (c.source !== undefined) expect(dataSource(c.input)).toBe(c.source);
        if (c.packsSource !== undefined) expect(packsSource(c.input)).toBe(c.packsSource);
      }
    });
  }
});

describe("retiredVariables fixtures", () => {
  const { cases } = load<{ cases: Array<{ name: string; env: Record<string, string>; expected: unknown }> }>("retired.json");
  for (const c of cases) {
    it(c.name, () => expect(retiredVariables(c.env)).toEqual(c.expected));
  }
});

describe("syncWarnings fixtures", () => {
  const { cases } = load<{
    cases: Array<{ name: string; platform: string; home: string; env: Record<string, string>; paths: Record<string, string>; expected: unknown }>;
  }>("sync.json");
  for (const c of cases) {
    it(c.name, () =>
      expect(syncWarnings(c.paths, { platform: c.platform, env: c.env, home: c.home })).toEqual(c.expected),
    );
  }
});

interface LocationCase {
  name: string;
  platform: string;
  home: string;
  env: Record<string, string>;
  path: string;
  exists?: string[];
  files?: string[];
  realpath?: Record<string, string>;
  mounts?: string;
  msixPackageFamily?: string;
  expected?: LocationDescription;
  error?: string;
}

describe("describeLocation fixtures", () => {
  const { cases } = load<{ cases: LocationCase[] }>("location.json");
  it("covers every kind on Windows, macOS, and Linux path forms", () => {
    const seen = new Set(cases.filter((c) => c.expected).map((c) => `${c.platform}:${c.expected!.kind}`));
    for (const kind of ["local", "sync", "network", "virtualized"]) expect(seen.has(`win32:${kind}`)).toBe(true);
    for (const kind of ["local", "sync", "network", "removable"]) {
      expect(seen.has(`darwin:${kind}`)).toBe(true);
      expect(seen.has(`linux:${kind}`)).toBe(true);
    }
    const providers = new Set(cases.map((c) => c.expected?.provider));
    for (const p of ["OneDrive", "Dropbox", "iCloud Drive", "Google Drive", "Proton Drive", "Nextcloud", "Syncthing", "MSIX"]) {
      expect(providers.has(p)).toBe(true);
    }
  });
  for (const c of cases) {
    it(c.name, () => {
      const files = new Set(c.files ?? []);
      const exists = new Set([...(c.exists ?? []), ...files]);
      const options = {
        platform: c.platform,
        env: c.env,
        home: c.home,
        msixPackageFamily: c.msixPackageFamily,
        exists: (p: string) => exists.has(p),
        isFile: (p: string) => files.has(p),
        realpath: (p: string) => {
          const real = c.realpath?.[p];
          if (real === undefined) throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
          return real;
        },
        mounts: () => c.mounts ?? null,
      };
      if (c.error !== undefined) {
        expect(() => describeLocation(c.path, options)).toThrow(MemexPathsError);
      } else {
        expect(describeLocation(c.path, options)).toEqual(c.expected);
      }
    });
  }
});

describe("electronPaths fixtures", () => {
  const { cases } = load<{ cases: Array<{ name: string; input: PathCase["input"]; expected: unknown }> }>("electron.json");
  for (const c of cases) {
    it(c.name, () => expect(electronPaths(memexPaths(c.input), { platform: c.input.platform })).toEqual(c.expected));
  }
});

describe("locationsFilePath fixtures", () => {
  const { cases } = load<{
    cases: Array<{ name: string; platform: string; home: string; env: Record<string, string>; expected: string }>;
  }>("locations-file.json");
  for (const c of cases) {
    it(c.name, () => expect(locationsFilePath(c)).toBe(c.expected));
  }
});

describe("locationWarningText fixtures", () => {
  const { cases } = load<{
    cases: Array<{ name: string; key: SyncCheckedKey; path: string; location: LocationDescription; size: FolderSize | null; expected: string | null }>;
  }>("warning-text.json");
  for (const c of cases) {
    it(c.name, () => expect(locationWarningText(c)).toBe(c.expected));
  }
});

describe("memexPaths", () => {
  it("is pure: the same input gives the same result and the input is not changed", () => {
    const env = Object.freeze({ MEMEX_HOME: "/x" });
    const input = Object.freeze({ app: "photos", platform: "linux", home: "/home/a", env });
    expect(memexPaths(input)).toEqual(memexPaths(input));
  });
  it("puts data under ~/Memex and keeps packs, cache, logs, and state outside it on every platform", () => {
    const homes = { win32: "C:\\Users\\a", darwin: "/Users/a", linux: "/home/a" } as const;
    for (const [platform, home] of Object.entries(homes)) {
      const sep = platform === "win32" ? "\\" : "/";
      const userRoot = home + sep + "Memex";
      for (const app of APP_IDS) {
        const p = memexPaths({ app, platform, home, env: {} });
        expect(p.data.startsWith(userRoot + sep)).toBe(true);
        for (const key of ["cache", "logs", "state", "packs", "apps"] as const) {
          expect(p[key].startsWith(userRoot)).toBe(false);
        }
      }
    }
  });
});
