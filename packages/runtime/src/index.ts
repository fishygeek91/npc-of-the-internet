export const packageName = "@npc/runtime";

export type { BrainConfig } from "./brain/config.js";
export { loadBrainConfig } from "./brain/config.js";
export { AnthropicBrain } from "./brain/anthropic-brain.js";
export type { AnthropicBrainOptions, AnthropicMessagesClient } from "./brain/anthropic-brain.js";
export { BrainError } from "./brain/errors.js";
export { FakeBrain } from "./brain/fake-brain.js";
export type { FakeBrainCall, FakeBrainHandler } from "./brain/fake-brain.js";
export type { Brain, BrainMessage, CompleteOptions } from "./brain/types.js";
export { ComposeError } from "./compose/errors.js";
export { composeSelf } from "./compose/compose-self.js";
export type { ComposedSelf, ComposeSelfOptions, MemoryIndexEntry } from "./compose/compose-self.js";
export { generateJournal } from "./journal/generate-journal.js";
export { JournalError } from "./journal/errors.js";
export type { JournalErrorReason } from "./journal/errors.js";
export { writeJournalFile } from "./journal/write-journal-file.js";
export { move } from "./handover/move.js";
export type { MoveOptions, MoveResult } from "./handover/move.js";
export { distillTranscripts } from "./distill/distill-transcripts.js";
export { DistillError } from "./distill/errors.js";
export type { DistillErrorReason } from "./distill/errors.js";
export { FileTranscriptSource } from "./distill/file-transcript-source.js";
export type {
  CandidateShard,
  DistillOptions,
  TranscriptLine,
  TranscriptSource
} from "./distill/types.js";
export type { ScreenCategory } from "@npc/immune";
export type { QuarantineConfig } from "./quarantine/config.js";
export { loadQuarantineConfig } from "./quarantine/config.js";
export { QuarantineError } from "./quarantine/errors.js";
export type { QuarantineErrorReason } from "./quarantine/errors.js";
export { resolveJournalPath } from "./quarantine/resolve-journal-path.js";
export { isCandidateRipe, scanQuarantineState } from "./quarantine/scan.js";
export type { QuarantineCandidate, QuarantineScan } from "./quarantine/scan.js";
export { assignShardIds, shardIdFromText } from "./quarantine/shard-id.js";
export { commitQuarantinedShards } from "./quarantine/commit.js";
export type {
  CommitQuarantineResult,
  CommitQuarantinedShardsOptions
} from "./quarantine/commit.js";
export { flagCandidate } from "./quarantine/flag.js";
export type { FlagCandidateOptions } from "./quarantine/flag.js";
export { KeyringError } from "./keyring/errors.js";
export { buildSessionKeyInfo, SESSION_KEY_DERIVATION_SALT } from "./keyring/derive-session-key.js";
export { loadSoulPrivateKeyFromPath } from "./keyring/load-soul-key.js";
export { SingleKeyKeyring } from "./keyring/single-key-keyring.js";
export type { Keyring, SessionSigner } from "./keyring/types.js";
export { SessionError } from "./session/errors.js";
export { Session } from "./session/session.js";
export type {
  DepartOptions,
  DepartResult,
  HandleInboundResult,
  SessionOptions
} from "./session/session.js";
export {
  AttestRequestSchema,
  AttestResponseSchema,
  CandidateShardSchema,
  CosignRequestSchema,
  CosignResponseSchema,
  DOOR_PROTOCOL_VERSION,
  HeartbeatRequestSchema,
  HeartbeatResponseSchema,
  InboundFrameSchema,
  OutboundFrameSchema,
  cosignCommitSigningPayload,
  cosignReviewSigningPayload
} from "./session/types.js";
export type {
  AttestRequest,
  AttestResponse,
  Clock,
  CosignCandidateShard,
  CosignCommitSigningFields,
  CosignRequest,
  CosignResponse,
  CosignReviewSigningFields,
  DoorConnection,
  HeartbeatRequest,
  HeartbeatResponse,
  InboundFrame,
  OutboundFrame,
  ReviewDecision,
  Timer
} from "./session/types.js";
