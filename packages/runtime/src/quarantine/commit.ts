import {
  canonicalize,
  corePayload,
  encodePublicKey,
  encodeSignature,
  type SoulStore
} from "@npc/osp-core";

import type { Keyring, SessionSigner } from "../keyring/types.js";
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

/** Door error code for a commit whose epoch's review the Door no longer retains. */
export const REVIEW_NOT_RETAINED = "review_not_retained";

/** Options for {@link commitQuarantinedShards}. */
export type CommitQuarantinedShardsOptions = {
  store: SoulStore;
  keyring: Keyring;
  door: DoorConnection;
  /**
   * The Door that co-signs. Only candidates whose `residency` is
   * `door:<doorId>/epoch:<n>` are considered (no other Door can co-sign them). Each
   * commit request is for that candidate's epoch `n` and is signed with the session key
   * of `(doorId, n)` — the key that authenticated `n`'s cosign review — so candidates of
   * a past epoch can be committed while a later residency is live (`cosign.past_epochs`).
   */
  doorId: string;
  clock: Clock;
  quarantineWindowMs: number;
  /** Journal markdown attached (once) to a residency's first committed shard. */
  journalMarkdown?: string;
  /**
   * Per-residency journal lookup (takes precedence over `journalMarkdown`); `undefined`
   * attaches no journal for that residency. Used by sweeps spanning several epochs.
   */
  journalFor?: (residency: string) => Promise<string | undefined>;
  /**
   * When set, only candidates whose record `residency` equals this string
   * (`door:<door_id>/epoch:<n>`) are considered; candidates from other residencies are
   * neither committed nor reported (e.g. the legacy travel-gap sweep of one epoch).
   */
  residency?: string;
  /** Candidate CIDs to ignore (e.g. already reported stranded by an earlier sweep). */
  skipCids?: ReadonlySet<string>;
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
   * Ripe candidate CIDs the Door can no longer co-sign (`review_not_retained`: never
   * reviewed there, evicted by its retention bound, or lost in a restart). They stay
   * `memory.candidate`; retrying is pointless.
   */
  strandedCids: string[];
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
  const strandedCids: string[] = [];

  /** Session signer per candidate epoch (derived from the soul key for `(doorId, epoch)`). */
  const signers = new Map<number, { signer: SessionSigner; pubkey: string }>();
  const signerFor = (epoch: number): { signer: SessionSigner; pubkey: string } => {
    let entry = signers.get(epoch);
    if (entry === undefined) {
      const signer = options.keyring.deriveSessionKey(options.doorId, epoch);
      entry = { signer, pubkey: encodePublicKey(signer.publicKey) };
      signers.set(epoch, entry);
    }
    return entry;
  };
  /** Residencies that received a journal on a shard during this call. */
  const journalsAttachedThisCall = new Set<string>();
  let journalAttached = false;

  for (const candidate of scan.candidates) {
    const { cid } = candidate;
    if (options.residency !== undefined && candidate.residency !== options.residency) {
      continue;
    }
    const epoch = residencyEpochAtDoor(candidate.residency, options.doorId);
    if (epoch === null || options.skipCids?.has(cid) === true) {
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
    const { signer: sessionSigner, pubkey: sessionPubkeyEncoded } = signerFor(epoch);
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
          epoch,
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
        if (doorErrorCode(error) === REVIEW_NOT_RETAINED) {
          strandedCids.push(cid);
          sealed = true;
          break;
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

  return { committedCids, ripeningCids, skippedCids, strandedCids, journalAttached };
}

/**
 * Epoch `n` of a residency string `door:<doorId>/epoch:<n>` at this Door; `null` for a
 * residency of another Door or a malformed string.
 */
export function residencyEpochAtDoor(residency: string, doorId: string): number | null {
  const prefix = `door:${doorId}/epoch:`;
  if (!residency.startsWith(prefix)) {
    return null;
  }
  const raw = residency.slice(prefix.length);
  if (!/^[1-9]\d*$/u.test(raw)) {
    return null;
  }
  const epoch = Number.parseInt(raw, 10);
  return Number.isSafeInteger(epoch) ? epoch : null;
}

/** Door API `error.code` of `error` or of an error in its `cause` chain, if any. */
function doorErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0 && current.name === "DoorError") {
      return code;
    }
    current = current.cause;
  }
  return undefined;
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
    !scan.residenciesWithJournal.has(candidate.residency) &&
    !journalsAttachedThisCall.has(candidate.residency)
  ) {
    const journalMarkdown =
      options.journalFor !== undefined
        ? await options.journalFor(candidate.residency)
        : options.journalMarkdown;
    if (journalMarkdown !== undefined) {
      const journalBlob = await storeJournalBlob(options.store, journalMarkdown);
      memoryBody.journal_cid = journalBlob.journal_cid;
      memoryBody.journal_hash = journalBlob.journal_hash;
    }
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
