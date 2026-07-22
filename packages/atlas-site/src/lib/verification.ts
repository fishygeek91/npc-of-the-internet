import type { VerifyChainResult } from "@npc/osp-core";

/**
 * Determine whether a single record should show a verified badge.
 *
 * When the chain verifies, every record is verified. Otherwise records at or after
 * the earliest failure (or explicitly listed in failures) are unverified; the prefix
 * before the first failure remains verified.
 */
export function recordVerified(seq: number, verifyResult: VerifyChainResult): boolean {
  if (verifyResult.valid) {
    return true;
  }

  const failureSeqs = new Set(verifyResult.failures.map((failure) => failure.seq));
  if (failureSeqs.has(seq)) {
    return false;
  }

  let minFailureSeq = Number.POSITIVE_INFINITY;
  for (const failure of verifyResult.failures) {
    if (failure.seq < minFailureSeq) {
      minFailureSeq = failure.seq;
    }
  }

  return seq < minFailureSeq;
}
