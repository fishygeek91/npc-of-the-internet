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
export { distillTranscripts } from "./distill/distill-transcripts.js";
export { DistillError } from "./distill/errors.js";
export type { DistillErrorReason } from "./distill/errors.js";
export { FileTranscriptSource } from "./distill/file-transcript-source.js";
export type {
  CandidateShard,
  DistillOptions,
  PiiCategory,
  TranscriptLine,
  TranscriptSource
} from "./distill/types.js";
export { KeyringError } from "./keyring/errors.js";
export { buildSessionKeyInfo, SESSION_KEY_DERIVATION_SALT } from "./keyring/derive-session-key.js";
export { loadSoulPrivateKeyFromPath } from "./keyring/load-soul-key.js";
export { SingleKeyKeyring } from "./keyring/single-key-keyring.js";
export type { Keyring, SessionSigner } from "./keyring/types.js";
export { SessionError } from "./session/errors.js";
export { Session } from "./session/session.js";
export type { HandleInboundResult, SessionOptions } from "./session/session.js";
export {
  AttestRequestSchema,
  AttestResponseSchema,
  DOOR_PROTOCOL_VERSION,
  HeartbeatRequestSchema,
  HeartbeatResponseSchema,
  InboundFrameSchema,
  OutboundFrameSchema
} from "./session/types.js";
export type {
  AttestRequest,
  AttestResponse,
  Clock,
  DoorConnection,
  HeartbeatRequest,
  HeartbeatResponse,
  InboundFrame,
  OutboundFrame,
  Timer
} from "./session/types.js";
