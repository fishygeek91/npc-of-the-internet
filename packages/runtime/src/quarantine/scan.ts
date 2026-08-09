import { computeCid, decodeShardTextBlob, isValidCid, type SoulStore } from "@npc/osp-core";

import { QuarantineError } from "./errors.js";

/** One quarantine candidate memory record discovered on the soulchain. */
export type QuarantineCandidate = {
  cid: string;
  seq: number;
  text: string;
  proposedAt: string;
  residency: string;
};

/** Snapshot of quarantine-related memory records on the soulchain. */
export type QuarantineScan = {
  candidates: QuarantineCandidate[];
  rejectedCandidateCids: ReadonlySet<string>;
  committedCandidateCids: ReadonlySet<string>;
  /**
   * Residencies that already have a committed shard carrying an inline `journal`
   * or osp/0.2 `journal_cid` reference.
   */
  residenciesWithJournal: ReadonlySet<string>;
};

function parseIsoToMs(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    throw new QuarantineError(`unparseable ISO timestamp: ${iso}`, "invalid_timestamp");
  }
  return ms;
}

function assertValidCandidateCid(cid: string, context: string): void {
  if (!isValidCid(cid)) {
    throw new QuarantineError(`${context}: invalid candidate CID ${cid}`, "invalid_cid");
  }
}

/**
 * Return true when a candidate has aged through the full quarantine window.
 */
export function isCandidateRipe(
  proposedAt: string,
  nowIso: string,
  quarantineWindowMs: number
): boolean {
  const proposedMs = parseIsoToMs(proposedAt);
  const nowMs = parseIsoToMs(nowIso);
  return nowMs - proposedMs >= quarantineWindowMs;
}

/**
 * Scan the soulchain for quarantine candidates and lifecycle cross-references.
 * Candidates are returned in ascending `seq` order.
 *
 * Tombstoned (or otherwise erased) candidate text blobs are skipped — a committed
 * shard and its candidate share a content-addressed blob, so erasure of the shard
 * prose must not brick every subsequent scan.
 */
export async function scanQuarantineState(store: SoulStore): Promise<QuarantineScan> {
  const candidates: QuarantineCandidate[] = [];
  const rejectedCandidateCids = new Set<string>();
  const committedCandidateCids = new Set<string>();
  const residenciesWithJournal = new Set<string>();
  const tombstonedBlobCids = new Set<string>();

  // First pass: tombstones (erased blob CIDs) so candidate resolution can skip them.
  for await (const record of store.iterate()) {
    if (record.type === "tombstone") {
      tombstonedBlobCids.add(record.body.blob_cid);
    }
  }

  for await (const record of store.iterate()) {
    if (record.type !== "memory") {
      continue;
    }

    const body = record.body;
    if (body.kind === "candidate") {
      if (record.residency === null) {
        throw new QuarantineError(
          `memory candidate at seq ${String(record.seq)} has null residency`,
          "invalid_record"
        );
      }

      let text: string;
      if ("text" in body) {
        text = body.text;
      } else if ("text_cid" in body) {
        if (tombstonedBlobCids.has(body.text_cid)) {
          // Prose erased (often via the committed shard that shares this CID) — skip.
          continue;
        }
        try {
          text = decodeShardTextBlob(await store.getSideBlob(body.text_cid));
        } catch (error) {
          const message = error instanceof Error ? error.message : "unknown error";
          throw new QuarantineError(
            `memory candidate at seq ${String(record.seq)}: cannot resolve text blob: ${message}`,
            "invalid_record"
          );
        }
      } else {
        throw new QuarantineError(
          `memory candidate at seq ${String(record.seq)} has neither text nor text_cid`,
          "invalid_record"
        );
      }

      candidates.push({
        cid: await computeCid(record),
        seq: record.seq,
        text,
        proposedAt: body.proposed_at,
        residency: record.residency
      });
      continue;
    }

    if (body.kind === "rejected") {
      const candidateCid = body.candidate_cid;
      if (candidateCid !== undefined) {
        assertValidCandidateCid(candidateCid, `rejected record at seq ${String(record.seq)}`);
        rejectedCandidateCids.add(candidateCid);
      }
      continue;
    }

    if (body.kind === "shard") {
      const candidateCid = body.candidate_cid;
      if (candidateCid !== undefined) {
        assertValidCandidateCid(candidateCid, `shard record at seq ${String(record.seq)}`);
        committedCandidateCids.add(candidateCid);
      }
      const hasInlineJournal = "journal" in body && body.journal !== undefined;
      const hasJournalCid = "journal_cid" in body && body.journal_cid !== undefined;
      if ((hasInlineJournal || hasJournalCid) && record.residency !== null) {
        residenciesWithJournal.add(record.residency);
      }
    }
  }

  return {
    candidates,
    rejectedCandidateCids,
    committedCandidateCids,
    residenciesWithJournal
  };
}

/**
 * Collect `candidate_cid` values from `memory.rejected` records with `seq > fromSeqExclusive`.
 * Used by commit to detect flags appended after the pre-loop quarantine scan.
 */
export async function scanRejectedCandidateCidsSince(
  store: SoulStore,
  fromSeqExclusive: number
): Promise<ReadonlySet<string>> {
  const rejectedCandidateCids = new Set<string>();

  for await (const record of store.iterate()) {
    if (record.seq <= fromSeqExclusive) {
      continue;
    }
    if (record.type !== "memory") {
      continue;
    }
    const body = record.body;
    if (body.kind !== "rejected") {
      continue;
    }
    const candidateCid = body.candidate_cid;
    if (candidateCid !== undefined) {
      assertValidCandidateCid(candidateCid, `rejected record at seq ${String(record.seq)}`);
      rejectedCandidateCids.add(candidateCid);
    }
  }

  return rejectedCandidateCids;
}
