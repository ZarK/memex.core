/** Where a component came from. */
export type Ecosystem =
  | "npm" // a package in the pnpm lockfile and node_modules
  | "vite" // code that Vite itself puts in a build (its preload helpers)
  | "nuget" // a package in a .NET project.assets.json
  | "dotnet" // the .NET runtime and ASP.NET Core
  | "electron" // Electron and Chromium
  | "font" // a font file in the app
  | "vendor" // a library copied into the repository
  | "third-party" // an entry in third-party.json: data, models, icons, corpora
  | "pack"; // a memex.pack/1 manifest

/** How a component reaches the user. */
export type Delivery =
  | "bundled" // in the installer or the build
  | "hosted" // on a Memex host, for example the release assets of Memex packs
  | "download" // the user's device downloads it from the publisher
  | "service"; // the app calls a service and keeps no copy

export type Commercial = "allowed" | "restricted" | "unknown";

export interface LicenseFile {
  /** The name in the licenses/ folder, relative to the component's folder. */
  name: string;
  /** Where the text is, when it is a file on disk. */
  path?: string;
  /** The text, when it does not come from a plain file (for example from a zip). */
  text?: string;
  bytes: number;
  sha256: string;
}

export interface Component {
  /** `<ecosystem>:<name>@<version>`, or `<ecosystem>:<name>` without a version. */
  key: string;
  ecosystem: Ecosystem;
  name: string;
  version: string;
  /** The license as declared, an SPDX expression where possible; null when nothing declares one. */
  license: string | null;
  /** What the license came from: package.json, nuspec, the license text, the font, third-party.json, the pack. */
  licenseFrom: string;
  licenseFiles: LicenseFile[];
  /** The component whose license file this one uses: the main package of a platform package. */
  licenseTextFrom?: string;
  copyright: string[];
  homepage?: string;
  /** The author or authors named in the package metadata. */
  authors?: string;
  delivery: Delivery;
  /** Where the inventory found it, for example `pnpm:.`, `vite:dist`, `dotnet:sidecar/App`. */
  via: string[];
  kind?: string;
  /** The credit line for About and for where the content appears. */
  attribution?: string | null;
  commercial?: Commercial;
  limits?: string[];
  /** Places where the license does not apply or the content may not be used. */
  territories?: string[];
  notice?: string;
  /** An open blocker from the license review. */
  blocker?: string | null;
  /** True for an optional package that is not installed on this machine (another platform's binary). */
  missingOptional?: boolean;
  /** True when the package is in the lockfile but not in node_modules. */
  missing?: boolean;
  /** True when the license file is the standard text made from the SPDX id, because the package ships none. */
  generatedText?: boolean;
  /** Set when the license file holds a known license plus terms of its own: the check needs a decision. */
  customTerms?: string;
  /** A short note for the report. */
  note?: string;
}

export interface InventoryNote {
  source: string;
  message: string;
}

export interface Inventory {
  root: string;
  product: string;
  components: Component[];
  notes: InventoryNote[];
  /** What was read, for the report. */
  sources: string[];
}
