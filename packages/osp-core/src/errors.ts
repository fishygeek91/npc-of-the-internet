/** Base class for typed osp-core errors. */
abstract class OspCoreError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Thrown when a value fails schema validation. */
export class SchemaError extends OspCoreError {
  readonly code = "SCHEMA_ERROR";

  constructor(message: string) {
    super(message);
  }
}

/** Thrown when signature or chain verification fails. */
export class VerificationError extends OspCoreError {
  readonly code = "VERIFICATION_ERROR";

  constructor(message: string) {
    super(message);
  }
}

/** Thrown when encoding or decoding fails (base64url, canonical JSON, etc.). */
export class EncodingError extends OspCoreError {
  readonly code = "ENCODING_ERROR";

  constructor(message: string) {
    super(message);
  }
}
