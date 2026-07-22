import type { OspRecord } from "@npc/osp-core";

/** Safe display body for a rejected memory record. */
export type RejectedDisplayBody = {
  kind: "rejected";
  category: string;
  rejected_at: string;
  candidate_cid?: string;
};

/**
 * Produce a display-safe body object for a soulchain record.
 * Rejected memory records never expose candidate text payloads.
 */
export function toDisplayBody(record: OspRecord): unknown {
  if (record.type === "memory" && record.body.kind === "rejected") {
    const body = record.body;
    const display: RejectedDisplayBody = {
      kind: "rejected",
      category: body.category,
      rejected_at: body.rejected_at
    };
    if (body.candidate_cid !== undefined) {
      display.candidate_cid = body.candidate_cid;
    }
    return display;
  }

  return record.body;
}

/**
 * Pretty-print a record body for explorer detail views.
 */
export function prettyPrintBody(record: OspRecord): string {
  return JSON.stringify(toDisplayBody(record), null, 2);
}
