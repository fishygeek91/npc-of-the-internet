import type { OspRecord } from "@npc/osp-core";

const CID_PREFIX_LENGTH = 13;

/** Human-readable type label, including body kind when present. */
export function formatRecordType(record: OspRecord): string {
  if (record.type === "memory" || record.type === "attestation") {
    return `${record.type}/${record.body.kind}`;
  }
  return record.type;
}

/** Extract a timestamp-like field from a record body, or "-" when none is present. */
export function extractTimestamp(record: OspRecord): string {
  const body = record.body as Record<string, unknown>;
  const keys = [
    "created_at",
    "distilled_at",
    "proposed_at",
    "rejected_at",
    "timestamp",
    "decided_at",
    "occurred_at",
    "departed_at",
    "arrived_at"
  ];

  for (const key of keys) {
    const value = body[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }

  return "-";
}

/** Format one chain line: `seq type[/kind] cid-prefix… timestamp`. */
export function formatLogLine(record: OspRecord, cid: string): string {
  const cidPrefix = cid.length <= CID_PREFIX_LENGTH ? cid : `${cid.slice(0, CID_PREFIX_LENGTH)}…`;
  return `${record.seq} ${formatRecordType(record)} ${cidPrefix} ${extractTimestamp(record)}`;
}
