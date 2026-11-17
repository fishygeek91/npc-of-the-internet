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

/** Log fields for a {@link BrainError}: discriminant and numeric HTTP status only. */
export type BrainErrorLogFields = {
  reason: BrainErrorReason;
  status?: number;
};

/**
 * Fields safe to log for a Brain failure.
 *
 * Reads a numeric `status` from `cause` when one is present. Headers, request
 * parameters, and response bodies are never copied.
 *
 * @param error - Failure from a Brain implementation.
 * @returns `reason`, plus `status` when `cause.status` is a finite number.
 */
export function brainErrorLogFields(error: BrainError): BrainErrorLogFields {
  const status = numericCauseStatus(error.cause);
  if (status === undefined) {
    return { reason: error.reason };
  }
  return { reason: error.reason, status };
}

/** Pull a finite numeric HTTP status off a cause object. Everything else is ignored. */
function numericCauseStatus(cause: unknown): number | undefined {
  if (typeof cause !== "object" || cause === null || !("status" in cause)) {
    return undefined;
  }
  const status = cause.status;
  if (typeof status !== "number" || !Number.isFinite(status)) {
    return undefined;
  }
  return status;
}
