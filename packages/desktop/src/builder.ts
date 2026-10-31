import { fileURLToPath } from "node:url";

/**
 * The electron-builder base config of every Memex app. The app passes its own parts and gets one config that
 * builds the same installers everywhere: NSIS per user on Windows, a dmg for Apple silicon, an AppImage and a deb
 * for Linux on x64.
 */
export interface BuilderOptions {
  /** The app id: photos, study, ... The bundle id is to.memex.<app>. */
  app: string;
  /** The display name, for example "Memex Photos". */
  productName: string;
  /** The first part of every installer name. Defaults to productName with spaces as dots (Memex.Photos). */
  artifactBase?: string;
  /** The Linux program name. Defaults to memex-<app>. */
  linuxExecutableName?: string;
  /** The Linux desktop category. */
  linuxCategory?: string;
  copyright?: string;
  /** The project's web page. The deb names it as the package's homepage; electron-builder refuses a deb without one. */
  homepage?: string;
  /** The deb's maintainer, "Name <email>". electron-builder refuses a deb without one. */
  maintainer?: string;
  /** Files of the app folder for app.asar. Source maps are always left out. */
  files: string[];
  /** Paths inside app.asar to keep unpacked (native modules, programs a server runs). */
  asarUnpack?: string[];
  /** More resources beside app.asar. */
  extraResources?: Array<{ from: string; to: string; filter?: string[] }>;
  /** The folder with the CLI shims for each platform: <dir>/win32, <dir>/darwin, <dir>/linux. Packed as <resources>/bin. */
  cliShims?: string;
  /** The folder with notices.json, THIRD-PARTY-NOTICES.md and licenses/. Packed as <resources>/notices. */
  notices?: string;
  /**
   * The staged shared services (stageServices, which pack runs from the app's services.json): packed as
   * <resources>/services, with the NSIS hooks that install and remove them and a note in the dmg.
   */
  services?: string;
  /**
   * The note about the services in the dmg window. electron-builder takes dmg contents only from inside the project, so
   * pack copies this package's note (SERVICES_DMG_NOTE) into the build folder and names the copy here.
   */
  servicesNote?: string;
  /** The folder with icon.ico, icon.icns and the PNG sizes. Defaults to icons. */
  icons?: string;
  /** The output folder. Defaults to release. */
  output?: string;
  /** An unpacked Electron of the pinned version (memex-desktop fetch-electron), so the builder downloads nothing. */
  electronDist?: string;
  /** The Electron version, when the builder cannot read it from the app's package.json. */
  electronVersion?: string;
  /**
   * Keep the runAsNode fuse on. Off by default: with it on, any local program can run its own JavaScript as this app
   * (ELECTRON_RUN_AS_NODE), and on macOS with the app's privacy grants. The CLI shim needs it, so an app that ships a
   * CLI (pack's cli option) must set it, which records that choice in its pack config.
   */
  runAsNode?: boolean;
  /**
   * The macOS signing identity, for example "Developer ID Application: ...". Defaults to "-", an ad-hoc signature of
   * the whole bundle, which an unsigned build needs on Apple silicon.
   */
  macIdentity?: string;
}

const APP = /^[a-z][a-z0-9]*$/;

/**
 * The hardened runtime entitlements for a macOS signing identity, from this package's assets: the JIT that V8 needs,
 * and for an ad-hoc signature ("-") no library validation. Never allow-dyld-environment-variables.
 */
/** A file of this package's assets. */
export function desktopAsset(name: string): string {
  return fileURLToPath(new URL(`../assets/${name}`, import.meta.url));
}

/** The NSIS script with the customInstall and customUnInstall hooks of the shared services. */
export const SERVICES_NSIS_INCLUDE = "installer.nsh";
/** The note about the shared services in the dmg window. */
export const SERVICES_DMG_NOTE = "About Memex services.txt";

export function macEntitlements(identity: string | undefined): string {
  const file = (identity ?? "-") === "-" ? "entitlements.mac.adhoc.plist" : "entitlements.mac.plist";
  return fileURLToPath(new URL(`../assets/${file}`, import.meta.url));
}

