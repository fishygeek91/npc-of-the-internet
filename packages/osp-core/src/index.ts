export const packageName = "@npc/osp-core";

export * from "./schemas/index.js";

export { SchemaError, VerificationError, EncodingError } from "./errors.js";
export { canonicalize } from "./canonical.js";
export {
  encodeBase64Url,
  decodeBase64Url,
  encodePublicKey,
  decodePublicKey,
  encodeSignature,
  decodeSignature
} from "./encoding/base64url.js";
export { generateKeypair, sign, verify } from "./crypto/ed25519.js";
export type { Ed25519Keypair } from "./crypto/ed25519.js";
export { computeCidFromCanonicalBytes, computeCid } from "./crypto/cid.js";
export { corePayload, soulPayload, signCore, createRecord, verifyRecord } from "./record.js";
export type {
  CreateRecordFields,
  CreateRecordInput,
  CreateRecordResult,
  VerifyRecordOptions,
  VerifyRecordResult
} from "./record.js";
