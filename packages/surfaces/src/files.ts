import { createHash, randomBytes } from "node:crypto";

/** What POST /api/v1/uploads returns under "upload". */
export interface UploadInfo {
  id: string;
  sha256: string;
  bytes: number;
  mediaType: string;
  expiresAt: string;
}

/** What a capability returns for a file it made. The client gets the bytes from url with its token. */
export interface FileRef {
  url: string;
  mediaType: string;
  bytes: number;
  sha256: string;
}

export interface StoredFile {
  data: Buffer;
  mediaType: string;
  sha256: string;
  expires: number;
}

/** One hour: how long an upload waits for its capability, and the least time a made file stays available. */
export const FILE_TTL_MS = 60 * 60 * 1000;

/**
 * Uploads and made files of one running app, in memory. Files go by bytes, never by path (contracts/surfaces.md, Files).
 * An upload is removed when the capability that used it ends, or after the TTL.
 */
export class FileStore {
  private readonly uploads = new Map<string, StoredFile>();
  private readonly files = new Map<string, StoredFile>();
  private readonly ttl: number;
  private readonly now: () => number;

  constructor(options: { ttlMs?: number; now?: () => number } = {}) {
    this.ttl = options.ttlMs ?? FILE_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  private store(map: Map<string, StoredFile>, prefix: string, data: Buffer, mediaType: string): [string, StoredFile] {
    this.sweep();
    const id = `${prefix}_${randomBytes(16).toString("base64url")}`;
    const file = { data, mediaType, sha256: createHash("sha256").update(data).digest("hex"), expires: this.now() + this.ttl };
    map.set(id, file);
    return [id, file];
  }

  addUpload(data: Buffer, mediaType: string): UploadInfo {
    const [id, file] = this.store(this.uploads, "up", data, mediaType);
    return { id, sha256: file.sha256, bytes: data.length, mediaType, expiresAt: new Date(file.expires).toISOString() };
  }

  getUpload(id: string): StoredFile | undefined {
    this.sweep();
    return this.uploads.get(id);
  }

  removeUpload(id: string): void {
    this.uploads.delete(id);
  }

  addFile(data: Buffer, mediaType: string): FileRef {
    const [id, file] = this.store(this.files, "f", data, mediaType);
    return { url: `/api/v1/files/${id}`, mediaType, bytes: data.length, sha256: file.sha256 };
  }

  getFile(id: string): StoredFile | undefined {
    this.sweep();
    return this.files.get(id);
  }

  /** Removes what has expired. */
  sweep(): void {
    const now = this.now();
    for (const map of [this.uploads, this.files]) {
      for (const [id, file] of map) if (file.expires <= now) map.delete(id);
    }
  }
}
