export {
  DOOR_PROTOCOL_VERSION,
  AttestRequestSchema,
  AttestResponseSchema,
  HeartbeatRequestSchema,
  HeartbeatResponseSchema,
  CandidateShardSchema,
  CosignRequestSchema,
  CosignResponseSchema,
  InboundFrameSchema,
  OutboundFrameSchema,
  attestSigningPayload,
  cosignReviewSigningPayload,
  cosignCommitSigningPayload
} from "@npc/door-sdk";

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
  ReviewDecision
} from "@npc/door-sdk";

/** Injectable timer for heartbeat cadence without real sleeps in tests. */
export interface Timer {
  setInterval(handler: () => void, ms: number): unknown;
  clearInterval(id: unknown): void;
}
