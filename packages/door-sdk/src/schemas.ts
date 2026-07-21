import { decodePublicKey, decodeSignature } from "@npc/osp-core";
import { z } from "zod";

/** Door API protocol version for v0.1 wire messages. */
export const DOOR_PROTOCOL_VERSION = "door/0.1" as const;

const ProtocolVersionSchema = z.literal(DOOR_PROTOCOL_VERSION);

const DoorIdSchema = z
  .string()
  .min(1)
  .refine((value) => !value.startsWith("door:"), {
    message: "door_id must not start with 'door:' prefix"
  });

const EpochSchema = z.number().int().positive();

const IsoTimestampSchema = z.string().min(1);

/** UTF-8 OSP envelope core string (max 64 KiB). */
export const CoreStringSchema = z.string().min(1).max(65536);

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

/** Describes the hosted community for Navigator / operator display. */
export const CommunityDescriptorSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1).max(2000),
  platform: z.string().min(1),
  rules_url: z.string().min(1).optional(),
  invitation_required: z.boolean()
});

export type CommunityDescriptor = z.infer<typeof CommunityDescriptorSchema>;

/** Machine-readable feature flags the Door supports. */
export const CapabilitySchema = z.enum([
  "session.text",
  "session.threads",
  "heartbeat",
  "attest",
  "cosign.manual",
  "cosign.auto"
]);

export type Capability = z.infer<typeof CapabilitySchema>;

const DoorErrorObjectSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  details: z.record(z.unknown()).optional()
});

/** HTTP / WebSocket error body shape. */
export const DoorErrorBodySchema = z.object({
  error: DoorErrorObjectSchema
});

export type DoorErrorBody = z.infer<typeof DoorErrorBodySchema>;

/** `POST /door/hello` request body. */
export const HelloRequestSchema = z.object({
  protocol_version: ProtocolVersionSchema,
  soul_pubkey: PublicKeyStringSchema,
  client: z.string().min(1).optional()
});

export type HelloRequest = z.infer<typeof HelloRequestSchema>;

/** `POST /door/hello` success response. */
export const HelloResponseSchema = z.object({
  protocol_version: ProtocolVersionSchema,
  door_id: DoorIdSchema,
  door_pubkey: PublicKeyStringSchema,
  active_epoch: EpochSchema.nullable(),
  capabilities: z.array(CapabilitySchema),
  community: CommunityDescriptorSchema,
  issued_at: IsoTimestampSchema,
  sig: SignatureStringSchema
});

export type HelloResponse = z.infer<typeof HelloResponseSchema>;

const AttestKindSchema = z.enum(["arrival", "departure", "heartbeat"]);

/** `POST /door/attest` request body. */
export const AttestRequestSchema = z.object({
  protocol_version: ProtocolVersionSchema,
  door_id: DoorIdSchema,
  epoch: EpochSchema,
  kind: AttestKindSchema,
  core: CoreStringSchema,
  session_pubkey: PublicKeyStringSchema,
  issued_at: IsoTimestampSchema,
  sig: SignatureStringSchema
});

export type AttestRequest = z.infer<typeof AttestRequestSchema>;

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

/** Candidate memory shard submitted in `/door/cosign` review phase. */
export const CandidateShardSchema = z.object({
  shard_id: z.string().min(1),
  text: z.string().min(1).max(500),
  tags: z.array(z.string()).optional()
});

export type CandidateShard = z.infer<typeof CandidateShardSchema>;

/** Alias for runtime compatibility with prior `CosignCandidateShard` naming. */
export type CosignCandidateShard = CandidateShard;

const CosignReviewRequestSchema = z.object({
  protocol_version: ProtocolVersionSchema,
  phase: z.literal("review"),
  door_id: DoorIdSchema,
  epoch: EpochSchema,
  session_pubkey: PublicKeyStringSchema,
  farewell: z.string().max(500).optional(),
  shards: z.array(CandidateShardSchema).min(5).max(20),
  issued_at: IsoTimestampSchema,
  sig: SignatureStringSchema
});

