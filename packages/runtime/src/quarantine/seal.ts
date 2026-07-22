import {
  OSP_SPEC,
  RecordSchema,
  canonicalize,
  computeCid,
  encodeSignature,
  soulPayload,
  type CreateRecordFields,
  type OspRecord
} from "@npc/osp-core";

import type { Keyring } from "../keyring/types.js";
import { QuarantineError } from "./errors.js";

/**
 * Seal a signed soulchain record for quarantine lifecycle appends.
 * Uses the soul key from the keyring; cosigners must already be sorted.
 */
export async function sealQuarantineRecord(
  keyring: Keyring,
  fields: CreateRecordFields
): Promise<{ record: OspRecord; cid: string }> {
  const sortedCosigners = [...fields.cosigners].sort();

  const soulBytes = canonicalize(
    soulPayload({
      spec: OSP_SPEC,
      seq: fields.seq,
      prev: fields.prev,
      type: fields.type,
      body: fields.body,
      residency: fields.residency,
      cosigners: sortedCosigners
    })
  );
  const soulSignature = encodeSignature(keyring.signWithSoulKey(soulBytes));

  const unsignedRecord = {
    spec: OSP_SPEC,
    seq: fields.seq,
    prev: fields.prev,
    type: fields.type,
    body: fields.body,
    residency: fields.residency,
    cosigners: sortedCosigners,
    sig: soulSignature
  };

  const parsed = RecordSchema.safeParse(unsignedRecord);
  if (!parsed.success) {
    throw new QuarantineError(`invalid record: ${parsed.error.message}`, "invalid_record");
  }

  const record = parsed.data;
  const cid = await computeCid(record);
  return { record, cid };
}
