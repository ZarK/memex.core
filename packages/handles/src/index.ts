import { type CountryCode, isSupportedCountry, parsePhoneNumberFromString } from "libphonenumber-js/min";

/** The address space of a handle: a phone number, an email address, or an account on a platform. */
export type HandleKind = "phone" | "email" | "platform";

/**
 * - `normalized`: `value` is an E.164 phone number or a lowercase email address.
 * - `raw`: a platform handle; `value` is the handle as the source wrote it, trimmed.
 * - `unparsed`: the handle could not be read; it has no `value` and never matches a person automatically.
 */
export type HandleStatus = "normalized" | "raw" | "unparsed";

/** A handle as in contracts/message.md. `raw` is always the source's own text, unchanged. */
export interface Handle {
  kind: HandleKind;
  raw: string;
  status: HandleStatus;
  value?: string;
  /** The E.164 form of a platform handle that holds a phone number, for example a WhatsApp JID. */
  phone?: string;
}

export interface NormalizeOptions {
  /** ISO 3166-1 alpha-2 region for numbers without a country code, for example `NO`. Configuration, not code. */
  region?: string;
  /** The address space, when the source knows it. Otherwise it is read from the handle and the service. */
  kind?: HandleKind;
  /** The service that carried the handle, for example `sms`, `imessage`, `whatsapp`, `mail` or `msn`. */
  service?: string;
}

export class HandlesError extends Error {
  constructor(
    readonly code: "unknown-region",
    message: string,
  ) {
    super(message);
    this.name = "HandlesError";
  }
}

/** Services whose handles are accounts on the platform, kept in their platform form. */
export const PLATFORM_SERVICES: readonly string[] = [
  "telegram",
  "messenger",
  "facebook-chat",
  "gtalk",
  "hangouts",
  "msn",
  "x-dm",
  "skype",
  "irc",
];

const WHATSAPP_JID = /^(\d+)(?::\d+)?@(s\.whatsapp\.net|c\.us)$/i;
const ANY_WHATSAPP_JID = /@(s\.whatsapp\.net|c\.us|g\.us|lid|broadcast|newsletter)$/i;
const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+$/;

/** Reads one handle. It never throws for bad input: a handle that cannot be read gets the status `unparsed`. */
export function normalizeHandle(raw: string, options: NormalizeOptions = {}): Handle {
  const region = checkRegion(options.region);
  const text = raw.trim();
  const kind = options.kind ?? guessKind(text, options.service);

  if (kind === "email") {
    const value = normalizeEmail(text);
    return value === undefined ? { kind, raw, status: "unparsed" } : { kind, raw, status: "normalized", value };
  }
  if (kind === "phone") {
    const value = normalizePhone(text, region);
    return value === undefined ? { kind, raw, status: "unparsed" } : { kind, raw, status: "normalized", value };
  }
  if (text === "") return { kind, raw, status: "unparsed" };
  const handle: Handle = { kind, raw, status: "raw", value: text };
  const jid = WHATSAPP_JID.exec(text);
  const phone = jid ? normalizePhone(`+${jid[1]}`) : undefined;
  if (phone !== undefined) handle.phone = phone;
  return handle;
}

/** E.164 form of a phone number, or undefined when it is not a valid number (short codes, sender names, extensions). */
export function normalizePhone(raw: string, region?: string): string | undefined {
  const text = raw.trim().replace(/^tel:/i, "");
  if (!/\d/.test(text) || /[a-z]/i.test(text)) return undefined;
  const number = parsePhoneNumberFromString(text, checkRegion(region));
  if (number === undefined || !number.isValid() || number.ext !== undefined) return undefined;
  return number.number;
}

/** Trimmed, lowercase email address, or undefined when the text is not an address. Accepts `Name <address>` and `mailto:`. */
export function normalizeEmail(raw: string): string | undefined {
  let text = raw.trim();
  const angle = /<([^<>]*)>\s*$/.exec(text);
  if (angle) text = angle[1]!.trim();
  text = text.replace(/^mailto:/i, "");
  return EMAIL.test(text) ? text.toLowerCase() : undefined;
}

function guessKind(text: string, service: string | undefined): HandleKind {
  if (/^tel:/i.test(text)) return "phone";
  if (/^mailto:/i.test(text)) return "email";
  if (ANY_WHATSAPP_JID.test(text)) return "platform";
  if (service !== undefined && PLATFORM_SERVICES.includes(service)) return "platform";
  if (service === "mail" || text.includes("@")) return "email";
  return "phone";
}

function checkRegion(region: string | undefined): CountryCode | undefined {
  if (region === undefined) return undefined;
  const upper = region.toUpperCase();
  if (!isSupportedCountry(upper)) throw new HandlesError("unknown-region", `unknown region ${region}`);
  return upper;
}
