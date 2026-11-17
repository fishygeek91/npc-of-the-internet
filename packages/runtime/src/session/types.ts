export {
  DOOR_PROTOCOL_VERSION,
  AttestRequestSchema,
  AttestResponseSchema,
  HeartbeatRequestSchema,
  HeartbeatResponseSchema,
  InboundFrameSchema,
  OutboundFrameSchema,
  attestSigningPayload
} from "@npc/door-sdk";

export type {
  AttestRequest,
  AttestResponse,
  Clock,
  DoorConnection,
  HeartbeatRequest,
  HeartbeatResponse,
  InboundFrame,
  OutboundFrame
} from "@npc/door-sdk";

/** Injectable timer for heartbeat cadence without real sleeps in tests. */
export interface Timer {
  setInterval(handler: () => void, ms: number): unknown;
  clearInterval(id: unknown): void;
}
