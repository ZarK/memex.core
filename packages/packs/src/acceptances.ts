import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { currentMemexPaths, memexPaths } from "@tjalve/memex-storage";
import { writeFileWhole } from "./files.js";
import { PACK_ID_PATTERN, PackError } from "./manifest.js";

export const ACCEPTANCES_FORMAT = "memex.acceptances/1";
export const ACCEPTANCES_FILE = "acceptances.json";

/** One accepted license text (schemas/packs/acceptances.json). */
export interface Acceptance {
  pack: string;
  /** The version the user saw. The acceptance covers every version with the same text hash. */
  version: string;
  textSha256: string;
  acceptedAt: string;
  /** The app in which the user accepted. */
  app: string;
}

export interface AcceptancesOptions {
  /** The acceptances file. Default acceptances.json in the data folder of Memex.Node (~/Memex/Node, MEMEX_NODE_HOME). */
  file?: string;
  env?: NodeJS.ProcessEnv;
}

/** Where Memex.Node keeps acceptances: <data folder of node>/acceptances.json. */
export function acceptancesFile(options: AcceptancesOptions = {}): string {
  if (options.file !== undefined) return options.file;
  const data = options.env === undefined ? currentMemexPaths("node").data : memexPaths({ app: "node", platform: process.platform, env: options.env, home: os.homedir() }).data;
  return path.join(data, ACCEPTANCES_FILE);
}

async function readBody(file: string): Promise<{ format: string; acceptances: Acceptance[] } & Record<string, unknown>> {
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { format: ACCEPTANCES_FORMAT, acceptances: [] };
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new PackError("invalid_acceptances", `${file} is not valid ${ACCEPTANCES_FORMAT} JSON: ${(error as Error).message}`);
  }
  const v = value as { format?: unknown; acceptances?: unknown } | null;
  if (typeof v !== "object" || v === null || v.format !== ACCEPTANCES_FORMAT || !Array.isArray(v.acceptances)) {
    throw new PackError("invalid_acceptances", `${file} must have "format": "${ACCEPTANCES_FORMAT}" and a list "acceptances".`);
  }
  return v as { format: string; acceptances: Acceptance[] };
}

/** The license texts that the user accepted. */
export async function readAcceptances(options: AcceptancesOptions = {}): Promise<Acceptance[]> {
  return (await readBody(acceptancesFile(options))).acceptances;
}

/** True when the user accepted this license text (by its SHA-256) for this pack. */
export async function isAccepted(pack: string, textSha256: string, options: AcceptancesOptions = {}): Promise<boolean> {
  return (await readAcceptances(options)).some((a) => a.pack === pack && a.textSha256 === textSha256);
}

/**
 * Records that the user accepted a license text, in the same file and layout as Memex.Node, for an app that installs
 * a pack itself while Node does not run (Study's downloader in v1). The app shows the text and records the acceptance
 * only after the user accepted it. Accepting the same text again keeps the first record. Other entries and keys are kept.
 */
export async function recordAcceptance(
  entry: { pack: string; version: string; textSha256: string; app: string; acceptedAt?: Date },
  options: AcceptancesOptions = {},
): Promise<Acceptance> {
  if (!PACK_ID_PATTERN.test(entry.pack)) throw new PackError("invalid_input", `'${entry.pack}' is not a pack id.`);
  if (!/^[a-z][a-z0-9]*$/.test(entry.app)) throw new PackError("invalid_input", `app must be an app id: '${entry.app}'.`);
  if (!/^[0-9a-f]{64}$/.test(entry.textSha256)) throw new PackError("invalid_input", "textSha256 must be 64 lowercase hex characters.");
  const file = acceptancesFile(options);
  const body = await readBody(file);
  const existing = body.acceptances.find((a) => a.pack === entry.pack && a.textSha256 === entry.textSha256);
  if (existing !== undefined) return existing;
  const record: Acceptance = {
    pack: entry.pack,
    version: entry.version,
    textSha256: entry.textSha256,
    acceptedAt: (entry.acceptedAt ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z"),
    app: entry.app,
  };
  body.acceptances.push(record);
  await writeFileWhole(file, JSON.stringify(body, null, 2) + "\n");
  return record;
}
