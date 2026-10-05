import {
  canonicalize,
  corePayload,
  encodePublicKey,
  encodeSignature,
  type SoulStore
} from "@npc/osp-core";

import type { Keyring } from "../keyring/types.js";
import { storeJournalBlob, storeShardTextBlob } from "../memory-side-blobs.js";
import { assertRuntimeWritableChain, RUNTIME_OSP_SPEC } from "../osp-spec.js";
import {
  DOOR_PROTOCOL_VERSION,
  cosignCommitSigningPayload,
  type Clock,
  type CosignRequest,
  type DoorConnection
} from "../session/types.js";
import { QuarantineError } from "./errors.js";
import { isCandidateRipe, scanQuarantineState, scanRejectedCandidateCidsSince } from "./scan.js";
import { sealQuarantineRecord } from "./seal.js";
import { shardIdFromText } from "./shard-id.js";

type ShardMemoryBody = {
  kind: "shard";
  text_cid: string;
  text_hash: string;
  candidate_cid: string;
  distilled_at: string;
  journal_cid?: string;
  journal_hash?: string;
};

/** A commit envelope prepared for one chain position (reused verbatim on retry). */
type PreparedCommit = { seq: number; core: string; memoryBody: ShardMemoryBody };

/**
 * Prepared commit envelopes per store, keyed by `(candidate cid, seq, prev)`. A retry at
 * the same chain position (e.g. the Door co-signed but the reply was lost) re-sends the
 * byte-identical `core` — same `distilled_at`, same journal refs — so the Door's
 * idempotent same-seq retry returns the same `door_cosig` instead of `shard_not_approved`.
 * Entries are dropped once sealed or once the head moves past their `seq`. In-memory only:
 * after a process restart the core is rebuilt with a new `distilled_at`, which the Door
 * refuses for an already co-signed position (`shard_not_approved`) until the head moves.
 */
const preparedCommits = new WeakMap<SoulStore, Map<string, PreparedCommit>>();

function preparedCommitKey(candidateCid: string, seq: number, prev: string): string {
  return `${candidateCid}\u0000${String(seq)}\u0000${prev}`;
}

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
  /**
   * When set, only candidates whose record `residency` equals this string
   * (`door:<door_id>/epoch:<n>`) are considered; candidates from other residencies are
   * neither committed nor reported. The Door co-signs commits only for the epoch whose
   * review it holds, so the residency daemon scopes each sweep to the departed epoch —
   * otherwise one stranded older candidate would fail the whole sweep.
   */
  residency?: string;
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
 * Journal attachment is chain-aware: journal side-blob refs are attached on at most
 * one shard per residency. Pass `journalMarkdown` until a run reports
 * `journalAttached: true`, then stop.
 */
