export const packageName = "@npc/osp-core";

export * from "./schemas/index.js";

export {
  SchemaError,
  VerificationError,
  VERIFICATION_REASONS,
  EncodingError,
  StorageError,
  CorruptionError,
  ConcurrentAppendError,
  ChainMismatchError
} from "./errors.js";
export type { VerificationReason } from "./errors.js";
export { SHARD_TEXT_MAX_CODE_POINTS, countCodePoints } from "./shard-bounds.js";
export type {
  HeadInfo,
  AppendResult,
  PutSideBlobResult,
  FileSoulStoreOpenOptions,
  IpfsSoulStoreOpenOptions,
  DualSoulStoreOpenOptions,
  SoulStore
} from "./store/index.js";
export { FileSoulStore, IpfsSoulStore, DualSoulStore } from "./store/index.js";
export {
  enqueueReplication,
  ackReplication,
  readReplicationJournal,
  recoverReplicationJournal,
  listPendingReplication,
  listUnackedForTarget,
  replicationJournalPath,
  ReplicationKindSchema,
  ReplicationEnqueueEntrySchema,
  ReplicationAckEntrySchema,
  type ReplicationKind,
  type ReplicationEnqueueEntry,
  type ReplicationAckEntry,
  type ReplicationJournalEnqueueLine,
  type ReplicationJournalAckLine,
  type ReplicationJournalEntry
} from "./replication/index.js";
export { canonicalize } from "./canonical.js";
export {
  encodeBase64Url,
  decodeBase64Url,
  asBase64Url,
  isBase64Url,
  encodePublicKey,
  decodePublicKey,
  asSoulPublicKey,
  isSoulPublicKey,
  SoulPublicKeySchema,
  encodeSignature,
  decodeSignature,
  asEd25519Signature,
  isEd25519Signature,
  Ed25519SignatureSchema
} from "./encoding/base64url.js";
export type { Base64Url, SoulPublicKey, Ed25519Signature } from "./encoding/base64url.js";
export { parsePrivateKeyBytes, PrivateKeyParseError } from "./encoding/private-key.js";
export type { PrivateKeyParseFailure } from "./encoding/private-key.js";
export { generateKeypair, publicKeyFromPrivate, sign, verify } from "./crypto/ed25519.js";
export type { Ed25519Keypair } from "./crypto/ed25519.js";
export {
  CID_RE,
  CidSchema,
  computeCidFromCanonicalBytes,
  computeCid,
  isValidCid,
  asCid,
  parseCid
} from "./crypto/cid.js";
export type { Cid } from "./crypto/cid.js";
export {
  corePayload,
  soulPayload,
  signCore,
  createRecord,
  createRecordWithSigner,
  verifyRecord
} from "./record.js";
export type {
  CreateRecordFields,
  CreateRecordInput,
  CreateRecordResult,
  SoulSigner,
  VerifyRecordOptions,
  VerifyRecordResult
} from "./record.js";
export {
  encodeMemoryTextBlob,
  decodeMemoryTextBlob,
  encodeShardTextBlob,
  decodeShardTextBlob,
  encodeJournalBlob,
  decodeJournalBlob,
  hashBlobBytes,
  cidMatchesHash,
  assertCidMatchesHash,
  contentAddressSideBlob
} from "./memory-blob.js";
export { eraseSideBlob } from "./erase-side-blob.js";
export type {
  TombstoneReason,
  EraseSideBlobOptions,
  EraseSideBlobResult
} from "./erase-side-blob.js";
export { migrateChainToV02 } from "./migrate-to-v02.js";
export type { MigrateChainToV02Options, MigrateChainToV02Result } from "./migrate-to-v02.js";
export {
  parseDoorPublicKeyBinding,
  parseDoorPublicKeyMap,
  parseDoorPrivateKeyBinding,
  parseDoorPrivateKeyMap,
  hasDoorPublicKeys
} from "./door-keys.js";
export { verifyRecords, verifyChain } from "./verify-chain.js";
export type {
  ChainRule,
  ChainFailure,
  VerifyChainResult,
  VerifyChainOptions
} from "./verify-chain.js";
export {
  OSP_PIN_MANIFEST_VERSION,
  buildUnsignedPinManifest,
  encodeUnsignedPinManifest,
  encodePinManifest,
  decodePinManifest,
  signPinManifest,
  verifyPinManifest,
  computeManifestCid,
  computeManifestCidFromBytes,
  listRecordCidsFromIpfsDir,
  buildAndSignPinManifestForIpfsDir,
  type UnsignedPinManifest,
  type PinManifest,
  type BuildUnsignedPinManifestInput,
  type BuildPinManifestForIpfsDirOptions
} from "./manifest/index.js";
export {
  exportSoulchainCar,
  importSoulchainCar,
  type ExportSoulchainCarInput,
  type ImportSoulchainCarInput,
  type ImportSoulchainCarResult
} from "./car/index.js";
