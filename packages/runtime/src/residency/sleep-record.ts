import { OSP_SPEC_V02, createRecordWithSigner, type SoulStore } from "@npc/osp-core";

import type { SleepRecordDraft } from "../brain/budgeted-brain.js";
import type { Keyring } from "../keyring/types.js";
import { SessionError } from "../session/errors.js";

/** Whether {@link appendSleepRecord} wrote a record or found one already newest. */
export type SleepAppendResult = "appended" | "already_sleeping";

/**
 * Append one soul-signed `sleep` record when the newest presence record is not
 * already `sleep`.
 *
 * Atlas treats any later attestation, including a heartbeat, as leaving sleep.
 * Callers withhold heartbeats and travel while the budget policy is asleep, so
 * this record stays public until the next attestation after wake. There is no
 * separate wake record. Pass a draft only when {@link SleepRecordDraft} is
 * non-null — unknown spend must not publish a balance.
 *
 * Sealed with `createRecordWithSigner` at `osp/0.2`, same as session `sealRecord`.
 *
 * @param options - Store, keyring, known-balance draft, and the live residency.
 * @throws {SessionError} When the store has no head.
 */
export async function appendSleepRecord(options: {
  store: SoulStore;
  keyring: Keyring;
  draft: SleepRecordDraft;
  residency: string;
}): Promise<SleepAppendResult> {
  if (await newestPresenceIsSleep(options.store)) {
    return "already_sleeping";
  }
  const head = await options.store.head();
  if (head === null) {
    throw new SessionError("cannot append sleep: store has no head");
  }
  const { record } = await createRecordWithSigner(
    {
      spec: OSP_SPEC_V02,
      seq: head.seq + 1,
      prev: head.cid,
      type: "sleep",
      body: {
        reason: options.draft.reason,
        balance: options.draft.balance,
        threshold: options.draft.threshold,
        as_of: options.draft.as_of
      },
      residency: options.residency,
      cosigners: []
    },
    (bytes: Uint8Array) => options.keyring.signWithSoulKey(bytes)
  );
  await options.store.append(record);
  return "appended";
}

/**
 * True when a `sleep` record is newer than every attestation. Memory and other
 * records in between do not wake the public state.
 */
async function newestPresenceIsSleep(store: SoulStore): Promise<boolean> {
  let sleeping = false;
  for await (const record of store.iterate()) {
    if (record.type === "sleep") {
      sleeping = true;
    } else if (record.type === "attestation") {
      sleeping = false;
    }
  }
  return sleeping;
}
