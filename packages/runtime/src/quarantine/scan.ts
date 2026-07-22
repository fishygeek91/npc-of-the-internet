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
    }
  }

  return {
    candidates,
    rejectedCandidateCids,
    committedCandidateCids
  };
}
