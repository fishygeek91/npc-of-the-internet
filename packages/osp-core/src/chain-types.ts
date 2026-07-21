/** Chain verification failure rule identifiers (T1.3). */
export type ChainRule =
  | "bad_soul_sig"
  | "broken_prev_link"
  | "seq_gap"
  | "schema_violation"
  | "missing_cosigner"
  | "forked_head"
  | "bad_genesis"
  | "bad_drift_evidence";

/** A single chain verification failure at a sequence position. */
export type ChainFailure = {
  seq: number;
  cid?: string;
  rule: ChainRule;
  message: string;
};
