import type { z } from "zod";

import type { RecordSchema } from "./envelope.js";

type EnvelopeRecord = z.infer<typeof RecordSchema>;

const RECORD_TYPE_VALUES = [
  "genesis",
  "memory",
  "drift",
  "decision",
  "transaction",
  "attestation",
  "sleep",
  "tombstone"
] as const satisfies readonly EnvelopeRecord["type"][];

type MissingRecordType = Exclude<EnvelopeRecord["type"], (typeof RECORD_TYPE_VALUES)[number]>;

/**
 * `true` when {@link RECORD_TYPE_VALUES} covers every envelope type.
 * A missing type becomes a tuple naming it, so the `true` argument below does not compile.
 */
type RecordTypesComplete = [MissingRecordType] extends [never]
  ? true
  : ["RECORD_TYPES is missing an envelope type:", MissingRecordType];

function assertRecordTypesComplete(_ok: RecordTypesComplete): void {
  // Compile-time lock only. `_ok` is `true` when the list matches `OspRecord["type"]`.
}

assertRecordTypesComplete(true);

/**
 * Every soulchain record `type`, in `RecordSchemaBase` discriminator order.
 * Includes `tombstone`. Checked against `OspRecord["type"]` so a new envelope
 * type cannot land without updating this list.
 */
export const RECORD_TYPES = RECORD_TYPE_VALUES;

/** Soulchain record `type` discriminator. Same union as `OspRecord["type"]`. */
export type RecordType = (typeof RECORD_TYPES)[number];
