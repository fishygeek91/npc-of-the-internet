import { z } from "zod";

import { CidSchema } from "../crypto/cid.js";
import { decodeBase64Url, decodePublicKey } from "../encoding/base64url.js";
import { EncodingError } from "../errors.js";
import { cidMatchesHash } from "../memory-blob.js";

/** Historical OSP spec version (inline memory text). */
export const OSP_SPEC_V01 = "osp/0.1" as const;

/** Current OSP spec version (memory text off-chain by reference). */
export const OSP_SPEC_V02 = "osp/0.2" as const;

/**
 * Default for {@link createRecord} when `spec` is omitted.
 * Ghost runtime cutover (#119 PR2) writes {@link OSP_SPEC_V02} explicitly;
 * historical vectors/tests pin {@link OSP_SPEC_V01}.
 */
export const OSP_SPEC = OSP_SPEC_V01;

/** Union of supported OSP soulchain `spec` field values. */
export type OspSpecVersion = typeof OSP_SPEC_V01 | typeof OSP_SPEC_V02;

/** ISO-8601 UTC timestamp ending in Z (fractional seconds optional). */
const ISO_UTC_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;

/** Zod schema for ISO-8601 UTC timestamps per spec/osp/records.md. */
export const IsoUtcTimestampSchema = z
  .string()
  .regex(ISO_UTC_TIMESTAMP_RE, "must be an ISO-8601 UTC timestamp ending in Z");

/** PoP spec version literal for attestation bodies. */
export const POP_VERSION = "pop/0.1" as const;

const MEMORY_TEXT_MAX_CODE_POINTS = 500;
const SHA256_DIGEST_LENGTH = 32;

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

/**
 * Base64url of a raw 32-byte sha2-256 digest (side-blob content hash).
 */
export const BlobContentHashSchema = z.string().superRefine((value, ctx) => {
  try {
    const bytes = decodeBase64Url(value);
    if (bytes.length !== SHA256_DIGEST_LENGTH) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `content hash must decode to ${SHA256_DIGEST_LENGTH} bytes`
      });
    }
  } catch (error) {
    if (error instanceof EncodingError) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: error.message
      });
      return;
    }
    throw error;
  }
});

/** Closed enum of tombstone erasure reasons (category-level; never free text). */
export const TombstoneReasonSchema = z.enum([
  "erasure_request",
  "dmca",
  "illegal_content",
  "operator"
]);

/** Genesis record body (`type: "genesis"`). */
export const GenesisBodySchema = z
  .object({
    charter: z.string(),
    soul_pubkey: PublicKeyStringSchema,
    created_at: IsoUtcTimestampSchema,
    fork_point: CidSchema.optional(),
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

/** Committed memory shard body under `osp/0.1` (inline text). */
export const ShardBodyV01Schema = z
  .object({
    kind: z.literal("shard"),
    text: MemoryTextSchema,
    candidate_cid: CidSchema.optional(),
    journal: z.string().optional(),
    distilled_at: IsoUtcTimestampSchema
  })
  .strict();

/** Committed memory shard body under `osp/0.2` (side-blob references). */
export const ShardBodyV02Schema = z
  .object({
    kind: z.literal("shard"),
    text_cid: CidSchema,
    text_hash: BlobContentHashSchema,
    candidate_cid: CidSchema.optional(),
    journal_cid: CidSchema.optional(),
    journal_hash: BlobContentHashSchema.optional(),
    distilled_at: IsoUtcTimestampSchema
  })
  .strict()
  .superRefine((body, ctx) => {
    if (!cidMatchesHash(body.text_cid, body.text_hash)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "text_cid digest must match text_hash",
        path: ["text_hash"]
      });
    }
    const hasJournalCid = body.journal_cid !== undefined;
    const hasJournalHash = body.journal_hash !== undefined;
    if (hasJournalCid !== hasJournalHash) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "journal_cid and journal_hash must both be present or both absent",
        path: hasJournalCid ? ["journal_hash"] : ["journal_cid"]
      });
      return;
    }
    if (
      body.journal_cid !== undefined &&
      body.journal_hash !== undefined &&
      !cidMatchesHash(body.journal_cid, body.journal_hash)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "journal_cid digest must match journal_hash",
        path: ["journal_hash"]
      });
    }
  });

