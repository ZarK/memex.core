export type FolderListingErrorCode = "relative-path" | "missing" | "not-a-folder" | "helper-failed" | "invalid-journal";

/** A listing that cannot start or go on. The message says what is wrong and what to do. */
export class FolderListingError extends Error {
  readonly code: FolderListingErrorCode;

  constructor(code: FolderListingErrorCode, message: string) {
    super(message);
    this.name = "FolderListingError";
    this.code = code;
  }
}
