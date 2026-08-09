import { computeCid, isValidCid, type SoulStore } from "@npc/osp-core";

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
  /** Residencies that already have a committed shard carrying `body.journal`. */
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
 */
export async function scanQuarantineState(store: SoulStore): Promise<QuarantineScan> {
  const candidates: QuarantineCandidate[] = [];
  const rejectedCandidateCids = new Set<string>();
  const committedCandidateCids = new Set<string>();
  const residenciesWithJournal = new Set<string>();

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
      // Ghost writes osp/0.1 inline text; osp/0.2 text_cid candidates resolve in #119 PR2.
      if (!("text" in body)) {
        continue;
      }

      candidates.push({
        cid: await computeCid(record),
        seq: record.seq,
        text: body.text,
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
      if ("journal" in body && body.journal !== undefined && record.residency !== null) {
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
