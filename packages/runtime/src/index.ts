export const packageName = "@npc/runtime";

export type { DaemonConfig } from "./daemon-config.js";
export { loadDaemonConfig } from "./daemon-config.js";
export { DaemonError } from "./daemon-errors.js";
export type { DaemonErrorReason } from "./daemon-errors.js";
export type { ResidencyDaemonDeps, ResidencyDaemonHandle } from "./daemon.js";
export { startResidencyDaemon } from "./daemon.js";
export type { ResidencyConfig } from "./residency/config.js";
export {
  DEFAULT_CONTROL_DIR,
  DEFAULT_JOURNAL_DIR,
  DEFAULT_MAX_RESIDENCY_MS,
  loadResidencyConfig,
  MIN_RESIDENCY_MAX_MS
} from "./residency/config.js";
export type {
  AbortableSleep,
  CycleOutcome,
  CycleTrigger,
  DepartRequest,
  LiveResidency,
  ResidencyControllerOptions
} from "./residency/controller.js";
export { abortableSleep, chooseNextDoor, ResidencyController } from "./residency/controller.js";
export type { AvailableDoor, DoorEndpoint, ProbeDoorsOptions } from "./residency/doors.js";
export { doorEndpoint, probeDoors, verifyDoorHello } from "./residency/doors.js";
export type {
  ControlDirWatcher,
  RequestDaemonDepartOptions,
  WatchControlDirOptions
} from "./residency/control-dir.js";
export {
  consumeDepartRequest,
  DEPART_REQUEST_FILE,
  requestDaemonDepart,
  watchControlDir,
  writeDepartRequest
} from "./residency/control-dir.js";

export type {
  BrainConfig,
  AnthropicBrainConfig,
  OpenAICompatBrainConfig,
  FakeBrainConfig
} from "./brain/config.js";
export { loadBrainConfig, isOpenRouterBaseUrl } from "./brain/config.js";
export { AnthropicBrain } from "./brain/anthropic-brain.js";
export type { AnthropicBrainOptions, AnthropicMessagesClient } from "./brain/anthropic-brain.js";
export { OpenAICompatBrain } from "./brain/openai-compat-brain.js";
export type { OpenAICompatBrainOptions, SleepFn, RandomFn } from "./brain/openai-compat-brain.js";
export { createBrain } from "./brain/create-brain.js";
export { BrainError } from "./brain/errors.js";
export type { BrainErrorReason } from "./brain/errors.js";
export { FakeBrain } from "./brain/fake-brain.js";
export type { FakeBrainCall, FakeBrainHandler, FakeBrainOptions } from "./brain/fake-brain.js";
export type {
  Brain,
  BrainMessage,
  BrainResult,
  BrainUsage,
  CompleteOptions
} from "./brain/types.js";
export { ZERO_BRAIN_USAGE } from "./brain/types.js";
export { ComposeError } from "./compose/errors.js";
export { composeSelf } from "./compose/compose-self.js";
export type { ComposedSelf, ComposeSelfOptions, MemoryIndexEntry } from "./compose/compose-self.js";
export { RUNTIME_OSP_SPEC, SpecCutoverError, assertRuntimeWritableChain } from "./osp-spec.js";
export { generateJournal } from "./journal/generate-journal.js";
export { JournalError } from "./journal/errors.js";
export type { JournalErrorReason } from "./journal/errors.js";
export { writeJournalFile } from "./journal/write-journal-file.js";
export { distillTranscripts } from "./distill/distill-transcripts.js";
export { DistillError } from "./distill/errors.js";
export type { DistillErrorReason } from "./distill/errors.js";
export { FileTranscriptSource } from "./distill/file-transcript-source.js";
export { MemoryTranscriptSource } from "./distill/memory-transcript-source.js";
export type {
  CandidateShard,
  DistillOptions,
  TranscriptLine,
  TranscriptSource
} from "./distill/types.js";
export type { ScreenCategory } from "@npc/immune";
export { KeyringError } from "./keyring/errors.js";
export { buildSessionKeyInfo, SESSION_KEY_DERIVATION_SALT } from "./keyring/derive-session-key.js";
export { loadSoulPrivateKeyFromPath } from "./keyring/load-soul-key.js";
export { SingleKeyKeyring } from "./keyring/single-key-keyring.js";
export type { Keyring, SessionSigner } from "./keyring/types.js";
export { SessionError } from "./session/errors.js";
export { DEFAULT_MIN_MEMORY_LINES, Session } from "./session/session.js";
export type {
  DepartOptions,
  DepartResult,
  HandleInboundResult,
  HeartbeatErrorStage,
  ObserveResult,
  SessionOptions
} from "./session/session.js";
export {
  DEFAULT_ATTENTION_POLICY,
  isAddressed,
  parseAttentionDecision,
  resolveAttention
} from "./attention/decision.js";
export type {
  AttentionNote,
  AttentionPolicy,
  RawAttentionDecision,
  ResolvedAttention
} from "./attention/decision.js";
export { RoomLog, sanitizeDisplay } from "./attention/room-log.js";
export type { RoomEntry, RoomSpeaker } from "./attention/room-log.js";
export {
  ResidencyTranscript,
  DEFAULT_TRANSCRIPT_MAX_CHARS,
  DEFAULT_TRANSCRIPT_MAX_LINES
} from "./distill/residency-transcript.js";
export type { ResidencyTranscriptOptions } from "./distill/residency-transcript.js";
export {
  AttestRequestSchema,
  AttestResponseSchema,
  DOOR_PROTOCOL_VERSION,
  HeartbeatRequestSchema,
  HeartbeatResponseSchema,
  InboundFrameSchema,
  OutboundFrameSchema,
  attestSigningPayload
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
