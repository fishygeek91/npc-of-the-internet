/**
 * Browser-safe soulchain verification entry (`@npc/osp-core/browser`).
 *
 * Porch pages and replica shrines import this module, not the package root.
 * The root loads `SoulStore` (`node:fs` and other Node built-ins). This
 * module's runtime import graph is limited to canonical JSON, CIDs, Ed25519
 * verify, and `verifyRecords` / `verifyRecord`.
 *
 * Normative contract: `spec/door/web.md`. Chain rules: `spec/osp/records.md`.
 * Signing and hashing stay on `@noble/ed25519`, `@noble/hashes`, and
 * `multiformats` (browser sha2-256). `verify` is strict RFC 8032.
 *
 * Not exported here: `SoulStore`, replication, pin manifests, CAR, key
 * generation, and `sign` / `createRecord`. `verifyChain` needs a store.
 */

export { canonicalize } from "./canonical.js";

export { verify } from "./crypto/ed25519.js";
export {
  CID_RE,
  CidSchema,
  asCid,
  computeCid,
  computeCidFromCanonicalBytes,
  isValidCid,
  parseCid
} from "./crypto/cid.js";
export type { Cid } from "./crypto/cid.js";

export {
  decodeBase64Url,
  decodePublicKey,
  decodeSignature,
  encodeBase64Url
} from "./encoding/base64url.js";
export type { Base64Url, Ed25519Signature, SoulPublicKey } from "./encoding/base64url.js";

export { EncodingError, SchemaError, VERIFICATION_REASONS, VerificationError } from "./errors.js";
export type { VerificationReason } from "./errors.js";

export { corePayload, soulPayload, verifyRecord } from "./record.js";
export type { VerifyRecordOptions, VerifyRecordResult } from "./record.js";

export { verifyRecords } from "./verify-chain.js";
export type {
  ChainFailure,
  ChainRule,
  VerifyChainOptions,
  VerifyChainResult
} from "./verify-chain.js";

export { OSP_SPEC_V01, OSP_SPEC_V02, RecordSchema, parseResidency } from "./schemas/index.js";
export type { OspRecord } from "./schemas/index.js";

export {
  cidMatchesHash,
  decodeJournalBlob,
  decodeMemoryTextBlob,
  hashBlobBytes
} from "./memory-blob.js";
