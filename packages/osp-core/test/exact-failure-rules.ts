import type { ChainRule } from "../src/chain-types.js";

/**
 * Exact `verifyRecords` failure rules for each negative file in `spec/osp/vectors/`.
 *
 * Vector metadata names one rule and no seq. The first entry is that rule.
 * Later entries are the verifier's full report (a bad signature or schema
 * failure can cascade into link and evidence rules). Pinning the list rejects
 * a misclassification that merely appears somewhere in `failures`.
 */
export const EXACT_FAILURE_RULES: Readonly<Record<string, readonly ChainRule[]>> = {
  "bad-drift-evidence.json": ["bad_drift_evidence"],
  "bad-genesis.json": ["bad_genesis"],
  "bad-session-continuity.json": ["bad_session_continuity"],
  "bad-soul-sig-small-order-key.json": ["bad_soul_sig", "bad_soul_sig"],
  "bad-soul-sig.json": ["bad_soul_sig", "broken_prev_link", "bad_drift_evidence"],
  "bad-tombstone-blob-mismatch.json": ["bad_tombstone"],
  "bad-tombstone-missing-target.json": ["bad_tombstone"],
  "broken-prev-link.json": ["broken_prev_link", "broken_prev_link", "bad_drift_evidence"],
  "conflicting-attestations.json": ["presence_conflict", "presence_conflict"],
  "forked-head.json": ["forked_head", "seq_gap", "broken_prev_link", "presence_conflict"],
  "journal-wrong-witness.json": ["missing_cosigner"],
  "missing-cosigner.json": ["missing_cosigner", "missing_cosigner"],
  "presence-conflict-epoch-reuse.json": ["presence_conflict", "presence_conflict"],
  "schema-bad-candidate-cid.json": ["schema_violation"],
  "schema-bad-evidence.json": ["schema_violation"],
  "schema-bad-key-length.json": ["schema_violation"],
  "schema-bad-prev.json": ["schema_violation"],
  "schema-bad-residency.json": ["schema_violation"],
  "schema-dag-json-reserved.json": ["schema_violation"],
  "schema-door-id-mismatch.json": ["schema_violation"],
  "schema-epoch-mismatch.json": ["schema_violation"],
  "schema-genesis-cosigners.json": ["schema_violation"],
  "schema-journal-v01.json": ["schema_violation"],
  "schema-proto-key.json": ["schema_violation"],
  "schema-rejected-with-payload.json": ["schema_violation"],
  "schema-tombstone-prose.json": ["schema_violation"],
  "schema-tombstone-v01.json": ["schema_violation"],
  "schema-unsorted-cosigners.json": ["schema_violation"],
  "schema-violation.json": ["schema_violation", "seq_gap", "broken_prev_link"],
  "seq-gap.json": ["seq_gap"],
  "stale-heartbeat-after-new-epoch.json": ["bad_session_continuity"],
  "wrong-door-cosign.json": ["missing_cosigner"]
};

/**
 * Return the pinned rule list for one negative vector file.
 *
 * @throws {Error} when `filename` has no pin or the pin is empty.
 */
export function exactFailureRules(filename: string): readonly ChainRule[] {
  const pinned = EXACT_FAILURE_RULES[filename];
  if (pinned === undefined || pinned.length === 0) {
    throw new Error(`${filename}: missing exact failure-rule list`);
  }
  return pinned;
}

/**
 * True when `actual` is the same rule sequence as `expected`.
 */
export function sameChainRules(
  actual: readonly ChainRule[],
  expected: readonly ChainRule[]
): boolean {
  if (actual.length !== expected.length) {
    return false;
  }
  for (let index = 0; index < actual.length; index += 1) {
    if (actual[index] !== expected[index]) {
      return false;
    }
  }
  return true;
}
