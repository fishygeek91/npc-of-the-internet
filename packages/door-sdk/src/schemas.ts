import { decodePublicKey, decodeSignature } from "@npc/osp-core";
import { z } from "zod";

/** Door API protocol version (`spec/door/api.md`). */
export const DOOR_PROTOCOL_VERSION = "door/0.2" as const;

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

/** Machine-readable feature flags registered by `door/0.2`. */
export const CapabilitySchema = z.enum([
  "session.text",
  "session.threads",
  "heartbeat",
  "attest",
  "attest.memory",
  "session.reactions",
  "session.addressing"
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
  /** Registered values are {@link Capability}; unknown values are ignored (forward compat). */
  capabilities: z.array(z.string().min(1)),
  community: CommunityDescriptorSchema,
  issued_at: IsoTimestampSchema,
  sig: SignatureStringSchema
});

export type HelloResponse = z.infer<typeof HelloResponseSchema>;

const AttestKindSchema = z.enum(["arrival", "heartbeat", "memory", "departure"]);

export type AttestKind = z.infer<typeof AttestKindSchema>;

/** Max code points of the `text` a `memory` attest carries (journal markdown). */
export const MEMORY_ATTEST_TEXT_MAX = 32_000;

/** `POST /door/attest` request body. */
export const AttestRequestSchema = z
  .object({
    protocol_version: ProtocolVersionSchema,
    door_id: DoorIdSchema,
    epoch: EpochSchema,
    kind: AttestKindSchema,
    core: CoreStringSchema,
    session_pubkey: PublicKeyStringSchema,
    /** `memory` only: the prose `core` references by hash (shard text or journal). */
    text: z
      .string()
      .min(1)
      .refine((value) => [...value].length <= MEMORY_ATTEST_TEXT_MAX, {
        message: `text must be at most ${String(MEMORY_ATTEST_TEXT_MAX)} code points`
      })
      .optional(),
    issued_at: IsoTimestampSchema,
    sig: SignatureStringSchema
  })
  .superRefine((request, ctx) => {
    if ((request.kind === "memory") !== (request.text !== undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "text is required for kind memory and not allowed otherwise",
        path: ["text"]
      });
    }
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

/** Why a Door's witness declined a memory (`witness_declined` → `error.details.reason`). */
export const WitnessReasonSchema = z.enum([
  "ungrounded",
  "private",
  "harmful",
  "manipulation",
  "other"
]);

export type WitnessReason = z.infer<typeof WitnessReasonSchema>;

const InboundFrameBodySchema = z.object({
  text: z.string().min(1).max(4000),
  author_id: z.string().min(1),
  author_display: z.string().optional(),
  reply_to: z.string().optional(),
  channel_id: z.string().optional(),
  /**
   * `session.addressing`: Door-observed platform signal that the message is aimed at
   * the Wanderer (e.g. @mention or a reply to one of its messages). Advisory, untrusted.
   */
  addressed: z.boolean().optional()
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

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** U+20E3 COMBINING ENCLOSING KEYCAP: keycap emoji (digit + VS16 + U+20E3) are not Extended_Pictographic. */
const KEYCAP_COMBINING_MARK = String.fromCodePoint(0x20e3);

/** The only valid keycap emoji: `[0-9#*]`, optional U+FE0F, then U+20E3. */
const KEYCAP_SEQUENCE = /^[0-9#*]\u{FE0F}?\u{20E3}$/u;

/** True for a single Unicode emoji candidate (pictographic, flag, or a valid keycap). */
function isEmojiCandidate(value: string): boolean {
  if (value.includes(KEYCAP_COMBINING_MARK)) {
    // U+20E3 is only an emoji inside a keycap sequence ("a⃣" / lone U+20E3 are not).
    return KEYCAP_SEQUENCE.test(value);
  }
  return /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(value);
}

function graphemeCount(value: string): number {
  return Array.from(graphemeSegmenter.segment(value)).length;
}

/**
 * Max length of an outbound reaction emoji string (a single Unicode emoji,
 * including ZWJ sequences and skin-tone / variation modifiers).
 */
export const REACTION_EMOJI_MAX_LENGTH = 32;

/** `session.reactions`: Wanderer reacts to a prior message with a single Unicode emoji. */
export const OutboundReactionSchema = z.object({
  emoji: z
    .string()
    .min(1)
    .max(REACTION_EMOJI_MAX_LENGTH)
    .refine((value) => isEmojiCandidate(value), {
      message: "reaction emoji must be a Unicode emoji"
    })
    .refine((value) => !/[\s<>:]/u.test(value), {
      message: "reaction emoji must not contain whitespace or custom-emoji syntax"
    })
    .refine((value) => graphemeCount(value) === 1, {
      message: "reaction must be exactly one emoji"
    }),
  /** `msg_id` of the inbound (or prior outbound) message being reacted to. */
  target_msg_id: z.string().min(1)
});

export type OutboundReaction = z.infer<typeof OutboundReactionSchema>;

const OutboundFrameBodySchema = z
  .object({
    /** Spoken text. Optional only when `reaction` is present (`session.reactions`). */
    text: z.string().min(1).max(4000).optional(),
    reply_to: z.string().optional(),
    channel_id: z.string().optional(),
    reaction: OutboundReactionSchema.optional()
  })
  .refine((body) => body.text !== undefined || body.reaction !== undefined, {
    message: "outbound body must carry text, reaction, or both"
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
 * Door transport surface used by Session (attest, heartbeat).
 * Implemented by network adapters and in-process transports in tests.
 */
export interface DoorConnection {
  attest(request: AttestRequest): Promise<AttestResponse>;
  heartbeat(request: HeartbeatRequest): Promise<HeartbeatResponse>;
}
