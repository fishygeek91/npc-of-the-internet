import { z } from "zod";

import { CidSchema } from "../crypto/cid.js";
import { decodeSignature } from "../encoding/base64url.js";
import { EncodingError } from "../errors.js";
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

/** Residency descriptor format: `door:<platform>:<door-id>/epoch:<n>`. */
export const RESIDENCY_RE = /^door:[a-z0-9-]+:[A-Za-z0-9_-]+\/epoch:(0|[1-9][0-9]*)$/;

/** Validates that a string decodes to a 64-byte Ed25519 signature. */
function validateSignatureString(
  value: string,
  ctx: z.RefinementCtx,
  path: (string | number)[]
): void {
  try {
    decodeSignature(value);
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

/**
 * Extract the Door identifier from a validated residency string.
 * Strips the leading `door:` prefix and `/epoch:<n>` suffix.
 */
function doorIdFromResidency(residency: string): string {
  const withoutPrefix = residency.slice("door:".length);
  const epochSuffix = withoutPrefix.lastIndexOf("/epoch:");
  return withoutPrefix.slice(0, epochSuffix);
}

/**
 * Parse a residency descriptor into Door id and epoch.
 * Returns null when the string does not match {@link RESIDENCY_RE}.
 */
export function parseResidency(residency: string): { doorId: string; epoch: number } | null {
  if (!RESIDENCY_RE.test(residency)) {
    return null;
  }
  const epochSuffix = residency.lastIndexOf("/epoch:");
  const epochText = residency.slice(epochSuffix + "/epoch:".length);
  const epoch = Number.parseInt(epochText, 10);
  if (!Number.isFinite(epoch)) {
    return null;
  }
  return { doorId: doorIdFromResidency(residency), epoch };
}

/** Shared envelope fields present on every soulchain record. */
export const EnvelopeFieldsSchema = z
  .object({
    spec: z.literal(OSP_SPEC),
    seq: z.number().int().nonnegative(),
    prev: CidSchema.nullable(),
    residency: z.string().nullable(),
    cosigners: z.array(z.string()),
    sig: z.string()
  })
  .strict();

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
    return;
  }

  if (!RESIDENCY_RE.test(record.residency)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "residency must match door:<platform>:<door-id>/epoch:<n> (example: door:discord:guild123/epoch:77)",
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
  if (record.type === "genesis" && record.cosigners.length > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "genesis records must have an empty cosigners array",
      path: ["cosigners"]
    });
    return;
  }

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

/** Validates sig and cosigner signature encodings. */
function validateSignatureFields(
  record: { cosigners: string[]; sig: string },
  ctx: z.RefinementCtx
): void {
  validateSignatureString(record.sig, ctx, ["sig"]);

  record.cosigners.forEach((cosigner, index) => {
    validateSignatureString(cosigner, ctx, ["cosigners", index]);
  });
}

/** Cross-checks attestation door_id against the Door portion of residency. */
function validateAttestationDoorId(
  record: {
    type: string;
    body: unknown;
    residency: string | null;
  },
  ctx: z.RefinementCtx
): void {
  if (record.type !== "attestation" || record.residency === null) {
    return;
  }

  if (
    typeof record.body !== "object" ||
    record.body === null ||
    !("kind" in record.body) ||
    typeof record.body.kind !== "string" ||
    !("door_id" in record.body) ||
    typeof record.body.door_id !== "string"
  ) {
    return;
  }

  const bodyKind = record.body.kind;
  if (bodyKind !== "arrival" && bodyKind !== "heartbeat" && bodyKind !== "departure") {
    return;
  }

  const expectedDoorId = doorIdFromResidency(record.residency);
  if (record.body.door_id !== expectedDoorId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `door_id must match the Door portion of residency (expected "${expectedDoorId}")`,
      path: ["body", "door_id"]
    });
  }
}

const GenesisRecordSchema = EnvelopeFieldsSchema.extend({
  type: z.literal("genesis"),
  body: GenesisBodySchema
}).strict();

const MemoryRecordSchema = EnvelopeFieldsSchema.extend({
  type: z.literal("memory"),
  body: MemoryBodySchema
}).strict();

const DriftRecordSchema = EnvelopeFieldsSchema.extend({
  type: z.literal("drift"),
  body: DriftBodySchema
}).strict();

const DecisionRecordSchema = EnvelopeFieldsSchema.extend({
  type: z.literal("decision"),
  body: DecisionBodySchema
}).strict();

const TransactionRecordSchema = EnvelopeFieldsSchema.extend({
  type: z.literal("transaction"),
  body: TransactionBodySchema
}).strict();

const AttestationRecordSchema = EnvelopeFieldsSchema.extend({
  type: z.literal("attestation"),
  body: AttestationBodySchema
}).strict();

const SleepRecordSchema = EnvelopeFieldsSchema.extend({
  type: z.literal("sleep"),
  body: SleepBodySchema
}).strict();

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
  validateSignatureFields(record, ctx);
  validateAttestationDoorId(record, ctx);
});
