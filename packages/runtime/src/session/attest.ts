import {
  OSP_SPEC_V02,
  SchemaError,
  createRecordWithSigner,
  type CreateRecordFields,
  type OspRecord
} from "@npc/osp-core";

import type { Keyring } from "../keyring/types.js";
import { SessionError } from "./errors.js";

/** PoP version written into presence and travel attestation bodies. */
export const POP_VERSION = "pop/0.1" as const;

/**
 * Seal a signed record using the Keyring (never touches raw private keys).
 *
 * Sealing lives in `createRecordWithSigner`. This wrapper pins `spec` to
 * {@link OSP_SPEC_V02} and turns a schema failure into {@link SessionError}
 * (`invalid record: …`), which is the error callers already see.
 */
export async function sealRecord(
  keyring: Keyring,
  fields: CreateRecordFields
): Promise<{ record: OspRecord; cid: string }> {
  try {
    return await createRecordWithSigner({ ...fields, spec: OSP_SPEC_V02 }, (bytes: Uint8Array) =>
      keyring.signWithSoulKey(bytes)
    );
  } catch (error) {
    if (error instanceof SchemaError) {
      throw new SessionError(`invalid record: ${error.message}`);
    }
    throw error;
  }
}
