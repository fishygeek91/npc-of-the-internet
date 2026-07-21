import { z } from "zod";

import { CidSchema } from "../crypto/cid.js";
import { decodePublicKey } from "../encoding/base64url.js";
import { EncodingError } from "../errors.js";

/** OSP spec version literal for all soulchain records. */
export const OSP_SPEC = "osp/0.1" as const;

/** PoP spec version literal for attestation bodies. */
export const POP_VERSION = "pop/0.1" as const;

const MEMORY_TEXT_MAX_CODE_POINTS = 500;

/** Count Unicode code points in a string (not UTF-16 code units). */
function countCodePoints(text: string): number {
  return [...text].length;
}

/** Validates that a string decodes to a 32-byte Ed25519 public key. */
function validatePublicKeyString(
  value: string,
  ctx: z.RefinementCtx,
  path: (string | number)[]
): void {
  try {
    decodePublicKey(value);
  } catch (error) {
    if (error instanceof EncodingError) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: error.message,
        path
      });
      return;
    }
    throw error;
  }
}

/** Zod string schema for a base64url-encoded 32-byte Ed25519 public key. */
const PublicKeyStringSchema = z.string().superRefine((value, ctx) => {
  validatePublicKeyString(value, ctx, []);
});

/** Memory shard/candidate text: max 500 Unicode code points. */
const MemoryTextSchema = z
  .string()
  .refine((text) => countCodePoints(text) <= MEMORY_TEXT_MAX_CODE_POINTS, {
    message: `text must be at most ${MEMORY_TEXT_MAX_CODE_POINTS} Unicode code points`
  });

/** Genesis record body (`type: "genesis"`). */
export const GenesisBodySchema = z
  .object({
    charter: z.string(),
    soul_pubkey: PublicKeyStringSchema,
    created_at: z.string(),
    fork_point: z.string().optional(),
    fork_reason: z.string().optional()
  })
  .strict()
  .superRefine((body, ctx) => {
    if (body.fork_point !== undefined && body.fork_reason === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "fork_reason is required when fork_point is present",
        path: ["fork_reason"]
      });
    }
  });

/** Committed memory shard body (`memory.body.kind: "shard"`). */
export const ShardBodySchema = z
  .object({
    kind: z.literal("shard"),
    text: MemoryTextSchema,
    candidate_cid: CidSchema.optional(),
    journal: z.string().optional(),
    distilled_at: z.string()
  })
  .strict();

/** Quarantine candidate memory body (`memory.body.kind: "candidate"`). */
export const CandidateBodySchema = z
  .object({
    kind: z.literal("candidate"),
    text: MemoryTextSchema,
    proposed_at: z.string()
  })
  .strict();

/** Rejected candidate memory body (`memory.body.kind: "rejected"`). */
export const RejectedBodySchema = z
  .object({
    kind: z.literal("rejected"),
    category: z.string(),
    candidate_cid: CidSchema.optional(),
    rejected_at: z.string()
  })
  .strict();

/** Memory record body — discriminated union on `kind`. */
export const MemoryBodySchema = z.discriminatedUnion("kind", [
  ShardBodySchema,
  CandidateBodySchema,
  RejectedBodySchema
]);

/** Drift record body (`type: "drift"`). */
export const DriftBodySchema = z
  .object({
    summary: z.string(),
    evidence: z.array(z.string()).min(1),
    effective_at: z.string()
  })
  .strict();

/** Decision record body (`type: "decision"`). */
export const DecisionBodySchema = z
  .object({
    decision: z.string(),
    reasoning: z.string(),
    inputs: z.record(z.string(), z.unknown()).optional(),
    decided_at: z.string()
  })
  .strict();

/** Transaction record body (`type: "transaction"`). */
export const TransactionBodySchema = z
  .object({
    direction: z.enum(["in", "out"]),
    amount: z.string(),
    currency: z.string(),
    counterparty: z.string().optional(),
    memo: z.string().optional(),
    tx_ref: z.string().optional(),
    executed_at: z.string()
  })
  .strict();

/** Sleep record body (`type: "sleep"`). */
export const SleepBodySchema = z
  .object({
    reason: z.string(),
    balance: z.string(),
    threshold: z.string(),
    as_of: z.string()
  })
  .strict();

/** Arrival attestation body (`attestation.body.kind: "arrival"`). */
export const ArrivalBodySchema = z
  .object({
    kind: z.literal("arrival"),
    pop_version: z.literal(POP_VERSION),
    door_id: z.string(),
    epoch: z.number().int().nonnegative(),
    session_pubkey: PublicKeyStringSchema,
    at: z.string()
  })
  .strict();

/** Heartbeat attestation body (`attestation.body.kind: "heartbeat"`). */
export const HeartbeatBodySchema = z
  .object({
    kind: z.literal("heartbeat"),
    pop_version: z.literal(POP_VERSION),
    door_id: z.string(),
    epoch: z.number().int().nonnegative(),
    session_pubkey: PublicKeyStringSchema,
    at: z.string()
  })
  .strict();

/** Departure attestation body (`attestation.body.kind: "departure"`). */
export const DepartureBodySchema = z
  .object({
    kind: z.literal("departure"),
    pop_version: z.literal(POP_VERSION),
    door_id: z.string(),
    epoch: z.number().int().nonnegative(),
    at: z.string()
  })
  .strict();

/** Travel attestation body (`attestation.body.kind: "travel"`). */
export const TravelBodySchema = z
  .object({
    kind: z.literal("travel"),
    pop_version: z.literal(POP_VERSION),
    from_door_id: z.string(),
    from_epoch: z.number().int().nonnegative(),
    to_door_id: z.string().optional(),
    at: z.string()
  })
  .strict();

/** Handover attestation body (`attestation.body.kind: "handover"`). */
export const HandoverBodySchema = z
  .object({
    kind: z.literal("handover"),
    pop_version: z.literal(POP_VERSION),
    depart_door_id: z.string(),
    arrive_door_id: z.string(),
    depart_epoch: z.number().int().nonnegative(),
    arrive_epoch: z.number().int().nonnegative(),
    depart_attestation: z.string().optional(),
    rotate_attestation: z.string().optional(),
    arrive_attestation: z.string().optional(),
    at: z.string()
  })
  .strict();

/** Attestation record body — discriminated union on `kind`. */
export const AttestationBodySchema = z.discriminatedUnion("kind", [
  ArrivalBodySchema,
  HeartbeatBodySchema,
  DepartureBodySchema,
  TravelBodySchema,
  HandoverBodySchema
]);
