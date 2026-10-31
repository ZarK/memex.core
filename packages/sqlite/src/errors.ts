export type SqliteErrorCode =
  /** A migration file changed, or was added before migrations that already ran, or the schema differs from the files. */
  | "SCHEMA_DRIFT"
  /** The database has migrations that this version of the app does not know: a newer version wrote it. */
  | "NEWER_DATABASE"
  /** A migration left rows that break a foreign key. */
  | "MIGRATION_FOREIGN_KEYS"
  /** migrate was called inside a transaction, where foreign keys cannot be turned off. */
  | "MIGRATION_IN_TRANSACTION"
  /** A transaction function returned a promise. Transactions are synchronous. */
  | "ASYNC_TRANSACTION"
  /** The database is closed. */
  | "CLOSED";

export class SqliteError extends Error {
  readonly code: SqliteErrorCode;
  constructor(code: SqliteErrorCode, message: string) {
    super(message);
    this.name = "SqliteError";
    this.code = code;
  }
}

export type JournalErrorCode = "not-found" | "already-undone" | "not-undoable" | "conflict" | "invalid-key";

export class JournalError extends Error {
  readonly code: JournalErrorCode;
  constructor(code: JournalErrorCode, message: string) {
    super(message);
    this.name = "JournalError";
    this.code = code;
  }
}
