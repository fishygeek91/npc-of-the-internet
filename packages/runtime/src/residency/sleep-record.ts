import type { SoulStore } from "@npc/osp-core";

import type { SleepRecordDraft } from "../brain/budgeted-brain.js";
import type { Keyring } from "../keyring/types.js";
import { sealRecord } from "../session/attest.js";
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
 * Sealed with {@link sealRecord} (`osp/0.2`). The caller queues this on the session
 * append queue, so it serializes with arrival and heartbeats.
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
  const { record } = await sealRecord(options.keyring, {
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
  });
  await options.store.append(record);
  return "appended";
}

/**
 * Head CID last scanned for this store. A suspended tick re-checks the head
 * and skips the chain walk while the head has not moved.
 */
const presenceByStore = new WeakMap<SoulStore, { headCid: string | null; sleeping: boolean }>();

/**
 * True when a `sleep` record is newer than every attestation. Memory and other
 * records in between do not wake the public state.
 */
async function newestPresenceIsSleep(store: SoulStore): Promise<boolean> {
  const head = await store.head();
  const headCid = head === null ? null : head.cid;
  const cached = presenceByStore.get(store);
  if (cached !== undefined && cached.headCid === headCid) {
    return cached.sleeping;
  }
  let sleeping = false;
  for await (const record of store.iterate()) {
    if (record.type === "sleep") {
      sleeping = true;
    } else if (record.type === "attestation") {
      sleeping = false;
    }
  }
  presenceByStore.set(store, { headCid, sleeping });
  return sleeping;
}
