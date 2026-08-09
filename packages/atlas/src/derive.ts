import { computeCid, parseResidency as parseOspResidency, type OspRecord } from "@npc/osp-core";

import { AtlasError } from "./errors.js";

/** Wanderer presence state derived from the latest attestation record. */
export type WandererStatus = "present" | "traveling" | "sleeping";

/** Response shape for `GET /state`. */
export type StateResponse = {
  status: WandererStatus;
  door_id: string | null;
  epoch: number | null;
  last_record_at: string | null;
  verified: boolean;
};

/** Response shape for `GET /chain/head`. */
export type HeadResponse = {
  cid: string;
  seq: number;
  kind: string;
  verified: boolean;
};

/** Query parameters for `GET /records`. */
export type RecordsQuery = {
  type?: string;
  page?: number;
  per_page?: number;
};

/** One item in a paginated records listing. */
export type RecordListItem = {
  cid: string;
  seq: number;
  kind: string;
  issued_at: string | null;
  summary: string;
};

/** Response shape for `GET /records`. */
export type RecordsPageResponse = {
  records: RecordListItem[];
  page: number;
  per_page: number;
  total: number;
  verified: boolean;
};

/** One journal entry derived from a memory shard. */
export type JournalEntry = {
  epoch: number;
  door_id: string;
  cid: string;
  journal: string;
};

/** Query parameters for `GET /journals`. */
export type JournalsQuery = {
  page?: number;
  per_page?: number;
};

/** Response shape for `GET /journals`. */
export type JournalsResponse = {
  journals: JournalEntry[];
  page: number;
  per_page: number;
  total: number;
  verified: boolean;
};

const RECORD_TYPES = [
  "genesis",
  "memory",
  "drift",
  "decision",
  "transaction",
  "attestation",
  "sleep"
] as const;

type RecordType = (typeof RECORD_TYPES)[number];

function isRecordType(value: string): value is RecordType {
  return (RECORD_TYPES as readonly string[]).includes(value);
}

/**
 * Extract the authoritative timestamp from a record body by type.
 * Returns null when no known timestamp field is present.
 */
export function extractRecordTimestamp(record: OspRecord): string | null {
  switch (record.type) {
    case "genesis":
      return record.body.created_at;
    case "memory": {
      const body = record.body;
      if (body.kind === "shard") {
        return body.distilled_at;
      }
      if (body.kind === "candidate") {
        return body.proposed_at;
      }
      return body.rejected_at;
    }
    case "drift":
      return record.body.effective_at;
    case "decision":
      return record.body.decided_at;
    case "transaction":
      return record.body.executed_at;
    case "attestation":
      return record.body.at;
    case "sleep":
      return record.body.as_of;
    case "tombstone":
      return record.body.erased_at;
  }
}

/** Format a record kind label (`memory/shard`, `attestation/arrival`, etc.). */
export function formatRecordKind(record: OspRecord): string {
  if (record.type === "memory" || record.type === "attestation") {
    return `${record.type}/${record.body.kind}`;
  }
  return record.type;
}

/** Build a safe one-line summary for a record (never includes shard text or journal). */
export function recordSummary(record: OspRecord): string {
  switch (record.type) {
    case "genesis":
      return "genesis";
    case "memory":
      return `memory/${record.body.kind}`;
    case "drift":
      return "drift";
    case "decision":
      return "decision";
    case "transaction":
      return "transaction";
    case "sleep":
      return "sleep";
    case "tombstone":
      return "tombstone";
    case "attestation": {
      const body = record.body;
      switch (body.kind) {
        case "arrival":
          return `attestation/arrival door=${body.door_id} epoch=${String(body.epoch)}`;
        case "heartbeat":
          return `attestation/heartbeat door=${body.door_id} epoch=${String(body.epoch)}`;
        case "departure":
          return `attestation/departure door=${body.door_id} epoch=${String(body.epoch)}`;
        case "travel":
          return `attestation/travel from=${body.from_door_id} epoch=${String(body.from_epoch)}`;
        case "handover":
          return `attestation/handover depart=${body.depart_door_id} epoch=${String(body.depart_epoch)}`;
      }
    }
  }
}

/**
 * Parse a residency string into Atlas wire fields (`door_id`, `epoch`).
 * Delegates to osp-core `parseResidency` so the residency grammar stays single-sourced.
 */
export function parseResidency(residency: string): { door_id: string; epoch: number } | null {
  const parsed = parseOspResidency(residency);
  if (parsed === null) {
    return null;
  }
  return { door_id: parsed.doorId, epoch: parsed.epoch };
}

/**
 * Derive Wanderer presence state from chain records.
 * Scans newest to oldest: a `sleep` record before any attestation means sleeping
 * (do not fake presence after the soul has recorded sleep).
 */
