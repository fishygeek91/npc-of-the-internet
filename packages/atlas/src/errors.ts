/** Typed Atlas API error with stable machine code and optional HTTP status. */
export class AtlasError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: string,
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