/** The electron-builder configuration object. Pass it as the config of electron-builder's build(). */
export function builderConfig(options: BuilderOptions): Record<string, unknown> {
  if (!APP.test(options.app)) throw new Error(`The app id ${options.app} must be lower case letters and digits.`);
  const base = options.artifactBase ?? options.productName.trim().replace(/\s+/g, ".");
  if (!/^[A-Za-z0-9._-]+$/.test(base)) throw new Error(`The artifact name ${base} must be letters, digits, dots, dashes and underscores.`);
  const icons = options.icons ?? "icons";
  const extraResources: Array<{ from: string; to: string; filter?: string[] }> = [...(options.extraResources ?? [])];
  if (options.notices) extraResources.push({ from: options.notices, to: "notices", filter: ["**/*"] });
  if (options.services) extraResources.push({ from: options.services, to: "services", filter: ["**/*"] });
  // Only the shim itself: the folder also holds the Windows shim's source, and maybe files of an earlier pack.
  const shims = (platform: string) =>
    options.cliShims ? { extraResources: [{ from: `${options.cliShims}/${platform}`, to: "bin", filter: [platform === "win32" ? `memex-${options.app}.exe` : `memex-${options.app}`] }] } : {};
  const config: Record<string, unknown> = {
    appId: `to.memex.${options.app}`,
    productName: options.productName,
    copyright: options.copyright,
    asar: true,
    asarUnpack: options.asarUnpack ?? [],
    directories: { output: options.output ?? "release", buildResources: icons },
    files: [...options.files, "!**/*.map"],
    extraResources,
    publish: null,
    electronFuses: {
      // Only for an app that ships the CLI shim, which runs the CLI with the program's own Node.js.
      runAsNode: options.runAsNode === true,
      enableCookieEncryption: true,
      enableNodeOptionsEnvironmentVariable: false,
      enableNodeCliInspectArguments: false,
      enableEmbeddedAsarIntegrityValidation: true,
      onlyLoadAppFromAsar: true,
      grantFileProtocolExtraPrivileges: false,
    },
    win: {
      icon: `${icons}/icon.ico`,
      // Set the program's icon and version resources; sign nothing until a certificate is chosen.
      signAndEditExecutable: true,
      signExecutable: false,
      artifactName: `${base}-\${version}-windows-\${arch}.\${ext}`,
      target: [{ target: "nsis", arch: ["x64"] }],
      ...shims("win32"),
    },
    nsis: {
      oneClick: false,
      perMachine: false,
      allowElevation: false,
      allowToChangeInstallationDirectory: true,
      // The user's data is in ~/Memex/<App> and the OS folders, never in the program folder; the uninstaller leaves it.
      deleteAppDataOnUninstall: false,
      createDesktopShortcut: true,
      createStartMenuShortcut: true,
      shortcutName: options.productName,
      // The shared services: the app's program installs them after the files, and removes the app from their clients
      // before the files go (not on an update).
      ...(options.services ? { include: desktopAsset(SERVICES_NSIS_INCLUDE) } : {}),
    },
    mac: {
      icon: `${icons}/icon.icns`,
      category: "public.app-category.productivity",
      // Until a Developer ID is chosen, the whole bundle gets an ad-hoc signature after the fuses are set. Setting the
      // fuses changes the Electron Framework binary, and on Apple silicon macOS stops a program whose signature no
      // longer matches (SIGKILL at start). The ad-hoc signature also names the bundle id instead of "Electron".
      identity: options.macIdentity ?? "-",
      // The hardened runtime always, ad hoc too: without it dyld honours DYLD_INSERT_LIBRARIES, so any program of the
      // account could run its own code inside the app, with the app's macOS privacy grants. An ad-hoc signature has no
      // team id, so its entitlements also turn library validation off (it would refuse the app's own Electron Framework).
      hardenedRuntime: true,
      entitlements: macEntitlements(options.macIdentity),
      entitlementsInherit: macEntitlements(options.macIdentity),
      artifactName: `${base}-\${version}-macos-\${arch}.\${ext}`,
      target: [{ target: "dmg", arch: ["arm64"] }],
      ...shims("darwin"),
    },
    dmg: {
      writeUpdateInfo: false,
      // The app, the Applications folder, and with the shared services a note about them: a dmg app has no installer
      // or uninstaller, so its first start installs the services, and the person removes the app with the Trash.
      ...(options.services
        ? {
            window: { width: 540, height: 480 },
            contents: [
              { x: 130, y: 200 },
              { x: 410, y: 200, type: "link", path: "/Applications" },
              { x: 270, y: 360, type: "file", path: options.servicesNote ?? desktopAsset(SERVICES_DMG_NOTE) },
            ],
          }
        : {}),
    },
    linux: {
      icon: icons,
      category: options.linuxCategory ?? "Utility",
      executableName: options.linuxExecutableName ?? `memex-${options.app}`,
      ...(options.maintainer ? { maintainer: options.maintainer } : {}),
      // Keep linux-x64 in the name: the builder writes x86_64 (AppImage) or amd64 (deb) for ${arch}.
      artifactName: `${base}-\${version}-linux-x64.\${ext}`,
      target: [
        { target: "AppImage", arch: ["x64"] },
        { target: "deb", arch: ["x64"] },
      ],
      ...shims("linux"),
    },
  };
  if (options.homepage) config.extraMetadata = { homepage: options.homepage };
  if (options.electronDist) config.electronDist = options.electronDist;
  if (options.electronVersion) config.electronVersion = options.electronVersion;
  if (options.copyright === undefined) delete config.copyright;
  return config;
}

/** The program file name the builder makes on a platform, for the CLI shim. */
export function executableName(options: Pick<BuilderOptions, "app" | "productName" | "linuxExecutableName">, platform: string): string {
  if (platform === "win32") return `${options.productName}.exe`;
  if (platform === "darwin") return options.productName;
  return options.linuxExecutableName ?? `memex-${options.app}`;
}
