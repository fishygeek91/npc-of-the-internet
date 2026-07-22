export type QuarantineErrorReason =
  | "invalid_config"
  | "invalid_cid"
  | "invalid_timestamp"
  | "invalid_record"
  | "duplicate_shard_text"
  | "candidate_not_found"
  | "already_committed"
  | "commit_failed"
  | "flag_failed";

/** Thrown when quarantine configuration, scanning, or lifecycle operations fail. */
export class QuarantineError extends Error {
  readonly code = "QUARANTINE_ERROR";
  readonly reason: QuarantineErrorReason;

  constructor(message: string, reason: QuarantineErrorReason) {
    super(message);
    this.name = "QuarantineError";
    this.reason = reason;
  }
}
