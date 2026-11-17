import type { ChainFailure } from "./chain-types.js";

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

/**
 * Why {@link VerificationError} was thrown.
 *
 * `soul_sig`, `cosigner`, `missing_door_keys`, and `cid_mismatch` come from
 * {@link verifyRecord}. Chain verification maps the first three onto
 * `ChainRule`s and rethrows `cid_mismatch` (it is not a chain rule).
 * `pin_manifest_sig` is a pin-manifest soul signature. `append_rejected` is an
 * append candidate that failed a non-structural chain rule.
 */
export const VERIFICATION_REASONS = [
  "soul_sig",
  "cosigner",
  "missing_door_keys",
  "cid_mismatch",
  "pin_manifest_sig",
  "append_rejected"
] as const;

/** Discriminant for {@link VerificationError}. */
export type VerificationReason = (typeof VERIFICATION_REASONS)[number];

/** Thrown when signature or chain verification fails. */
export class VerificationError extends OspCoreError {
  readonly code = "VERIFICATION_ERROR";
  readonly reason: VerificationReason;

  /**
   * @param message - Human-readable failure. Callers that surface it (chain
   *   failure text, CLI) keep this string; classification uses `reason`.
   * @param reason - Closed discriminant. See {@link VERIFICATION_REASONS}.
   */
  constructor(message: string, reason: VerificationReason) {
    super(message);
    this.reason = reason;
  }
}

/** Thrown when encoding or decoding fails (base64url, canonical JSON, etc.). */
export class EncodingError extends OspCoreError {
  readonly code = "ENCODING_ERROR";

  constructor(message: string) {
    super(message);
  }
}

/** Thrown on general I/O or store failures. */
export class StorageError extends OspCoreError {
  readonly code = "STORAGE_ERROR";

  constructor(message: string) {
    super(message);
  }
}

/** Thrown when stored data is torn, CID-mismatched, or the chain is invalid on open. */
export class CorruptionError extends OspCoreError {
  readonly code = "CORRUPTION_ERROR";
  readonly failures?: readonly ChainFailure[];

  constructor(message: string, options?: { failures?: readonly ChainFailure[] }) {
    super(message);
    if (options?.failures !== undefined) {
      this.failures = options.failures;
    }
  }
}

/** Thrown when an append fails due to lock contention. */
export class ConcurrentAppendError extends OspCoreError {
  readonly code = "CONCURRENT_APPEND_ERROR";

  constructor(message: string) {
    super(message);
  }
}

/** Thrown when a record's prev/seq does not match the current head. */
export class ChainMismatchError extends OspCoreError {
  readonly code = "CHAIN_MISMATCH_ERROR";

  constructor(message: string) {
    super(message);
  }
}
