import { canonicalize, decodePublicKey, decodeSignature } from "@npc/osp-core";
import { z } from "zod";

/** Door API protocol version for v0.1 wire messages. */
export const DOOR_PROTOCOL_VERSION = "door/0.1" as const;

const ProtocolVersionSchema = z.literal(DOOR_PROTOCOL_VERSION);

const DoorIdSchema = z.string().min(1);

const EpochSchema = z.number().int().positive();

const IsoTimestampSchema = z.string().min(1);

const PublicKeyStringSchema = z.string().superRefine((value, ctx) => {
  try {
    decodePublicKey(value);
  } catch (error) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: error instanceof Error ? error.message : "invalid public key"
    });
  }
});

const SignatureStringSchema = z.string().superRefine((value, ctx) => {
  try {
    decodeSignature(value);
  } catch (error) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: error instanceof Error ? error.message : "invalid signature"
    });
  }
});

const AttestKindSchema = z.enum(["arrival", "departure", "heartbeat"]);

/** Injectable clock returning ISO 8601 UTC timestamps with millisecond precision. */
export interface Clock {
  now(): string;
}

/** Injectable timer for heartbeat cadence without real sleeps in tests. */
export interface Timer {
  setInterval(handler: () => void, ms: number): unknown;
  clearInterval(id: unknown): void;
}

/** `POST /door/attest` request body. */
export const AttestRequestSchema = z.object({
  protocol_version: ProtocolVersionSchema,
  door_id: DoorIdSchema,
  epoch: EpochSchema,
  kind: AttestKindSchema,
  core: z.string().min(1),
  session_pubkey: PublicKeyStringSchema,
  issued_at: IsoTimestampSchema,
  sig: SignatureStringSchema
});

export type AttestRequest = z.infer<typeof AttestRequestSchema>;

/** Fields covered by `/door/attest` request `sig` (excludes `protocol_version`). */
export type AttestSigningFields = {
  door_id: string;
  epoch: number;
  kind: AttestRequest["kind"];
  core: string;
  session_pubkey: string;
  issued_at: string;
};

/** Canonical bytes for `/door/attest` request signatures per `spec/door/api.md`. */
export function attestSigningPayload(request: Omit<AttestRequest, "sig">): Uint8Array {
  const fields: AttestSigningFields = {
    door_id: request.door_id,
    epoch: request.epoch,
    kind: request.kind,
    core: request.core,
    session_pubkey: request.session_pubkey,
    issued_at: request.issued_at
  };
  return canonicalize(fields);
}

/** `POST /door/attest` success response. */
export const AttestResponseSchema = z.object({
  door_id: DoorIdSchema,
  epoch: EpochSchema,
  kind: AttestKindSchema,
  door_cosig: SignatureStringSchema,
  received_at: IsoTimestampSchema,
  door_sig: SignatureStringSchema
});

export type AttestResponse = z.infer<typeof AttestResponseSchema>;

/** `POST /door/heartbeat` request body. */
export const HeartbeatRequestSchema = z.object({
  protocol_version: ProtocolVersionSchema,
  door_id: DoorIdSchema,
  epoch: EpochSchema,
  session_pubkey: PublicKeyStringSchema,
  seq: z.number().int().positive(),
  issued_at: IsoTimestampSchema,
  sig: SignatureStringSchema
});

export type HeartbeatRequest = z.infer<typeof HeartbeatRequestSchema>;

/** `POST /door/heartbeat` success response. */
export const HeartbeatResponseSchema = z.object({
  door_id: DoorIdSchema,
  epoch: EpochSchema,
  seq: z.number().int().positive(),
  accepted: z.boolean(),
  received_at: IsoTimestampSchema,
  door_sig: SignatureStringSchema
});

export type HeartbeatResponse = z.infer<typeof HeartbeatResponseSchema>;

const InboundFrameBodySchema = z.object({
  text: z.string().min(1).max(4000),
  author_id: z.string().min(1),
  author_display: z.string().optional(),
  reply_to: z.string().optional(),
  channel_id: z.string().optional()
});

/** WebSocket `inbound` frame (Door → Wanderer). */
export const InboundFrameSchema = z.object({
  type: z.literal("inbound"),
  door_id: DoorIdSchema,
  epoch: EpochSchema,
  msg_id: z.string().min(1),
  issued_at: IsoTimestampSchema,
  body: InboundFrameBodySchema
});

export type InboundFrame = z.infer<typeof InboundFrameSchema>;

const OutboundFrameBodySchema = z.object({
  text: z.string().min(1).max(4000),
  reply_to: z.string().optional(),
  channel_id: z.string().optional()
});

/** WebSocket `outbound` frame (Wanderer → Door), session-key signed. */
export const OutboundFrameSchema = z.object({
  type: z.literal("outbound"),
  door_id: DoorIdSchema,
  epoch: EpochSchema,
  msg_id: z.string().min(1),
  issued_at: IsoTimestampSchema,
  body: OutboundFrameBodySchema,
  sig: SignatureStringSchema
});

export type OutboundFrame = z.infer<typeof OutboundFrameSchema>;

/**
 * Door transport surface used by Session (attest + heartbeat in v0.1).
 * Implemented by network adapters and in-process `DoorStub` in tests.
 */
export interface DoorConnection {
  attest(request: AttestRequest): Promise<AttestResponse>;
  heartbeat(request: HeartbeatRequest): Promise<HeartbeatResponse>;
}
