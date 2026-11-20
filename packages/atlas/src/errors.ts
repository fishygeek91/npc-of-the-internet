/**
 * Closed Atlas API `error.code` vocabulary.
 * Order follows the HTTP status used at each throw site (400, 404, 500, 503).
 */
export const ATLAS_ERROR_CODES = [
  "invalid_request",
  "invalid_type",
  "chain_empty",
  "car_not_found",
  "manifest_not_found",
  "export_after_unknown",
  "invalid_config",
  "internal_error",
  "chain_unreadable"
] as const;

/** Machine code for {@link AtlasError}. Same union as {@link ATLAS_ERROR_CODES}. */
export type AtlasErrorCode = (typeof ATLAS_ERROR_CODES)[number];

/** Typed Atlas API error with stable machine code and optional HTTP status. */
export class AtlasError extends Error {
  readonly code: AtlasErrorCode;
  readonly statusCode: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: AtlasErrorCode,
    message: string,
    statusCode = 500,
    details?: Record<string, unknown>,
    cause?: unknown
  ) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "AtlasError";
    this.code = code;
    this.statusCode = statusCode;
    if (details !== undefined) {
      this.details = details;
    }
  }
}

/** Serialize an AtlasError to the wire error body shape (matches Door API). */
export function atlasErrorToBody(err: AtlasError): {
  error: { code: AtlasErrorCode; message: string; details?: Record<string, unknown> };
} {
  const error: { code: AtlasErrorCode; message: string; details?: Record<string, unknown> } = {
    code: err.code,
    message: err.message
  };
  if (err.details !== undefined) {
    error.details = err.details;
  }
  return { error };
}
