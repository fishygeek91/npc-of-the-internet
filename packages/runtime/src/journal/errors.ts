export type JournalErrorReason = "empty_output" | "invalid_identifier" | "write_failed";

/** Thrown when journal generation or persistence cannot complete. */
export class JournalError extends Error {
  readonly code = "JOURNAL_ERROR";
  readonly reason: JournalErrorReason;

  constructor(message: string, reason: JournalErrorReason) {
    super(message);
    this.name = "JournalError";
    this.reason = reason;
  }
}
