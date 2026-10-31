export * from "./generated/user-api.js";
export * from "./generated/contacts-api.js";
export { UserClient, ContactsClient } from "./client.js";
export type { HubClient, HubClientOptions } from "./client.js";
export { ensureUser, ensureContacts, ensureHub, ensureHubService } from "./ensure.js";
export type { EnsureHubOptions } from "./ensure.js";
export {
  HUBS,
  LOCAL_ID,
  isHub,
  isLocalId,
  newCorrectionId,
  newLocalId,
  utcNow,
  targetsOf,
  localRefs,
  checkCorrection,
} from "./corrections.js";
export type { Hub, HubCorrection, HubRecord, HubCorrectionResult, Target } from "./corrections.js";
export { FactsStore, installStore, STORE_SCOPE, STORE_MIGRATIONS } from "./store.js";
export type { OutboxItem, HeldMark, LocalRecord, CorrectionInput, SavedCorrection, IncomingChange } from "./store.js";
export { FactsSync, MAX_BATCH } from "./sync.js";
export type { FactsSyncOptions, SyncReport, SyncStatus } from "./sync.js";
