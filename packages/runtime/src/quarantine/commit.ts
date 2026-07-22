import {
  OSP_SPEC,
  canonicalize,
  corePayload,
  encodePublicKey,
  encodeSignature,
  type SoulStore
} from "@npc/osp-core";

import type { Keyring } from "../keyring/types.js";
import {
  DOOR_PROTOCOL_VERSION,
  cosignCommitSigningPayload,
  type Clock,
  type CosignRequest,
  type DoorConnection
} from "../session/types.js";
import { QuarantineError } from "./errors.js";
import { isCandidateRipe, scanQuarantineState } from "./scan.js";
import { sealQuarantineRecord } from "./seal.js";
import { shardIdFromText } from "./shard-id.js";

/** Options for {@link commitQuarantinedShards}. */
export type CommitQuarantinedShardsOptions = {
  store: SoulStore;
  keyring: Keyring;
  door: DoorConnection;
  doorId: string;
  epoch: number;
  clock: Clock;
  quarantineWindowMs: number;
  journalMarkdown?: string;
};

/** Result of {@link commitQuarantinedShards}. */
export type CommitQuarantineResult = {
  /** CIDs of newly appended `memory.shard` records. */
  committedCids: string[];
  /** Candidate CIDs still inside the quarantine window. */
  ripeningCids: string[];
  /** Candidate CIDs skipped because rejected or already committed. */
  skippedCids: string[];
  /**
   * True when this call embedded `journalMarkdown` on a newly committed shard.
   * False when the journal was omitted (already on chain for the residency,
   * no eligible commit, or `journalMarkdown` was not provided).
   */
  journalAttached: boolean;
};

/**
 * Promote ripe, unflagged quarantine candidates to committed `memory.shard` records.
 * Idempotent: already-committed or rejected candidates are reported in `skippedCids`.
 *
 * Journal attachment is chain-aware: `journalMarkdown` is embedded on at most one
 * shard per residency (skips if any existing shard for that residency already
 * carries `body.journal`). Pass `journalMarkdown` until a run reports
 * `journalAttached: true`, then stop.
 */
export async function commitQuarantinedShards(
  options: CommitQuarantinedShardsOptions
): Promise<CommitQuarantineResult> {
  const scan = await scanQuarantineState(options.store);
  const committedCids: string[] = [];
  const ripeningCids: string[] = [];
  const skippedCids: string[] = [];

  const sessionSigner = options.keyring.deriveSessionKey(options.doorId, options.epoch);
  const sessionPubkeyEncoded = encodePublicKey(sessionSigner.publicKey);
  /** Residencies that received a journal on a shard during this call. */
  const journalsAttachedThisCall = new Set<string>();
  let journalAttached = false;

  for (const candidate of scan.candidates) {
    const { cid } = candidate;

    if (scan.rejectedCandidateCids.has(cid) || scan.committedCandidateCids.has(cid)) {
      skippedCids.push(cid);
      continue;
    }

    if (!isCandidateRipe(candidate.proposedAt, options.clock.now(), options.quarantineWindowMs)) {
      ripeningCids.push(cid);
      continue;
    }

    const head = await options.store.head();
    if (head === null) {
      throw new QuarantineError("commit: store has no head", "commit_failed");
    }

    const memoryBody: {
      kind: "shard";
      text: string;
      candidate_cid: string;
      distilled_at: string;
      journal?: string;
    } = {
      kind: "shard",
      text: candidate.text,
      candidate_cid: cid,
      // Commit-time stamp; candidates retain the original `proposed_at`.
      distilled_at: options.clock.now()
    };

    const canAttachJournal =
      options.journalMarkdown !== undefined &&
      !scan.residenciesWithJournal.has(candidate.residency) &&
      !journalsAttachedThisCall.has(candidate.residency);

    if (canAttachJournal && options.journalMarkdown !== undefined) {
      memoryBody.journal = options.journalMarkdown;
      journalsAttachedThisCall.add(candidate.residency);
      journalAttached = true;
    }

    const seq = head.seq + 1;
    const prev = head.cid;

    try {
      const core = new TextDecoder().decode(
        canonicalize(
          corePayload({
            spec: OSP_SPEC,
            seq,
            prev,
            type: "memory",
            body: memoryBody,
            residency: candidate.residency
          })
        )
      );

      const unsignedCommit: Omit<Extract<CosignRequest, { phase: "commit" }>, "sig"> = {
        protocol_version: DOOR_PROTOCOL_VERSION,
        phase: "commit",
        door_id: options.doorId,
        epoch: options.epoch,
        session_pubkey: sessionPubkeyEncoded,
        shard_id: shardIdFromText(candidate.text),
        core,
        issued_at: options.clock.now()
      };
      const commitSig = encodeSignature(
        sessionSigner.sign(cosignCommitSigningPayload(unsignedCommit))
      );
      const commitResponse = await options.door.cosign({
        ...unsignedCommit,
        sig: commitSig
      });

      if (commitResponse.phase !== "commit") {
        throw new QuarantineError("unexpected cosign commit response phase", "commit_failed");
      }

      const { record, cid: sealedCid } = await sealQuarantineRecord(options.keyring, {
        seq,
        prev,
        type: "memory",
        body: memoryBody,
        residency: candidate.residency,
        cosigners: [commitResponse.door_cosig]
      });
      await options.store.append(record);
      committedCids.push(sealedCid);
    } catch (error) {
      if (error instanceof QuarantineError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : "unknown error";
      throw new QuarantineError(`commit failed for candidate ${cid}: ${message}`, "commit_failed");
    }
  }

  return { committedCids, ripeningCids, skippedCids, journalAttached };
}
