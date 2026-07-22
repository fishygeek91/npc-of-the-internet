export const packageName = "@npc/door-sdk";

export { Door } from "./door.js";
export type { DoorOptions } from "./door.js";
export type { HostPolicy } from "./policy.js";

export {
  DOOR_PROTOCOL_VERSION,
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
  CandidateShardSchema,
  CosignRequestSchema,
  CosignResponseSchema,
  InboundFrameSchema,
  OutboundFrameSchema,
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
  AttestRequest,
  AttestResponse,
  HeartbeatRequest,
  HeartbeatResponse,
  CandidateShard,
  CosignCandidateShard,
  CosignRequest,
  CosignResponse,
  ReviewDecision,
  InboundFrame,
  OutboundFrame,
  ControlFrame,
  ErrorFrame,
  SessionBindParams,
  Clock,
  DoorConnection
} from "./schemas.js";

export {
  signingPayload,
  attestSigningPayload,
  cosignReviewSigningPayload,
  cosignCommitSigningPayload,
  heartbeatSigningPayload,
  outboundSigningPayload,
  sessionBindSigningPayload,
  helloResponseSigningPayload,
  signDoorCosig,
  verifyDoorCosig,
  signCanonical,
  verifyCanonical,
  generateDoorKeypair
} from "./signing.js";

export type {
  AttestSigningFields,
  CosignReviewSigningFields,
  CosignCommitSigningFields
} from "./signing.js";

export { DoorError, defaultHttpStatusForDoorError, doorErrorToBody } from "./errors.js";

export { InProcessDoorConnection } from "./transports/in-process.js";
export { HttpDoorServer } from "./transports/http.js";
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
