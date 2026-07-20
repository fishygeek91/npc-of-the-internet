import { z } from "zod";

import {
  AttestationBodySchema,
  DecisionBodySchema,
  DriftBodySchema,
  GenesisBodySchema,
  MemoryBodySchema,
  OSP_SPEC,
  SleepBodySchema,
  TransactionBodySchema
} from "./body.js";

/** Shared envelope fields present on every soulchain record. */
export const EnvelopeFieldsSchema = z.object({
  spec: z.literal(OSP_SPEC),
  seq: z.number().int().nonnegative(),
  prev: z.string().nullable(),
  residency: z.string().nullable(),
  cosigners: z.array(z.string()),
  sig: z.string()
});

/** Validates `prev` and `residency` nullability rules against `seq`. */
function validateChainLinkFields(
  record: { seq: number; prev: string | null; residency: string | null },
  ctx: z.RefinementCtx
): void {
  if (record.seq === 0) {
    if (record.prev !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "prev must be null when seq is 0",
        path: ["prev"]
      });
    }
    if (record.residency !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "residency must be null when seq is 0",
        path: ["residency"]
      });
    }
    return;
  }

  if (record.prev === null || record.prev.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "prev must be a non-empty string when seq > 0",
      path: ["prev"]
    });
  }

  if (record.residency === null || record.residency.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "residency must be a non-empty string when seq > 0",
      path: ["residency"]
    });
  }
}

/** Validates cosigner count rules that depend on record type and body kind. */
function validateCosignerRules(
  record: {
    type: string;
    body: unknown;
    cosigners: string[];
  },
  ctx: z.RefinementCtx
): void {
  const bodyKind =
    typeof record.body === "object" &&
    record.body !== null &&
    "kind" in record.body &&
    typeof record.body.kind === "string"
      ? record.body.kind
      : undefined;

  if (record.type === "memory" && bodyKind === "shard") {
    if (record.cosigners.length < 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "shard memory records require at least one cosigner",
        path: ["cosigners"]
      });
    }
    return;
  }

  if (record.type === "attestation") {
    if (
      (bodyKind === "arrival" || bodyKind === "departure" || bodyKind === "heartbeat") &&
      record.cosigners.length < 1
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${bodyKind} attestation records require at least one cosigner`,
        path: ["cosigners"]
      });
    }
  }
}

const GenesisRecordSchema = EnvelopeFieldsSchema.extend({
  type: z.literal("genesis"),
  body: GenesisBodySchema
});

const MemoryRecordSchema = EnvelopeFieldsSchema.extend({
  type: z.literal("memory"),
  body: MemoryBodySchema
});

const DriftRecordSchema = EnvelopeFieldsSchema.extend({
  type: z.literal("drift"),
  body: DriftBodySchema
});

const DecisionRecordSchema = EnvelopeFieldsSchema.extend({
  type: z.literal("decision"),
  body: DecisionBodySchema
});

const TransactionRecordSchema = EnvelopeFieldsSchema.extend({
  type: z.literal("transaction"),
  body: TransactionBodySchema
});

const AttestationRecordSchema = EnvelopeFieldsSchema.extend({
  type: z.literal("attestation"),
  body: AttestationBodySchema
});

const SleepRecordSchema = EnvelopeFieldsSchema.extend({
  type: z.literal("sleep"),
  body: SleepBodySchema
});

/**
 * Structural OSP soulchain record schema (no chain-link or cosigner refinements).
 * Used for JSON Schema emission; runtime validation uses {@link RecordSchema}.
 */
export const RecordSchemaBase = z.discriminatedUnion("type", [
  GenesisRecordSchema,
  MemoryRecordSchema,
  DriftRecordSchema,
  DecisionRecordSchema,
  TransactionRecordSchema,
  AttestationRecordSchema,
  SleepRecordSchema
]);

/**
 * Full OSP soulchain record schema.
 * Discriminates on top-level `type`; memory and attestation bodies further discriminate on `body.kind`.
 */
export const RecordSchema = RecordSchemaBase.superRefine((record, ctx) => {
  validateChainLinkFields(record, ctx);
  validateCosignerRules(record, ctx);
});
