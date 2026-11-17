import {
  computeCid,
  decodeJournalBlob,
  parseResidency as parseOspResidency,
  type OspRecord
} from "@npc/osp-core";

import { AtlasError } from "./errors.js";

/** Wanderer presence state derived from the latest attestation record. */
export type WandererStatus = "present" | "traveling" | "sleeping";

/** Response shape for `GET /state`. */
export type StateResponse = {
  status: WandererStatus;
  /** Door the Wanderer is at (present only). */
  door_id: string | null;
  epoch: number | null;
  /**
   * When the current status began: start of the uninterrupted stay at `door_id`
   * (present — restarts at the same Door do not reset it), departure / travel time
   * (traveling), or the sleep record's `as_of` (sleeping). Null when unknown.
   */
  since: string | null;
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

/** One journal entry: a `journal` record, or a legacy journal embedded on a shard. */
export type JournalEntry = {
  epoch: number;
  door_id: string;
  cid: string;
  journal: string;
};

/** Query parameters for `GET /journals` and `GET /residencies`. */
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
  "sleep",
  "tombstone"
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
      if (body.kind === "journal") {
        return body.written_at;
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
      // Rejected categories are closed labels (never payload), safe to surface.
      return record.body.kind === "rejected"
        ? `memory/rejected category=${record.body.category}`
        : `memory/${record.body.kind}`;
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
        case "travel": {
          const to = body.to_door_id === undefined ? "" : ` to=${body.to_door_id}`;
          return `attestation/travel from=${body.from_door_id} epoch=${String(body.from_epoch)}${to}`;
        }
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
 * (do not fake presence after the soul has recorded sleep). When present, `since` is
 * the start of the uninterrupted stay at the current Door (see {@link findStaySince});
 * otherwise it is the time of the deciding record.
 */
export function deriveState(records: readonly OspRecord[], verified: boolean): StateResponse {
  const head = records.length > 0 ? records[records.length - 1] : undefined;
  const lastRecordAt = head === undefined ? null : extractRecordTimestamp(head);
  const state = (
    status: WandererStatus,
    doorId: string | null,
    epoch: number | null,
    since: string | null
  ): StateResponse => ({
    status,
    door_id: doorId,
    epoch,
    since,
    last_record_at: lastRecordAt,
    verified
  });

  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record === undefined) {
      continue;
    }

    if (record.type === "sleep") {
      return state("sleeping", null, null, record.body.as_of);
    }

    if (record.type !== "attestation") {
      continue;
    }

    const body = record.body;
    switch (body.kind) {
      case "arrival":
      case "heartbeat":
        return state(
          "present",
          body.door_id,
          body.epoch,
          findStaySince(records, index, body.door_id, body.epoch) ?? body.at
        );
      case "departure":
        return state("traveling", null, body.epoch, body.at);
      case "travel":
        return state("traveling", null, body.from_epoch, body.at);
      case "handover":
        return state("traveling", null, body.depart_epoch, body.at);
    }
  }

  return state("sleeping", null, null, null);
}

/**
 * Start of the uninterrupted stay at `doorId` that includes residency `epoch`.
 *
 * Finds that residency's arrival at or before `fromIndex`, then keeps walking back
 * over earlier arrivals at the same Door: a Door restart supersedes a residency
 * without any departure, and the Wanderer re-arrives at the same Door in a new
 * epoch — that is a restart, not a move. The run stops at a departure, travel,
 * handover or sleep record, or at any attestation for another Door.
 * Returns null when the residency's arrival is not on the chain.
 */