export function deriveState(records: readonly OspRecord[], verified: boolean): StateResponse {
  const head = records.length > 0 ? records[records.length - 1] : undefined;
  const lastRecordAt = head === undefined ? null : extractRecordTimestamp(head);

  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record === undefined) {
      continue;
    }

    if (record.type === "sleep") {
      return {
        status: "sleeping",
        door_id: null,
        epoch: null,
        last_record_at: lastRecordAt,
        verified
      };
    }

    if (record.type !== "attestation") {
      continue;
    }

    const body = record.body;
    switch (body.kind) {
      case "arrival":
      case "heartbeat":
        return {
          status: "present",
          door_id: body.door_id,
          epoch: body.epoch,
          last_record_at: lastRecordAt,
          verified
        };
      case "departure":
        return {
          status: "traveling",
          door_id: null,
          epoch: body.epoch,
          last_record_at: lastRecordAt,
          verified
        };
      case "travel":
        return {
          status: "traveling",
          door_id: null,
          epoch: body.from_epoch,
          last_record_at: lastRecordAt,
          verified
        };
      case "handover":
        return {
          status: "traveling",
          door_id: null,
          epoch: body.depart_epoch,
          last_record_at: lastRecordAt,
          verified
        };
    }
  }

  return {
    status: "sleeping",
    door_id: null,
    epoch: null,
    last_record_at: lastRecordAt,
    verified
  };
}

/**
 * Derive chain head metadata for `GET /chain/head`.
 * Returns null when the chain has no records.
 */
export async function deriveHead(
  records: readonly OspRecord[],
  verified: boolean
): Promise<HeadResponse | null> {
  const head = records.length > 0 ? records[records.length - 1] : undefined;
  if (head === undefined) {
    return null;
  }

  const cid = await computeCid(head);
  return {
    cid,
    seq: head.seq,
    kind: formatRecordKind(head),
    verified
  };
}

/**
 * Derive a paginated records listing.
 * @throws {AtlasError} when `query.type` is not a known record type.
 */
export async function deriveRecordsPage(
  records: readonly OspRecord[],
  verified: boolean,
  query: RecordsQuery
): Promise<RecordsPageResponse> {
  const page = Math.max(query.page ?? 1, 1);
  const perPage = Math.min(Math.max(query.per_page ?? 50, 1), 200);

  if (query.type !== undefined && !isRecordType(query.type)) {
    throw new AtlasError("invalid_type", `Unknown record type: ${query.type}`, 400, {
      type: query.type
    });
  }

  const filtered =
    query.type === undefined ? records : records.filter((record) => record.type === query.type);

  const total = filtered.length;
  const start = (page - 1) * perPage;
  const slice = start >= total ? [] : filtered.slice(start, start + perPage);

  const items: RecordListItem[] = [];
  for (const record of slice) {
    items.push({
      cid: await computeCid(record),
      seq: record.seq,
      kind: formatRecordKind(record),
      issued_at: extractRecordTimestamp(record),
      summary: recordSummary(record)
    });
  }

  return {
    records: items,
    page,
    per_page: perPage,
    total,
    verified
  };
}

/**
 * Derive journal entries from memory shard records (newest first).
 * Skips shards without a journal field.
 *
 * When `query` is omitted (library / static-site callers), returns the full list
 * with `page: 1` and `per_page` equal to `total` (or `50` when `total` is 0).
 * HTTP callers pass query defaults (page 1, per_page 50, max 200) matching `/records`.
 */
export async function deriveJournals(
  records: readonly OspRecord[],
  verified: boolean,
  query?: JournalsQuery
): Promise<JournalsResponse> {
  const journals: JournalEntry[] = [];

  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record === undefined || record.type !== "memory" || record.body.kind !== "shard") {
      continue;
    }
    const body = record.body;
    if (!("journal" in body)) {
      continue;
    }
    const journal = body.journal;
    if (journal === undefined) {
      continue;
    }
    if (record.residency === null) {
      continue;
    }

    const parsed = parseResidency(record.residency);
    if (parsed === null) {
      continue;
    }

    journals.push({
      epoch: parsed.epoch,
      door_id: parsed.door_id,
      cid: await computeCid(record),
      journal
    });
  }

  const total = journals.length;
  if (query === undefined) {
    return {
      journals,
      page: 1,
      per_page: total === 0 ? 50 : total,
      total,
      verified
    };
  }

  const page = Math.max(query.page ?? 1, 1);
  const perPage = Math.min(Math.max(query.per_page ?? 50, 1), 200);
  const start = (page - 1) * perPage;
  const slice = start >= total ? [] : journals.slice(start, start + perPage);

  return {
    journals: slice,
    page,
    per_page: perPage,
    total,
    verified
  };
}