const CosignCommitRequestSchema = z.object({
  protocol_version: ProtocolVersionSchema,
  phase: z.literal("commit"),
  door_id: DoorIdSchema,
  epoch: EpochSchema,
  session_pubkey: PublicKeyStringSchema,
  shard_id: z.string().min(1),
  core: CoreStringSchema,
  issued_at: IsoTimestampSchema,
  sig: SignatureStringSchema
});

/** `POST /door/cosign` request body (review or commit phase). */
export const CosignRequestSchema = z.discriminatedUnion("phase", [
  CosignReviewRequestSchema,
  CosignCommitRequestSchema
]);

export type CosignRequest = z.infer<typeof CosignRequestSchema>;

const ReviewDecisionSchema = z.object({
  shard_id: z.string().min(1),
  status: z.enum(["approved", "rejected"]),
  reason: z.string().optional(),
  host_audit_sig: SignatureStringSchema.optional()
});

export type ReviewDecision = z.infer<typeof ReviewDecisionSchema>;

const CosignReviewResponseSchema = z.object({
  phase: z.literal("review"),
  door_id: DoorIdSchema,
  epoch: EpochSchema,
  decisions: z.array(ReviewDecisionSchema),
  received_at: IsoTimestampSchema,
  door_sig: SignatureStringSchema
});

const CosignCommitResponseSchema = z.object({
  phase: z.literal("commit"),
  door_id: DoorIdSchema,
  epoch: EpochSchema,
  shard_id: z.string().min(1),
  door_cosig: SignatureStringSchema,
  received_at: IsoTimestampSchema,
  door_sig: SignatureStringSchema
});

/** `POST /door/cosign` success response (review or commit phase). */
export const CosignResponseSchema = z.discriminatedUnion("phase", [
  CosignReviewResponseSchema,
  CosignCommitResponseSchema
]);

export type CosignResponse = z.infer<typeof CosignResponseSchema>;

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

const ControlFrameBodySchema = z.object({
  action: z.enum(["ping", "pong", "session_end", "backpressure"]),
  reason: z.string().optional()
});

/** WebSocket `control` frame (ping/pong/session lifecycle). */
export const ControlFrameSchema = z.object({
  type: z.literal("control"),
  door_id: DoorIdSchema,
  epoch: EpochSchema,
  msg_id: z.string().min(1),
  issued_at: IsoTimestampSchema,
  body: ControlFrameBodySchema,
  sig: SignatureStringSchema.optional()
});

export type ControlFrame = z.infer<typeof ControlFrameSchema>;

const ErrorFrameBodySchema = z.object({
  error: DoorErrorObjectSchema,
  related_msg_id: z.string().min(1).optional()
});

/** WebSocket `error` frame. */
export const ErrorFrameSchema = z.object({
  type: z.literal("error"),
  door_id: DoorIdSchema,
  epoch: EpochSchema,
  msg_id: z.string().min(1),
  issued_at: IsoTimestampSchema,
  body: ErrorFrameBodySchema,
  sig: SignatureStringSchema.optional()
});

export type ErrorFrame = z.infer<typeof ErrorFrameSchema>;

/** Session binding parameters for `/door/session` connect. */
export const SessionBindParamsSchema = z.object({
  door_id: DoorIdSchema,
  epoch: EpochSchema,
  session_pubkey: PublicKeyStringSchema,
  session_sig: SignatureStringSchema
});

export type SessionBindParams = z.infer<typeof SessionBindParamsSchema>;

/** Injectable clock returning ISO 8601 UTC timestamps with millisecond precision. */
export interface Clock {
  now(): string;
}

/**
 * Door transport surface used by Session (attest, heartbeat, cosign).
 * Implemented by network adapters and in-process transports in tests.
 */
export interface DoorConnection {
  attest(request: AttestRequest): Promise<AttestResponse>;
  heartbeat(request: HeartbeatRequest): Promise<HeartbeatResponse>;
  cosign(request: CosignRequest): Promise<CosignResponse>;
}