/**
 * Committed memory shard body — `osp/0.1` inline or `osp/0.2` blob refs.
 * Prefer the versioned schemas when constructing records.
 */
export const ShardBodySchema = z.union([ShardBodyV01Schema, ShardBodyV02Schema]);

/** Quarantine candidate memory body under `osp/0.1`. */
export const CandidateBodyV01Schema = z
  .object({
    kind: z.literal("candidate"),
    text: MemoryTextSchema,
    proposed_at: IsoUtcTimestampSchema
  })
  .strict();

/** Quarantine candidate memory body under `osp/0.2`. */
export const CandidateBodyV02Schema = z
  .object({
    kind: z.literal("candidate"),
    text_cid: CidSchema,
    text_hash: BlobContentHashSchema,
    proposed_at: IsoUtcTimestampSchema
  })
  .strict()
  .superRefine((body, ctx) => {
    if (!cidMatchesHash(body.text_cid, body.text_hash)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "text_cid digest must match text_hash",
        path: ["text_hash"]
      });
    }
  });

/**
 * Quarantine candidate body — `osp/0.1` inline or `osp/0.2` blob refs.
 */
export const CandidateBodySchema = z.union([CandidateBodyV01Schema, CandidateBodyV02Schema]);

/** Rejected candidate memory body (`memory.body.kind: "rejected"`). */
export const RejectedBodySchema = z
  .object({
    kind: z.literal("rejected"),
    category: z.string(),
    candidate_cid: CidSchema.optional(),
    rejected_at: IsoUtcTimestampSchema
  })
  .strict();

/** Memory record body — union of versioned shard/candidate shapes plus rejected. */
export const MemoryBodySchema = z.union([
  ShardBodyV01Schema,
  ShardBodyV02Schema,
  CandidateBodyV01Schema,
  CandidateBodyV02Schema,
  RejectedBodySchema
]);

/** Tombstone record body (`type: "tombstone"`) — never carries erased prose. */
export const TombstoneBodySchema = z
  .object({
    target_cid: CidSchema,
    blob_cid: CidSchema,
    reason: TombstoneReasonSchema,
    erased_at: IsoUtcTimestampSchema
  })
  .strict();

/** Drift record body (`type: "drift"`). */
export const DriftBodySchema = z
  .object({
    summary: z.string(),
    evidence: z.array(CidSchema).min(1),
    effective_at: IsoUtcTimestampSchema
  })
  .strict();

/** Decision record body (`type: "decision"`). */
export const DecisionBodySchema = z
  .object({
    decision: z.string(),
    reasoning: z.string(),
    inputs: z.record(z.string(), z.unknown()).optional(),
    decided_at: IsoUtcTimestampSchema
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
    executed_at: IsoUtcTimestampSchema
  })
  .strict();

/** Sleep record body (`type: "sleep"`). */
export const SleepBodySchema = z
  .object({
    reason: z.string(),
    balance: z.string(),
    threshold: z.string(),
    as_of: IsoUtcTimestampSchema
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
    at: IsoUtcTimestampSchema
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
    at: IsoUtcTimestampSchema
  })
  .strict();

/** Departure attestation body (`attestation.body.kind: "departure"`). */
export const DepartureBodySchema = z
  .object({
    kind: z.literal("departure"),
    pop_version: z.literal(POP_VERSION),
    door_id: z.string(),
    epoch: z.number().int().nonnegative(),
    at: IsoUtcTimestampSchema
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
    at: IsoUtcTimestampSchema
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
    at: IsoUtcTimestampSchema
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
