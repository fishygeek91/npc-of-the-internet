import { isValidCid, type SoulStore } from "@npc/osp-core";

import type { Keyring } from "../keyring/types.js";
import type { Clock } from "../session/types.js";
import { QuarantineError } from "./errors.js";
import { scanQuarantineState } from "./scan.js";
import { sealQuarantineRecord } from "./seal.js";

/** Options for {@link flagCandidate}. */
export type FlagCandidateOptions = {
  store: SoulStore;
  keyring: Keyring;
  candidateCid: string;
  clock: Clock;
  /** Rejection category; defaults to `quarantine_flagged`. */
  category?: string;
};

/**
 * Operator flag: append a category-only `memory.rejected` record referencing a candidate.
 * The candidate text is never copied into the rejection record.
 */
export async function flagCandidate(options: FlagCandidateOptions): Promise<void> {
  if (!isValidCid(options.candidateCid)) {
    throw new QuarantineError(`invalid candidate CID: ${options.candidateCid}`, "invalid_cid");
  }

  const scan = await scanQuarantineState(options.store);
  const candidate = scan.candidates.find((entry) => entry.cid === options.candidateCid);
  if (candidate === undefined) {
    throw new QuarantineError(
      `candidate not found: ${options.candidateCid}`,
      "candidate_not_found"
    );
  }

  if (scan.committedCandidateCids.has(options.candidateCid)) {
    throw new QuarantineError(
      `candidate already committed: ${options.candidateCid}`,
      "already_committed"
    );
  }

  const head = await options.store.head();
  if (head === null) {
    throw new QuarantineError("flag: store has no head", "flag_failed");
  }

  const category = options.category ?? "quarantine_flagged";

  try {
    const { record } = await sealQuarantineRecord(options.keyring, {
      seq: head.seq + 1,
      prev: head.cid,
      type: "memory",
      body: {
        kind: "rejected",
        category,
        candidate_cid: options.candidateCid,
        rejected_at: options.clock.now()
      },
      residency: candidate.residency,
      cosigners: []
    });
    await options.store.append(record);
  } catch (error) {
    if (error instanceof QuarantineError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : "unknown error";
    throw new QuarantineError(
      `flag failed for candidate ${options.candidateCid}: ${message}`,
      "flag_failed"
    );
  }
}
