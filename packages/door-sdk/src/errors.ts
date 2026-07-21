/** Default HTTP status for a Door API error code per `spec/door/api.md`. */
export function defaultHttpStatusForDoorError(code: string): number {
  switch (code) {
    case "signature_invalid":
    case "session_invalid":
      return 401;
    case "epoch_closed":
    case "epoch_mismatch":
    case "seq_replay":
      return 409;
    case "shard_not_approved":
    case "not_hosting":
      return 403;
    case "shard_count":
    case "shard_invalid":
      return 422;
    case "invalid_request":
    case "core_invalid":
      return 400;
    case "review_pending":
    case "door_unavailable":
      return 503;
    default:
      if (code.startsWith("unsupported_")) {
        return 400;
      }
      return 500;
  }
}

/** Typed Door API error with stable machine code and HTTP status. */
export class DoorError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;
  readonly httpStatus: number;

  constructor(
    code: string,
    message: string,
    httpStatus: number,
    details?: Record<string, unknown>,
    cause?: unknown
  ) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "DoorError";
    this.code = code;
    this.httpStatus = httpStatus;
    if (details !== undefined) {
      this.details = details;
    }
  }

  /** Create a DoorError using the default HTTP status for `code`. */
  static fromCode(
    code: string,
    message: string,
    details?: Record<string, unknown>,
    cause?: unknown
  ): DoorError {
    return new DoorError(code, message, defaultHttpStatusForDoorError(code), details, cause);
  }
}

/** Serialize a DoorError to the wire error body shape. */
export function doorErrorToBody(err: DoorError): {
  error: { code: string; message: string; details?: Record<string, unknown> };
} {
  const error: { code: string; message: string; details?: Record<string, unknown> } = {
    code: err.code,
    message: err.message
  };
  if (err.details !== undefined) {
    error.details = err.details;
  }
  return { error };
}
