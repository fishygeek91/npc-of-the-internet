/** Discriminant for {@link BrainError} (config vs provider HTTP classes). */
export type BrainErrorReason =
  | "invalid_config"
  | "auth"
  | "credit_exhausted"
  | "rate_limited"
  | "unavailable"
  | "timeout"
  | "invalid_request"
  | "provider";

/** Thrown when Brain configuration or completion fails. */
export class BrainError extends Error {
  readonly reason: BrainErrorReason;
  readonly cause?: unknown;
  /** Set when a specific environment variable caused a config failure. */
  readonly envVar?: string;

  constructor(
    message: string,
    reason: BrainErrorReason,
    options?: { cause?: unknown; envVar?: string }
  ) {
    super(message);
    this.name = "BrainError";
    this.reason = reason;
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
    if (options?.envVar !== undefined) {
      this.envVar = options.envVar;
    }
  }
}
