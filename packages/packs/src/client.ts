import { createHash } from "node:crypto";
import { ensureNode, type EnsureNodeOptions, type NodeClient, type Pack, type PackInstall, type PackLocation } from "@tjalve/memex-node-client";
import { PackError } from "./manifest.js";
import { resolvePack, type ResolveOptions } from "./store.js";

/** The progress of an install as Memex.Node reports it: the PackInstall of the contract, with Node's extra fields. */
export interface InstallState extends PackInstall {
  /** The file that downloads or is checked now. */
  file?: string | null;
  /** The bytes that an earlier, interrupted run had downloaded already. */
  resumedAt?: number;
}

export interface InstallOptions {
  /** A version other than the one Node chooses (its catalog version, else the active one, else the newest). */
  version?: string;
  /** Called with the pack each time Node reports progress, until the install ends. */
  onProgress?: (pack: Pack, install: InstallState | null) => void;
  signal?: AbortSignal;
}

/** The license text that the user reads, and its SHA-256, which the acceptance names. */
export interface LicenseText {
  text: string;
  textSha256: string;
}

/**
 * The packs of Memex.Node for an app (node.packs.*: GET /v1/packs and the routes under it; contracts/node-api.md,
 * Packs): the catalog, the state of a pack, an install with its progress, the license and its acceptance by text hash,
 * and the folder of the active version.
 */
export class PacksClient {
  constructor(readonly node: NodeClient) {}

  /** Every pack in Node's catalog and in the store, with its state. */
  async catalog(): Promise<Pack[]> {
    return (await this.node.listPacks()).items;
  }

  /** One pack, with its manifest: state, active version, versions, license, acceptance, install progress, path. */
  async status(id: string): Promise<Pack> {
    return this.node.getPack(id);
  }

  /** The license text of a pack, as Node serves it, with the SHA-256 of its UTF-8 bytes. */
  async license(id: string): Promise<LicenseText> {
    const text = await this.node.getPackLicense(id);
    return { text, textSha256: createHash("sha256").update(text, "utf8").digest("hex") };
  }

  /**
   * Records that the user accepted the license text in this app. Pass the text that the user read (its SHA-256 is
   * sent), or its textSha256. Node checks the hash against the license file of the manifest (409 license_changed).
   */
  async accept(id: string, input: { app: string; version: string; text?: string; textSha256?: string }): Promise<Pack> {
    const textSha256 = input.textSha256 ?? (input.text === undefined ? undefined : createHash("sha256").update(input.text, "utf8").digest("hex"));
    if (textSha256 === undefined) throw new PackError("invalid_input", "accept needs the text that the user accepted, or its textSha256.");
    return this.node.acceptPackLicense(id, { app: input.app, version: input.version, textSha256 });
  }

  /**
   * Installs a pack and follows its progress (POST /v1/packs/{id}/install, then the server-sent events of
   * GET /v1/packs/{id}/events) until it is installed. Throws a SurfaceError with Node's error body when Node refuses
   * (acceptance_required, license_unknown), and PackError "install_failed" with Node's reason when the install fails.
   */
  async install(id: string, options: InstallOptions = {}): Promise<Pack> {
    const started = await this.node.installPack(id, options.version === undefined ? undefined : { version: options.version });
    options.onProgress?.(started, started.install as InstallState | null);
    let last = started;
    if (isRunning(last)) {
      const events = await this.node.packEvents(id);
      for await (const event of events) {
        if (options.signal?.aborted) break;
        if (event.event !== "pack" || typeof event.data !== "object" || event.data === null) continue;
        last = event.data as Pack;
        options.onProgress?.(last, last.install as InstallState | null);
        if (!isRunning(last)) break;
      }
      if (options.signal?.aborted) throw new PackError("aborted", `Stopped following the install of ${id}; Node goes on with it.`);
      if (isRunning(last)) last = await this.node.getPack(id);
    }
    const install = last.install as InstallState | null;
    if (install?.phase === "failed" || last.state !== "installed") {
      throw new PackError(
        install?.error?.code ?? "install_failed",
        `The install of ${id} did not finish: ${install?.error?.message ?? `the pack is ${last.state}`}.`,
      );
    }
    return last;
  }

  /**
   * The folder of the active version of a pack: the path that Node reports, or null when it is not installed. When
   * Node cannot be reached, it reads the store directly (packs.json), which needs no Node.
   */
  async activePath(id: string, options: ResolveOptions = {}): Promise<string | null> {
    if (options.version === undefined) {
      try {
        return (await this.node.getPack(id)).path;
      } catch (error) {
        if ((error as { code?: string }).code === "not_found") return null;
        if (!isUnreachable(error)) throw error;
      }
    }
    return (await resolvePack(id, options))?.path ?? null;
  }

  /** The store folder, a move in progress, and the sync warning. */
  async location(): Promise<PackLocation> {
    return this.node.getPackLocation();
  }
}

function isRunning(pack: Pack): boolean {
  const phase = (pack.install as InstallState | null)?.phase;
  return pack.state === "installing" || phase === "downloading" || phase === "verifying" || phase === "activating";
}

function isUnreachable(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ECONNREFUSED" || code === "ETIMEDOUT" || code === "ECONNRESET" || code === "EPIPE";
}

/** Starts Memex.Node when it does not run (ensureNode) and returns its packs client. */
export async function connectPacks(options: EnsureNodeOptions = {}): Promise<PacksClient> {
  return new PacksClient(await ensureNode(options));
}
