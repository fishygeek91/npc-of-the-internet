/**
 * Closed Door API `error.code` vocabulary.
 *
 * Spec tables in `spec/door/api.md` plus the codes this package emits that the
 * spec names only by HTTP status (`payload_too_large` for 413, `internal_error`
 * for 500, `not_found` for 404). `message_too_large`, `session_closed`, and
 * `rate_limited` are session-frame codes in the spec with no HTTP status there;
 * the numbers below are the closest rows in the spec's status table (400, 409, 503).
 *
 * Order matches the status switch in {@link defaultHttpStatusForDoorError}.
 */
export const DOOR_ERROR_CODES = [
  "unsupported_version",
  "unsupported_kind",
  "invalid_request",
  "core_invalid",
  "message_too_large",
  "payload_too_large",
  "signature_invalid",
  "session_invalid",
  "timestamp_stale",
  "not_hosting",
  "not_found",
  "epoch_closed",
  "epoch_mismatch",
  "epoch_replay",
  "seq_replay",
  "msg_replay",
  "session_closed",
  "witness_declined",
  "rate_limited",
  "door_unavailable",
  "witness_unavailable",
  "internal_error"
] as const;

/** Machine code for {@link DoorError}. Same union as {@link DOOR_ERROR_CODES}. */
export type DoorErrorCode = (typeof DOOR_ERROR_CODES)[number];

/**
 * True when `code` is a {@link DoorErrorCode}.
 *
 * @param code - Wire or caller-supplied error code.
 */
export function isDoorErrorCode(code: string): code is DoorErrorCode {
  return (DOOR_ERROR_CODES as readonly string[]).includes(code);
}

/** Default HTTP status for a Door API error code per `spec/door/api.md`. */
export function defaultHttpStatusForDoorError(code: DoorErrorCode): number {
  switch (code) {
    case "unsupported_version":
    case "unsupported_kind":
    case "invalid_request":
    case "core_invalid":
    case "message_too_large":
      return 400;
    case "payload_too_large":
      return 413;
    case "signature_invalid":
    case "session_invalid":
    case "timestamp_stale":
      return 401;
    case "not_hosting":
      return 403;
    case "not_found":
      return 404;
    case "epoch_closed":
    case "epoch_mismatch":
    case "epoch_replay":
    case "seq_replay":
    case "msg_replay":
    case "session_closed":
      return 409;
    case "witness_declined":
      return 422;
    case "rate_limited":
    case "door_unavailable":
    case "witness_unavailable":
      return 503;
    case "internal_error":
      return 500;
    default:
      return unexpectedDoorErrorCode(code);
  }
}

/** Typed Door API error with stable machine code and HTTP status. */
export class DoorError extends Error {
  readonly code: DoorErrorCode;
  readonly details?: Record<string, unknown>;
  readonly httpStatus: number;

  constructor(
    code: DoorErrorCode,
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
    code: DoorErrorCode,
    message: string,
    details?: Record<string, unknown>,
    cause?: unknown
  ): DoorError {
    return new DoorError(code, message, defaultHttpStatusForDoorError(code), details, cause);
  }
}

/**
 * Build a {@link DoorError} from a wire `error.code`.
 *
 * Known codes keep that code. An unrecognized string becomes `door_unavailable`
 * (the message and HTTP status are kept) with `details.unrecognized_code` set
 * to the wire value, so a typo is not a known discriminant.
 *
 * @param code - `error.code` from a Door response. Not trusted to be in the union.
 * @param message - `error.message` from that response.
 * @param httpStatus - Transport status. Not recomputed from the code.
 * @param details - Optional `error.details`. Copied; `unrecognized_code` on an
 *   unknown code is overwritten with the wire code.
 */
export function doorErrorFromWire(
  code: string,
  message: string,
  httpStatus: number,
  details?: Record<string, unknown>
): DoorError {
  if (isDoorErrorCode(code)) {
    return new DoorError(code, message, httpStatus, details);
  }
  const merged: Record<string, unknown> = { unrecognized_code: code };
  if (details !== undefined) {
    for (const key of Object.keys(details)) {
      if (key === "unrecognized_code") {
        continue;
      }
      const value = details[key];
      if (value !== undefined) {
        merged[key] = value;
      }
    }
  }
  return new DoorError("door_unavailable", message, httpStatus, merged);
}

/** Serialize a DoorError to the wire error body shape. */
export function doorErrorToBody(err: DoorError): {
  error: { code: DoorErrorCode; message: string; details?: Record<string, unknown> };
} {
  const error: { code: DoorErrorCode; message: string; details?: Record<string, unknown> } = {
    code: err.code,
    message: err.message
  };
  if (err.details !== undefined) {
    error.details = err.details;
  }
  return { error };
}

/** Compile-time exhaustiveness for {@link DoorErrorCode}. */
function unexpectedDoorErrorCode(code: never): never {
  throw new Error(`unhandled DoorError code: ${String(code)}`);
}
