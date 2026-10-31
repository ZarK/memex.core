/** @tjalve/memex-desktop/build: packing a Memex app. No Electron import. */
export { builderConfig, executableName } from "./builder.js";
export type { BuilderOptions } from "./builder.js";
export { buildWindowsCliLauncher, cliShimName, desktopProgram, findWindowsCsc, installedCliShim, unixCliShim, windowsCliLauncherSource, writeCliShim } from "./cli-shim.js";
export type { CliShimOptions } from "./cli-shim.js";
export { electronExecutablePath, electronPackageDir, fetchElectron } from "./fetch-electron.js";
export type { FetchElectronOptions, FetchElectronResult } from "./fetch-electron.js";
export { ICON_SIZES, ICO_SIZES, buildIcns, buildIco } from "./icons.js";
export { loadPackConfig, pack } from "./pack.js";
export { runSmoke } from "./smoke-run.js";
export type { SmokeRunOptions, SmokeRunResult } from "./smoke-run.js";
export { SMOKE_ENV, SMOKE_EXPECT_ENV, pageOutcome, smokeEventLine, smokeFolder } from "./smoke.js";
export type { SmokeOutcome, SmokeResult, SmokeSettings } from "./smoke.js";
export type { DesktopPackConfig, PackOptions, PackResult } from "./pack.js";
export {
  artifactPattern,
  assertPackedAppFiles,
  assertReleaseVersion,
  checkUpdateFiles,
  FIRST_PARTY_MODULES,
  extractAsar,
  extractRelease,
  findAppAsarArchives,
  findPnpmLockfile,
  hashFile,
  hashFileSync,
  inspectReleaseAsar,
  isReleaseCandidate,
  listAsarFiles,
  listShareArtifacts,
  mergeBuilderChecksums,
  parseUpdateFile,
  updateChannelOf,
  updateFileName,
  nonRegistryPackages,
  normalizeLinuxArtifactNames,
  packageOfPath,
  parseReleaseTag,
  readPackageVersion,
  releaseTagFromEnv,
  writeChecksums,
} from "./release.js";
export type { AsarRules, ExtractOptions, ReleaseVersionInput } from "./release.js";
export {
  CLIENTS_FOLDER,
  KEEP_VERSIONS,
  SERVICES_ARG,
  SERVICES_BUNDLE_FORMAT,
  SERVICES_CLIENT_FORMAT,
  SERVICES_LOCK,
  SERVICES_PINS_FORMAT,
  checkedServicesFolder,
  installServices,
  installedServices,
  installedVersions,
  pinServices,
  readClients,
  readServicesBundle,
  readServicesPins,
  serviceTarget,
  servicesAction,
  servicesStatus,
  stageServices,
  uninstallServices,
  withServicesLock,
} from "./services.js";
export type { InstallServicesOptions, InstallServicesResult, ServicesBundle, ServicesClient, ServicesPins, StageServicesOptions, UninstallServicesOptions, UninstallServicesResult } from "./services.js";
export type { ServicesPackConfig } from "./pack.js";
export { SERVICES_DMG_NOTE, SERVICES_NSIS_INCLUDE, desktopAsset } from "./builder.js";
