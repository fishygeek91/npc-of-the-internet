import { parseResidency, type OspRecord } from "@npc/osp-core";

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
    "written_at",
    "proposed_at",
    "rejected_at",
    "effective_at",
    "decided_at",
    "executed_at",
    "at",
    "as_of"
  ];

  for (const key of keys) {
    const value = body[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }

  return "-";
}

const WITNESS_PREFIX = "witness_";

/**
 * Plain-language note for memory outcomes, or null: `journal for web:home epoch 3`,
 * `declined by the witness (private)` for `witness_*` rejections, and
 * `screened out (pii.email)` for the Wanderer's own immune-screen rejections, and
 * `legacy candidate` for pre-witness candidate records.
 */
export function describeRecord(record: OspRecord): string | null {
  if (record.type !== "memory") {
    return null;
  }
  const body = record.body;
  if (body.kind === "journal") {
    const parsed = record.residency === null ? null : parseResidency(record.residency);
    return parsed === null
      ? "journal"
      : `journal for ${parsed.doorId} epoch ${String(parsed.epoch)}`;
  }
  if (body.kind === "candidate") {
    return "legacy candidate";
  }
  if (body.kind === "rejected") {
    return body.category.startsWith(WITNESS_PREFIX)
      ? `declined by the witness (${body.category.slice(WITNESS_PREFIX.length)})`
      : `screened out (${body.category})`;
  }
  return null;
}

/**
 * Format one chain line: `seq type[/kind] cid-prefix… timestamp[ note]`, where the
 * optional note comes from {@link describeRecord}. The CID stays the third field.
 */
export function formatLogLine(record: OspRecord, cid: string): string {
  const cidPrefix = cid.length <= CID_PREFIX_LENGTH ? cid : `${cid.slice(0, CID_PREFIX_LENGTH)}…`;
  const line = `${record.seq} ${formatRecordType(record)} ${cidPrefix} ${extractTimestamp(record)}`;
  const note = describeRecord(record);
  return note === null ? line : `${line} ${note}`;
}
