export const packageName = "@npc/osp-core";

export * from "./schemas/index.js";

export {
  SchemaError,
  VerificationError,
  EncodingError,
  StorageError,
  CorruptionError,
  ConcurrentAppendError,
  ChainMismatchError
} from "./errors.js";
export type { HeadInfo, AppendResult, FileSoulStoreOpenOptions, SoulStore } from "./store/index.js";
export { FileSoulStore } from "./store/index.js";
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
export {
  CID_RE,
  CidSchema,
  computeCidFromCanonicalBytes,
  computeCid,
  isValidCid
} from "./crypto/cid.js";
export { corePayload, soulPayload, signCore, createRecord, verifyRecord } from "./record.js";
export type {
  CreateRecordFields,
  CreateRecordInput,
  CreateRecordResult,
  VerifyRecordOptions,
  VerifyRecordResult
} from "./record.js";
export { verifyRecords, verifyChain } from "./verify-chain.js";
export type {
  ChainRule,
  ChainFailure,
  VerifyChainResult,
  VerifyChainOptions
} from "./verify-chain.js";
