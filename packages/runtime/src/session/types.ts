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

/** Candidate memory shard submitted in `/door/cosign` review phase. */
export const CandidateShardSchema = z.object({
  shard_id: z.string().min(1),
  text: z.string().min(1).max(500),
  tags: z.array(z.string()).optional()
});

export type CosignCandidateShard = z.infer<typeof CandidateShardSchema>;

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
  core: z.string().min(1),
  issued_at: IsoTimestampSchema,
  sig: SignatureStringSchema
});

/** `POST /door/cosign` request body (review or commit phase). */
export const CosignRequestSchema = z.discriminatedUnion("phase", [
  CosignReviewRequestSchema,
  CosignCommitRequestSchema
]);

export type CosignRequest = z.infer<typeof CosignRequestSchema>;

/** Fields covered by `/door/cosign` review request `sig` (excludes `protocol_version`). */
export type CosignReviewSigningFields = {
  door_id: string;
  epoch: number;
  phase: "review";
  session_pubkey: string;
  shards: CosignCandidateShard[];
  issued_at: string;
  farewell?: string;
};

/** Canonical bytes for `/door/cosign` review request signatures per `spec/door/api.md`. */
export function cosignReviewSigningPayload(
  request: Omit<Extract<CosignRequest, { phase: "review" }>, "sig">
): Uint8Array {
  const fields: CosignReviewSigningFields = {
    door_id: request.door_id,
    epoch: request.epoch,
    phase: request.phase,
    session_pubkey: request.session_pubkey,
    shards: request.shards,
    issued_at: request.issued_at
  };
  if (request.farewell !== undefined) {
    fields.farewell = request.farewell;
  }
  return canonicalize(fields);
}

/** Fields covered by `/door/cosign` commit request `sig` (excludes `protocol_version`). */
export type CosignCommitSigningFields = {
  door_id: string;
  epoch: number;
  phase: "commit";
  session_pubkey: string;
  shard_id: string;
  core: string;
  issued_at: string;
};

/** Canonical bytes for `/door/cosign` commit request signatures per `spec/door/api.md`. */
export function cosignCommitSigningPayload(
  request: Omit<Extract<CosignRequest, { phase: "commit" }>, "sig">
): Uint8Array {
  const fields: CosignCommitSigningFields = {
    door_id: request.door_id,
    epoch: request.epoch,
    phase: request.phase,
    session_pubkey: request.session_pubkey,
    shard_id: request.shard_id,
    core: request.core,
    issued_at: request.issued_at
  };
  return canonicalize(fields);
}

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

/**
 * Door transport surface used by Session (attest, heartbeat, cosign).
 * Implemented by network adapters and in-process `DoorStub` in tests.
 */
export interface DoorConnection {
  attest(request: AttestRequest): Promise<AttestResponse>;
  heartbeat(request: HeartbeatRequest): Promise<HeartbeatResponse>;
  cosign(request: CosignRequest): Promise<CosignResponse>;
}
