export const packageName = "@npc/door-sdk";

export { Door, DEFAULT_MAX_ISSUED_AT_SKEW_MS } from "./door.js";
export type { DoorOptions, SessionLifecycleEvent } from "./door.js";
export type { HostPolicy } from "./policy.js";
export { ResidencyRecord, DEFAULT_RESIDENCY_RECORD_CHARS } from "./residency-record.js";
export type { ResidencyLine, ResidencyRecordOptions } from "./residency-record.js";
export {
  createAiWitness,
  openAiCompatComplete,
  loadWitnessConfig,
  parseWitnessReply,
  WitnessConfigError
} from "./witness.js";
export { buildWitnessUserPrompt, WITNESS_SYSTEM_PROMPT } from "./prompts/witness.js";
export type {
  AiWitnessOptions,
  CompleteFn,
  MemoryKind,
  OpenAiCompatSettings,
  WitnessConfig,
  WitnessInput,
  WitnessMemory,
  WitnessVerdict
} from "./witness.js";

export {
  DOOR_PROTOCOL_VERSION,
  MEMORY_ATTEST_TEXT_MAX,
  CoreStringSchema,
  CommunityDescriptorSchema,
  CapabilitySchema,
  DoorErrorBodySchema,
  HelloRequestSchema,
  HelloResponseSchema,
  AttestRequestSchema,
  AttestResponseSchema,
  HeartbeatRequestSchema,
  HeartbeatResponseSchema,
  WitnessReasonSchema,
  InboundFrameSchema,
  OutboundFrameSchema,
  OutboundReactionSchema,
  REACTION_EMOJI_MAX_LENGTH,
  ControlFrameSchema,
  ErrorFrameSchema,
  SessionBindParamsSchema
} from "./schemas.js";

export type {
  CommunityDescriptor,
  Capability,
  DoorErrorBody,
  HelloRequest,
  HelloResponse,
  AttestKind,
  AttestRequest,
  AttestResponse,
  HeartbeatRequest,
  HeartbeatResponse,
  WitnessReason,
  InboundFrame,
  OutboundFrame,
  OutboundReaction,
  ControlFrame,
  ErrorFrame,
  SessionBindParams,
  Clock,
  DoorConnection
} from "./schemas.js";

export {
  signingPayload,
  attestSigningPayload,
  heartbeatSigningPayload,
  outboundSigningPayload,
  sessionBindSigningPayload,
  helloResponseSigningPayload,
  attestResponseSigningPayload,
  heartbeatResponseSigningPayload,
  signDoorCosig,
  verifyDoorCosig,
  signCanonical,
  verifyCanonical,
  generateDoorKeypair
} from "./signing.js";

export type { AttestSigningFields } from "./signing.js";

export { DoorError, defaultHttpStatusForDoorError, doorErrorToBody } from "./errors.js";

export { InProcessDoorConnection } from "./transports/in-process.js";
export { HttpDoorServer, MAX_HTTP_BODY_BYTES } from "./transports/http.js";
export type { HttpDoorServerOptions } from "./transports/http.js";
export { HttpDoorConnection } from "./transports/http-client.js";
export type { HttpDoorConnectionOptions } from "./transports/http-client.js";
export { WsDoorSessionServer, WS_SESSION_BIND_FAILED } from "./transports/ws.js";
export type { WsDoorSessionServerOptions } from "./transports/ws.js";
export { WsDoorSessionClient } from "./transports/ws-client.js";
export type {
  WsDoorSessionClientOptions,
  WebSocketFactory,
  WebSocketLike
} from "./transports/ws-client.js";