function findStaySince(
  records: readonly OspRecord[],
  fromIndex: number,
  doorId: string,
  epoch: number
): string | null {
  let since: string | null = null;
  for (let index = fromIndex; index >= 0; index -= 1) {
    const record = records[index];
    if (record?.type === "sleep") {
      if (since !== null) {
        break;
      }
      continue;
    }
    if (record?.type !== "attestation") {
      continue;
    }
    const body = record.body;
    if (since === null) {
      // Still looking for the current residency's own arrival.
      if (body.kind === "arrival" && body.door_id === doorId && body.epoch === epoch) {
        since = body.at;
      }
      continue;
    }
    if (body.kind === "arrival" && body.door_id === doorId) {
      since = body.at;
    } else if (body.kind !== "heartbeat" || body.door_id !== doorId) {
      break;
    }
  }
  return since;
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

/** Optional side-blob fetch for osp/0.2 journal_cid resolution. */
export type DeriveJournalsOptions = {
  getSideBlob?: (cid: string) => Promise<Uint8Array>;
};

/** Where a memory record keeps its journal: inline (osp/0.1) or a side blob (osp/0.2). */
type JournalRef = { inline: string } | { blobCid: string };

/**
 * Journal carried by a memory record: a `journal` record (witnessed memory) or a
 * legacy shard with an inline `journal` / `journal_cid`. Null for anything else.
 */
function journalRefOf(record: OspRecord): JournalRef | null {
  if (record.type !== "memory") {
    return null;
  }
  const body = record.body;
  if (body.kind === "journal") {
    return { blobCid: body.journal_cid };
  }
  if (body.kind !== "shard") {
    return null;
  }
  if ("journal" in body && body.journal !== undefined) {
    return { inline: body.journal };
  }
  if ("journal_cid" in body && body.journal_cid !== undefined) {
    return { blobCid: body.journal_cid };
  }
  return null;
}

/** Blob CIDs erased by tombstone records anywhere on the chain. */
function tombstonedBlobs(records: readonly OspRecord[]): Set<string> {
  const erased = new Set<string>();
  for (const record of records) {
    if (record.type === "tombstone") {
      erased.add(record.body.blob_cid);
    }
  }
  return erased;
}

/**
 * Resolve a journal reference to text. Tombstoned or unreadable blobs become
 * `[journal erased]`; a missing resolver becomes `[journal unavailable]`.
 */
async function resolveJournal(
  ref: JournalRef,
  erased: ReadonlySet<string>,
  options: DeriveJournalsOptions | undefined
): Promise<string> {
  if ("inline" in ref) {
    return ref.inline;
  }
  if (erased.has(ref.blobCid)) {
    return "[journal erased]";
  }
  if (options?.getSideBlob === undefined) {
    // Misconfigured Atlas (no blob resolver) — surface a marker so operators
    // can tell this apart from "residency has no journal".
    return "[journal unavailable]";
  }
  try {
    return decodeJournalBlob(await options.getSideBlob(ref.blobCid));
  } catch {
    return "[journal erased]";
  }
}

/** Page newest-first items with HTTP defaults (page 1, per_page 50, max 200). */
function paginate<T>(
  items: readonly T[],
  query: JournalsQuery | undefined
): { items: T[]; page: number; per_page: number; total: number } {
  const total = items.length;
  if (query === undefined) {
    return { items: [...items], page: 1, per_page: total === 0 ? 50 : total, total };
  }
  const page = Math.max(query.page ?? 1, 1);
  const perPage = Math.min(Math.max(query.per_page ?? 50, 1), 200);
  const start = (page - 1) * perPage;
  return {
    items: start >= total ? [] : items.slice(start, start + perPage),
    page,
    per_page: perPage,
    total
  };
}

/**
 * Derive journal entries (newest first) from `journal` records and legacy
 * shard-embedded journals (osp/0.1 inline `journal`, osp/0.2 `journal_cid`).
 * Tombstoned / missing journal blobs become a visible erased marker string.
 *
 * When `query` is omitted (library / static-site callers), returns the full list
 * with `page: 1` and `per_page` equal to `total` (or `50` when `total` is 0).
 * HTTP callers pass query defaults (page 1, per_page 50, max 200) matching `/records`.
 */
export async function deriveJournals(
  records: readonly OspRecord[],
  verified: boolean,
  query?: JournalsQuery,
  options?: DeriveJournalsOptions
): Promise<JournalsResponse> {
  const erased = tombstonedBlobs(records);
  const journals: JournalEntry[] = [];

  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record === undefined || record.residency === null) {
      continue;
    }
    const ref = journalRefOf(record);
    const parsed = ref === null ? null : parseResidency(record.residency);
    if (ref === null || parsed === null) {
      continue;
    }
    journals.push({
      epoch: parsed.epoch,
      door_id: parsed.door_id,
      cid: await computeCid(record),
      journal: await resolveJournal(ref, erased, options)
    });
  }

  const paged = paginate(journals, query);
  return {
    journals: paged.items,
    page: paged.page,
    per_page: paged.per_page,
    total: paged.total,
    verified
  };
}

/** Memory outcomes for one residency. */
export type ResidencyCounts = {
  /** Shards the Door's witness co-signed. */
  witnessed: number;
  /** Shards the Door's witness declined (`rejected`, category `witness_<reason>`). */
  declined: number;
  /** Material dropped by the Wanderer's own immune screen (any other `rejected`). */
  screened: number;
};

/** How a residency ended (see {@link ResidencyEntry.ended}). */
export type ResidencyEnd = "departed" | "superseded";

