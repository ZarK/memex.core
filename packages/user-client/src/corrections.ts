import { randomBytes } from "node:crypto";
import type { ContactsCorrection, ContactsCorrectionResult, ContactsRecord } from "./generated/contacts-api.js";
import type { UserCorrection, UserCorrectionResult, UserRecord } from "./generated/user-api.js";

/** A facts hub: Memex.User for facts about the owner, Memex.Contacts for facts about other people. */
export type Hub = "user" | "contacts";

export const HUBS: readonly Hub[] = ["user", "contacts"];

/** A correction of either hub, as the app sends it. */
export type HubCorrection = UserCorrection | ContactsCorrection;

/** A record of either hub. */
export type HubRecord = UserRecord | ContactsRecord;

/** A result of a corrections write of either hub. */
export type HubCorrectionResult = UserCorrectionResult | ContactsCorrectionResult;

/** The app's id for a record that a create in the outbox will make: local_ and 32 lowercase hex digits. */
export const LOCAL_ID = /^local_[0-9a-f]{32}$/;

export function isHub(value: unknown): value is Hub {
  return value === "user" || value === "contacts";
}

export function isLocalId(value: unknown): value is string {
  return typeof value === "string" && LOCAL_ID.test(value);
}

/**
 * A new correction id: cor_ and the 32 hex digits of a UUID v7 (facts.md, Corrections). The first 48 bits are the time
 * in milliseconds, so ids made later sort later.
 */
export function newCorrectionId(now: number = Date.now()): string {
  return "cor_" + uuidV7Hex(now);
}

/** A new local id for a record that a create will make. */
export function newLocalId(now: number = Date.now()): string {
  return "local_" + uuidV7Hex(now);
}

function uuidV7Hex(now: number): string {
  const bytes = randomBytes(16);
  const ms = BigInt(Math.max(0, Math.trunc(now)));
  for (let i = 0; i < 6; i++) bytes[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  return bytes.toString("hex");
}

/** The UTC time of now as the contracts write it: ISO 8601 with Z. */
export function utcNow(now: number = Date.now()): string {
  return new Date(now).toISOString();
}

/** createdAt in milliseconds, for ordering. A text that is not a time is refused. */
export function createdMs(createdAt: string): number {
  const ms = Date.parse(createdAt);
  if (!Number.isFinite(ms) || !/Z$/.test(createdAt)) throw new TypeError(`createdAt must be a UTC time with Z, not '${createdAt}'.`);
  return ms;
}

/** What one correction is about: a record and the fields that it changes ("*" for the whole record). */
export interface Target {
  record: string;
  fields: string[] | "*";
}

/**
 * The records and fields that a correction changes. These fields are protected in the local copy while the correction
 * waits in the outbox or has a mark (user-records.md, Reading back).
 */
export function targetsOf(c: HubCorrection, localId?: string | null): Target[] {
  switch (c.op) {
    case "set":
      return c.record ? [{ record: c.record, fields: Object.keys(c.fields ?? {}) }] : [];
    case "clear":
      return c.record ? [{ record: c.record, fields: [...(c.names ?? [])] }] : [];
    case "reject":
    case "restore":
      return c.record ? [{ record: c.record, fields: ["state"] }] : [];
    case "merge":
      return (c.records ?? []).map((record) => ({ record, fields: "*" as const }));
    case "create":
      return localId ? [{ record: localId, fields: "*" }] : c.record ? [{ record: c.record, fields: "*" }] : [];
    case "unmerge":
      // contacts-records.md: unmerge takes record, the merged person; the whole person comes back.
      return c.record ? [{ record: c.record, fields: "*" }] : [];
    default:
      // pin and unpin keep two persons apart; they change no field.
      return [];
  }
}

/** The local ids that a correction refers to (record, records, person, other). */
export function localRefs(c: HubCorrection): string[] {
  const x = c as HubCorrection & { person?: string; other?: string };
  const refs = [c.record, ...(c.records ?? []), x.person, x.other].filter(isLocalId);
  return [...new Set(refs)];
}

/** The correction with each local id replaced by the record id that the hub gave its create. */
export function withRecordIds<C extends HubCorrection>(c: C, ids: (local: string) => string | undefined): C {
  const map = (v: string | undefined) => (isLocalId(v) ? (ids(v) ?? v) : v);
  const out = { ...c } as C & { person?: string; other?: string };
  if (out.record !== undefined) out.record = map(out.record);
  if (out.records !== undefined) out.records = out.records.map((r) => map(r)!);
  if (out.person !== undefined) out.person = map(out.person);
  if (out.other !== undefined) out.other = map(out.other);
  return out;
}

/**
 * Checks the shape that the outbox needs: an id, a time, an op, and the record fields of the op. The hub checks the
 * rest; a correction that it refuses stays in the outbox with a mark (facts.md, The outbox).
 */
export function checkCorrection(hub: Hub, c: HubCorrection): void {
  const fail = (message: string): never => {
    throw new TypeError(`The correction ${c.id ?? ""} cannot be saved: ${message}`);
  };
  if (!/^cor_[0-9a-f]{32}$/.test(c.id)) fail("id must be cor_ and 32 lowercase hex digits.");
  createdMs(c.createdAt);
  if (!/^[a-z][a-z0-9]*$/.test(c.app)) fail("app must be an app id.");
  const ops = hub === "user" ? ["set", "clear", "reject", "restore", "merge", "create"] : ["set", "clear", "reject", "restore", "merge", "create", "unmerge", "pin", "unpin"];
  if (!ops.includes(c.op)) fail(`${hub} takes no op '${c.op}'.`);
  if (["set", "clear", "reject", "restore", "unmerge"].includes(c.op) && typeof c.record !== "string") fail(`${c.op} needs record.`);
  if (c.op === "set" && (!c.fields || Object.keys(c.fields).length === 0)) fail("set needs fields.");
  if (c.op === "clear" && (!c.names || c.names.length === 0)) fail("clear needs names.");
  if (c.op === "merge" && (!c.records || c.records.length < 2)) fail("merge needs two or more records.");
  if (c.op === "create") {
    if (!c.kind || !c.fields) fail("create needs kind and fields.");
    if (c.record !== undefined) fail("a create has no record; the hub gives it.");
  }
  // contacts-records.md, Corrections, merges, and pins: pin and unpin take records, two persons.
  if ((c.op === "pin" || c.op === "unpin") && (!c.records || c.records.length !== 2 || c.records.some((r) => typeof r !== "string"))) fail(`${c.op} needs records with two persons.`);
}