export async function commitQuarantinedShards(
  options: CommitQuarantinedShardsOptions
): Promise<CommitQuarantineResult> {
  await assertRuntimeWritableChain(options.store);

  // Capture baseline BEFORE the scan so a flag landing during/after iterate is
  // still visible to scanRejectedCandidateCidsSince (seq > scanHeadSeq).
  const scanHead = await options.store.head();
  const scanHeadSeq = scanHead?.seq ?? -1;
  const prepared = preparedCommits.get(options.store) ?? new Map<string, PreparedCommit>();
  preparedCommits.set(options.store, prepared);
  for (const [key, entry] of prepared) {
    if (entry.seq <= scanHeadSeq) {
      prepared.delete(key);
    }
  }
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
    if (options.residency !== undefined && candidate.residency !== options.residency) {
      continue;
    }

    if (scan.rejectedCandidateCids.has(cid) || scan.committedCandidateCids.has(cid)) {
      skippedCids.push(cid);
      continue;
    }

    if (!isCandidateRipe(candidate.proposedAt, options.clock.now(), options.quarantineWindowMs)) {
      ripeningCids.push(cid);
      continue;
    }

    // Retry when another append (e.g. mid-loop flag) moves head after Door cosign.
    const maxHeadRetries = 8;
    let sealed = false;
    for (let attempt = 0; attempt < maxHeadRetries; attempt += 1) {
      // TOCTOU: a flag may land after the pre-loop scan (Door round-trips take time).
      const rejectedSince = await scanRejectedCandidateCidsSince(options.store, scanHeadSeq);
      if (rejectedSince.has(cid) || scan.rejectedCandidateCids.has(cid)) {
        skippedCids.push(cid);
        sealed = true;
        break;
      }

      const head = await options.store.head();
      if (head === null) {
        throw new QuarantineError("commit: store has no head", "commit_failed");
      }

      const seq = head.seq + 1;
      const prev = head.cid;
      const preparedKey = preparedCommitKey(cid, seq, prev);

      try {
        const { core, memoryBody } =
          prepared.get(preparedKey) ??
          (await prepareCommit(options, candidate, cid, seq, prev, journalsAttachedThisCall, scan));
        prepared.set(preparedKey, { seq, core, memoryBody });
        const attachesJournal = memoryBody.journal_cid !== undefined;

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

        // Re-check immediately before seal: flag may have landed during Door cosign.
        const rejectedSinceBeforeSeal = await scanRejectedCandidateCidsSince(
          options.store,
          scanHeadSeq
        );
        if (rejectedSinceBeforeSeal.has(cid) || scan.rejectedCandidateCids.has(cid)) {
          skippedCids.push(cid);
          sealed = true;
          break;
        }

        const headAfterCosign = await options.store.head();
        if (headAfterCosign === null || headAfterCosign.cid !== prev) {
          // Head moved (e.g. another candidate was flagged); rebind and retry cosign.
          continue;
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
        prepared.delete(preparedKey);
        committedCids.push(sealedCid);
        if (attachesJournal) {
          journalsAttachedThisCall.add(candidate.residency);
          journalAttached = true;
        }
        sealed = true;
        break;
      } catch (error) {
        if (error instanceof QuarantineError) {
          throw error;
        }
        const message = error instanceof Error ? error.message : "unknown error";
        throw new QuarantineError(
          `commit failed for candidate ${cid}: ${message}`,
          "commit_failed"
        );
      }
    }

    if (!sealed) {
      throw new QuarantineError(
        `commit failed for candidate ${cid}: head kept moving during cosign`,
        "commit_failed"
      );
    }
  }

  return { committedCids, ripeningCids, skippedCids, journalAttached };
}

/**
 * Build the unsigned `memory.shard` envelope `core` for `candidate` at `(seq, prev)`,
 * storing its side blobs. `distilled_at` is the commit-time stamp (candidates retain the
 * original `proposed_at`); the journal is attached on at most one shard per residency.
 */
async function prepareCommit(
  options: CommitQuarantinedShardsOptions,
  candidate: { text: string; residency: string },
  cid: string,
  seq: number,
  prev: string,
  journalsAttachedThisCall: ReadonlySet<string>,
  scan: { residenciesWithJournal: ReadonlySet<string> }
): Promise<PreparedCommit> {
  const textBlob = await storeShardTextBlob(options.store, candidate.text);
  const memoryBody: ShardMemoryBody = {
    kind: "shard",
    text_cid: textBlob.text_cid,
    text_hash: textBlob.text_hash,
    candidate_cid: cid,
    distilled_at: options.clock.now()
  };

  if (
    options.journalMarkdown !== undefined &&
    !scan.residenciesWithJournal.has(candidate.residency) &&
    !journalsAttachedThisCall.has(candidate.residency)
  ) {
    const journalBlob = await storeJournalBlob(options.store, options.journalMarkdown);
    memoryBody.journal_cid = journalBlob.journal_cid;
    memoryBody.journal_hash = journalBlob.journal_hash;
  }

  const core = new TextDecoder().decode(
    canonicalize(
      corePayload({
        spec: RUNTIME_OSP_SPEC,
        seq,
        prev,
        type: "memory",
        body: memoryBody,
        residency: candidate.residency
      })
    )
  );
  return { seq, core, memoryBody };
}