/** One residency (a stay at one Door for one epoch), for `GET /residencies`. */
export type ResidencyEntry = {
  residency: string;
  door_id: string;
  epoch: number;
  arrived_at: string | null;
  departed_at: string | null;
  /** Door named by the travel (or handover) record that ended this residency. */
  traveled_to: string | null;
  /**
   * How the residency ended: `departed` (departure / travel / handover record),
   * `superseded` (a later arrival anywhere closed it with no such record — e.g. the
   * Door restarted and the Wanderer re-arrived), or `null` while still open.
   */
  ended: ResidencyEnd | null;
  counts: ResidencyCounts;
  /** Distinct witness decline reasons in chain order (e.g. `["private"]`). */
  declined_reasons: string[];
  /** The residency's journal (record CID + text), or null when none was written. */
  journal: { cid: string; journal: string } | null;
};

/** Response shape for `GET /residencies` (newest first). */
export type ResidenciesResponse = {
  residencies: ResidencyEntry[];
  page: number;
  per_page: number;
  total: number;
  verified: boolean;
};

/** Category prefix for memories the Door's witness declined (records.md §rejected). */
export const WITNESS_CATEGORY_PREFIX = "witness_";

/**
 * Derive one entry per residency (newest first) from the residency field of every
 * record: arrival / departure / travel times, witnessed / declined / screened memory
 * counts, and the residency's journal (the `journal` record, else the last legacy
 * shard-embedded journal). Pagination follows {@link deriveJournals}.
 *
 * The Wanderer is in one place at a time, so an arrival closes every earlier
 * residency that is still open: `departed_at` becomes that arrival's `at` and
 * `ended` becomes `superseded`. An explicit departure / travel / handover marks
 * `ended: "departed"`.
 */
export async function deriveResidencies(
  records: readonly OspRecord[],
  verified: boolean,
  query?: JournalsQuery,
  options?: DeriveJournalsOptions
): Promise<ResidenciesResponse> {
  const byResidency = new Map<string, { entry: ResidencyEntry; journal: OspRecord | null }>();

  for (const record of records) {
    if (record.residency === null) {
      continue;
    }
    let slot = byResidency.get(record.residency);
    if (slot === undefined) {
      const parsed = parseResidency(record.residency);
      if (parsed === null) {
        continue;
      }
      slot = {
        entry: {
          residency: record.residency,
          door_id: parsed.door_id,
          epoch: parsed.epoch,
          arrived_at: null,
          departed_at: null,
          traveled_to: null,
          ended: null,
          counts: { witnessed: 0, declined: 0, screened: 0 },
          declined_reasons: [],
          journal: null
        },
        journal: null
      };
      byResidency.set(record.residency, slot);
    }
    const entry = slot.entry;

    if (journalRefOf(record) !== null) {
      slot.journal = record;
    }
    if (record.type === "memory") {
      const body = record.body;
      if (body.kind === "shard") {
        entry.counts.witnessed += 1;
      } else if (body.kind === "rejected") {
        if (body.category.startsWith(WITNESS_CATEGORY_PREFIX)) {
          entry.counts.declined += 1;
          const reason = body.category.slice(WITNESS_CATEGORY_PREFIX.length);
          if (!entry.declined_reasons.includes(reason)) {
            entry.declined_reasons.push(reason);
          }
        } else {
          entry.counts.screened += 1;
        }
      }
    } else if (record.type === "attestation") {
      const body = record.body;
      switch (body.kind) {
        case "arrival":
          entry.arrived_at ??= body.at;
          for (const other of byResidency.values()) {
            if (other.entry !== entry && other.entry.ended === null) {
              other.entry.departed_at = body.at;
              other.entry.ended = "superseded";
            }
          }
          break;
        case "departure":
          entry.departed_at = body.at;
          entry.ended = "departed";
          break;
        case "travel":
          entry.departed_at ??= body.at;
          entry.traveled_to = body.to_door_id ?? null;
          entry.ended = "departed";
          break;
        case "handover":
          entry.departed_at ??= body.at;
          entry.traveled_to = body.arrive_door_id;
          entry.ended = "departed";
          break;
        case "heartbeat":
          break;
      }
    }
  }

  const erased = tombstonedBlobs(records);
  const residencies: ResidencyEntry[] = [];
  for (const { entry, journal } of [...byResidency.values()].reverse()) {
    const ref = journal === null ? null : journalRefOf(journal);
    if (journal !== null && ref !== null) {
      entry.journal = {
        cid: await computeCid(journal),
        journal: await resolveJournal(ref, erased, options)
      };
    }
    residencies.push(entry);
  }

  const paged = paginate(residencies, query);
  return {
    residencies: paged.items,
    page: paged.page,
    per_page: paged.per_page,
    total: paged.total,
    verified
  };
}
