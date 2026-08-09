import { screenText, type ScreenCategory, type ScreenLogger } from "@npc/immune";
import {
  OSP_SPEC,
  RecordSchema,
  canonicalize,
  computeCid,
  corePayload,
  encodePublicKey,
  encodeSignature,
  soulPayload,
  type CreateRecordFields,
  type OspRecord,
  type SoulStore
} from "@npc/osp-core";

import type { Brain } from "../brain/types.js";
import { BrainError } from "../brain/errors.js";
import { composeSelf } from "../compose/compose-self.js";
import { distillTranscripts } from "../distill/distill-transcripts.js";
import { MemoryTranscriptSource } from "../distill/memory-transcript-source.js";
import type { CandidateShard, TranscriptLine, TranscriptSource } from "../distill/types.js";
import { generateJournal } from "../journal/generate-journal.js";
import { writeJournalFile } from "../journal/write-journal-file.js";
import type { Keyring, SessionSigner } from "../keyring/types.js";
import { SessionError } from "./errors.js";
import {
  DOOR_PROTOCOL_VERSION,
  InboundFrameSchema,
  attestSigningPayload,
  cosignReviewSigningPayload,
  type AttestRequest,
  type Clock,
  type CosignRequest,
  type DoorConnection,
  type HeartbeatRequest,
  type InboundFrame,
  type OutboundFrame,
  type ReviewDecision,
  type Timer
} from "./types.js";

/** Session lifecycle for inbound/heartbeat vs retryable depart. */
type SessionPhase = "live" | "departing" | "departed";

const DEFAULT_HEARTBEAT_INTERVAL_MS = 600_000;
const DEFAULT_MAX_HISTORY_MESSAGES = 40;
const POP_VERSION = "pop/0.1" as const;

const ATTESTATION_KINDS_WITH_EPOCH = ["arrival", "departure", "heartbeat", "travel"] as const;

type AttestationKindWithEpoch = (typeof ATTESTATION_KINDS_WITH_EPOCH)[number];

function isAttestationKindWithEpoch(kind: string): kind is AttestationKindWithEpoch {
  return (ATTESTATION_KINDS_WITH_EPOCH as readonly string[]).includes(kind);
}

/** Configuration for {@link Session.start}. */
export type SessionOptions = {
  store: SoulStore;
  brain: Brain;
  door: DoorConnection;
  keyring: Keyring;
  doorId: string;
  timer: Timer;
  clock: Clock;
  heartbeatIntervalMs?: number;
  maxHistoryMessages?: number;
  doorPublicKeys?: Readonly<Record<string, Uint8Array>>;
  onScreenReject?: ScreenLogger;
};

/** Result of {@link Session.handleInbound}. */
export type HandleInboundResult =
  | { ok: true; outbound: OutboundFrame }
  | { ok: false; error: BrainError }
  | { ok: false; screened: true; categories: readonly ScreenCategory[] };

/** Options for {@link Session.depart}. */
export type DepartOptions = {
  transcript: TranscriptSource;
  journalDir: string;
  /** Brain for distill + journal; defaults to session brain if omitted */
  brain?: Brain;
  toDoorId?: string;
  farewell?: string;
};

/** Result of {@link Session.depart}. */
export type DepartResult = {
  journalPath: string;
  journalMarkdown: string;
  approvedShardIds: string[];
  rejectedShardIds: string[];
  /** CIDs of appended `memory` records with `kind: "candidate"`. */
  candidateCids: string[];
};

type BrainHistoryMessage = {
  role: "user" | "assistant";
  content: string;
};

/**
 * Residency session engine: arrival attestation, heartbeat chain writes,
 * inbound Door messages, and signed outbound replies via the session key.
 */
export class Session {
  private readonly store: SoulStore;
  private readonly brain: Brain;
  private readonly door: DoorConnection;
  private readonly keyring: Keyring;
  private readonly doorId: string;
  private readonly timer: Timer;
  private readonly clock: Clock;
  private readonly heartbeatIntervalMs: number;
  private readonly maxHistoryMessages: number;
  private readonly onScreenReject?: ScreenLogger;
  private readonly sessionSigner: SessionSigner;
  private readonly systemPromptValue: string;
  private readonly residency: string;
  private readonly epochValue: number;
  private readonly sessionPublicKeyValue: Uint8Array;
  private phase: SessionPhase = "live";
  private heartbeatTimerId: unknown = null;
  private heartbeatSeq = 0;
  private outboundCounter = 0;
  private readonly history: BrainHistoryMessage[] = [];
  private appendChain: Promise<unknown> = Promise.resolve();
  private lastHeartbeatErrorValue: unknown = null;
  /** Cached transcript lines after first depart read (file destroyed for privacy). */
  private departTranscriptLines: readonly TranscriptLine[] | null = null;
  /** Cached distill output across depart retries. */
  private departCandidates: CandidateShard[] | null = null;
  /** Immune screen categories observed during the first successful distill. */
  private departScreenCategories: readonly ScreenCategory[] | null = null;
  /** Cached journal across depart retries. */
  private departJournal: { path: string; markdown: string } | null = null;
  /** Cached filtered Door review decisions across depart retries. */
  private departReviewDecisions: ReviewDecision[] | null = null;

  private constructor(
    options: SessionOptions,
    composed: { systemPrompt: string },
    epoch: number,
    sessionSigner: SessionSigner
  ) {
    this.store = options.store;
    this.brain = options.brain;
    this.door = options.door;
    this.keyring = options.keyring;
    this.doorId = options.doorId;
    this.timer = options.timer;
    this.clock = options.clock;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.maxHistoryMessages = options.maxHistoryMessages ?? DEFAULT_MAX_HISTORY_MESSAGES;
    if (options.onScreenReject !== undefined) {
      this.onScreenReject = options.onScreenReject;
    }
    this.systemPromptValue = composed.systemPrompt;
    this.epochValue = epoch;
    this.sessionSigner = sessionSigner;
    this.sessionPublicKeyValue = sessionSigner.publicKey;
    this.residency = `door:${options.doorId}/epoch:${String(epoch)}`;
  }

  /** Global residency epoch for this session. */
  get epoch(): number {
    return this.epochValue;
  }

  /** Derived session public key for this `(door_id, epoch)`. */
  get sessionPublicKey(): Uint8Array {
    return this.sessionPublicKeyValue;
  }

  /** Composed system prompt from the verified soulchain at session start. */
  get systemPrompt(): string {
    return this.systemPromptValue;
  }

  /** Last heartbeat failure, if any (for tests). */
  get lastHeartbeatError(): unknown {
    return this.lastHeartbeatErrorValue;
  }

  /**
   * Begin a residency: compose self, append arrival attestation, arm heartbeat timer.
   */
  static async start(options: SessionOptions): Promise<Session> {
    const doorPublicKeys = options.doorPublicKeys;
    const composed = await composeSelf(options.store, {
      ...(doorPublicKeys === undefined ? {} : { doorPublicKeys })
    });

    const newEpoch = (await scanMaxAttestationEpoch(options.store)) + 1;
    const sessionSigner = options.keyring.deriveSessionKey(options.doorId, newEpoch);
    const sessionPubkeyEncoded = encodePublicKey(sessionSigner.publicKey);
    const at = options.clock.now();

    const arrivalBody = {
      kind: "arrival" as const,
      pop_version: POP_VERSION,
      door_id: options.doorId,
      epoch: newEpoch,
      session_pubkey: sessionPubkeyEncoded,
      at
    };

    const residency = `door:${options.doorId}/epoch:${String(newEpoch)}`;
    const head = await options.store.head();
    if (head === null) {
      throw new SessionError("cannot start session: store has no genesis head");
    }

    const session = new Session(options, composed, newEpoch, sessionSigner);

    await session.enqueueAppend(async () => {
      await session.appendAttestation({
        kind: "arrival",
        body: arrivalBody,
        residency,
        seq: head.seq + 1,
        prev: head.cid,
        signAttest: (unsigned) => {
          const bytes = attestSigningPayload(unsigned);
          return encodeSignature(options.keyring.signWithSoulKey(bytes));
        }
      });
    });

    session.heartbeatTimerId = options.timer.setInterval(() => {
      void session.onHeartbeatTick();
    }, session.heartbeatIntervalMs);

    return session;
  }

  /**
   * Process an inbound Door frame and return a signed outbound reply.
   * Brain failures return `{ ok: false }` without stopping the session.
   */
  async handleInbound(frame: InboundFrame): Promise<HandleInboundResult> {
    if (this.phase !== "live") {
      throw new SessionError("session is not live");
    }

    const parsed = InboundFrameSchema.safeParse(frame);
    if (!parsed.success) {
      throw new SessionError(`invalid inbound frame: ${parsed.error.message}`);
    }
    const validatedFrame = parsed.data;

    if (validatedFrame.door_id !== this.doorId) {
      throw new SessionError(
        `inbound door_id mismatch: expected ${this.doorId}, got ${validatedFrame.door_id}`
      );
    }
    if (validatedFrame.epoch !== this.epochValue) {
      throw new SessionError(
        `inbound epoch mismatch: expected ${String(this.epochValue)}, got ${String(validatedFrame.epoch)}`
      );
    }

    const text = validatedFrame.body.text;
    const screenResult = screenText(text);
    if (!screenResult.ok) {
      for (const category of screenResult.categories) {
        this.onScreenReject?.(category, "session.inbound");
      }
      return { ok: false, screened: true, categories: screenResult.categories };
    }

    const messages = [
      { role: "system" as const, content: this.systemPrompt },
      ...this.history,
      { role: "user" as const, content: text }
    ];

    let assistantText: string;
    try {
      assistantText = await this.brain.complete(messages);
    } catch (error) {
      if (error instanceof BrainError) {
        return { ok: false, error };
      }
      throw error;
    }

    this.pushHistory({ role: "user", content: text });
    this.pushHistory({ role: "assistant", content: assistantText });

    this.outboundCounter += 1;
    const msgId = `out-${String(this.outboundCounter)}`;
    const issuedAt = this.clock.now();

    const unsignedOutbound: Omit<OutboundFrame, "sig"> = {
      type: "outbound",
      door_id: this.doorId,
      epoch: this.epochValue,
      msg_id: msgId,
      issued_at: issuedAt,
      body: {
        text: assistantText,
        ...(validatedFrame.body.reply_to === undefined
          ? {}
          : { reply_to: validatedFrame.body.reply_to }),
        ...(validatedFrame.body.channel_id === undefined
          ? {}
          : { channel_id: validatedFrame.body.channel_id })
      }
    };

    const outboundSig = encodeSignature(this.sessionSigner.sign(canonicalize(unsignedOutbound)));

    return {
      ok: true,
      outbound: {
        ...unsignedOutbound,
        sig: outboundSig
      }
    };
  }

  /**
   * Stop heartbeat timer and reject future inbound frames. Idempotent.
   * Callers ending a residency (e.g. T2.5 depart) MUST `stop()` then `await drainAppends()`
   * before appending departure records so no heartbeat attestation races departure.
   * Leaves the session in `departing` so {@link depart} may retry after a mid-pipeline failure.
   */
  stop(): void {
    if (this.phase !== "live") {
      return;
    }
    this.phase = "departing";
    if (this.heartbeatTimerId !== null) {
      this.timer.clearInterval(this.heartbeatTimerId);
      this.heartbeatTimerId = null;
    }
  }

  /** Wait until all queued chain appends finish (for tests). */
  async drainAppends(): Promise<void> {
    await this.appendChain;
  }

  /**
   * End a residency: distill transcripts, cosign shard review, append quarantine
   * memory records (`rejected` for immune screen drops and host rejections,
   * `candidate` for host-approved shards), then departure and travel attestations.
   *
   * Enters `departing` immediately (stops inbound/heartbeats). Safe to retry after
   * mid-pipeline failure: transcript lines/candidates/journal/review are cached
   * in-process, and already-appended chain records for this residency are skipped.
   *
   * The journal file is always written to disk; it is not embedded on chain until
   * a later commit step promotes candidates to `kind: "shard"`. Departure and
   * travel append even when every shard is rejected.
   */
  async depart(options: DepartOptions): Promise<DepartResult> {
    if (this.phase === "departed") {
      throw new SessionError("session has already departed");
    }
    if (this.phase === "live") {
      this.stop();
      await this.drainAppends();
    }
    // Remaining phase is `departing` (retry after mid-pipeline failure).

    const brain = options.brain ?? this.brain;
    const candidates = await this.ensureDepartCandidates(options.transcript, brain);
    // One rejected record per unique screen category (v0.1: count of drops is not preserved).
    const screenCategories = new Set<ScreenCategory>(this.departScreenCategories ?? []);

    const journal = await this.ensureDepartJournal(brain, candidates, options.journalDir);
    const decisions = await this.ensureDepartReviewDecisions(candidates, options);

    const approvedSet = new Set<string>();
    const rejectedShardIds: string[] = [];
    for (const decision of decisions) {
      if (decision.status === "approved") {
        approvedSet.add(decision.shard_id);
      } else {
        rejectedShardIds.push(decision.shard_id);
      }
    }

    const progress = await this.scanDepartChainProgress();
    const approvedShardIds: string[] = [];

    for (const category of screenCategories) {
      if (progress.screenCategories.has(category)) {
        continue;
      }
      const head = await this.store.head();
      if (head === null) {
        throw new SessionError("depart: store has no head");
      }
      await this.appendMemoryRecord({
        seq: head.seq + 1,
        prev: head.cid,
        body: {
          kind: "rejected",
          category,
          rejected_at: this.clock.now()
        },
        cosigners: []
      });
      progress.screenCategories.add(category);
    }

    // Contract: host_rejected appends are all-or-nothing per residency. A crash
    // mid-batch leaves hasHostRejected true and under-records the rest until a
    // future RejectedBody schema carries per-shard shard_id for individual dedupe.
    if (!progress.hasHostRejected) {
      for (const decision of decisions) {
        if (decision.status !== "rejected") {
          continue;
        }
        const head = await this.store.head();
        if (head === null) {
          throw new SessionError("depart: store has no head");
        }
        await this.appendMemoryRecord({
          seq: head.seq + 1,
          prev: head.cid,
          body: {
            kind: "rejected",
            category: "host_rejected",
            rejected_at: this.clock.now()
          },
          cosigners: []
        });
      }
      if (rejectedShardIds.length > 0) {
        progress.hasHostRejected = true;
      }
    }

    for (const shard of candidates) {
      if (!approvedSet.has(shard.shard_id)) {
        continue;
      }
      approvedShardIds.push(shard.shard_id);

      if (progress.candidateCidsByText.has(shard.text)) {
        continue;
      }

      const head = await this.store.head();
      if (head === null) {
        throw new SessionError("depart: store has no head");
      }

      const { cid } = await this.appendMemoryRecord({
        seq: head.seq + 1,
        prev: head.cid,
        body: {
          kind: "candidate",
          text: shard.text,
          proposed_at: this.clock.now()
        },
        cosigners: []
      });
      progress.candidateCidsByText.set(shard.text, cid);
    }

    const candidateCids: string[] = [];
    for (const shard of candidates) {
      if (!approvedSet.has(shard.shard_id)) {
        continue;
      }
      const cid = progress.candidateCidsByText.get(shard.text);
      if (cid !== undefined) {
        candidateCids.push(cid);
      }
    }

    if (!progress.hasDeparture) {
      const chainHead = await this.store.head();
      if (chainHead === null) {
        throw new SessionError("depart: store has no head before departure");
      }

      const departureBody = {
        kind: "departure" as const,
        pop_version: POP_VERSION,
        door_id: this.doorId,
        epoch: this.epochValue,
        at: this.clock.now()
      };

      await this.appendAttestation({
        kind: "departure",
        body: departureBody,
        residency: this.residency,
        seq: chainHead.seq + 1,
        prev: chainHead.cid,
        signAttest: (unsigned) => {
          const bytes = attestSigningPayload(unsigned);
          return encodeSignature(this.sessionSigner.sign(bytes));
        }
      });
      progress.hasDeparture = true;
    }

    if (!progress.hasTravel) {
      const chainHead = await this.store.head();
      if (chainHead === null) {
        throw new SessionError("depart: store has no head before travel");
      }

      const travelBody: {
        kind: "travel";
        pop_version: typeof POP_VERSION;
        from_door_id: string;
        from_epoch: number;
        at: string;
        to_door_id?: string;
      } = {
        kind: "travel",
        pop_version: POP_VERSION,
        from_door_id: this.doorId,
        from_epoch: this.epochValue,
        at: this.clock.now()
      };
      if (options.toDoorId !== undefined) {
        travelBody.to_door_id = options.toDoorId;
      }

      const { record: travelRecord } = await sealRecord(this.keyring, {
        seq: chainHead.seq + 1,
        prev: chainHead.cid,
        type: "attestation",
        body: travelBody,
        residency: this.residency,
        cosigners: []
      });
      await this.store.append(travelRecord);
    }

    this.phase = "departed";
    this.clearDepartCaches();

    return {
      journalPath: journal.path,
      journalMarkdown: journal.markdown,
      approvedShardIds,
      rejectedShardIds,
      candidateCids
    };
  }

  /**
   * Read+destroy transcript once, then distill (or reuse cached candidates).
   */
  private async ensureDepartCandidates(
    transcript: TranscriptSource,
    brain: Brain
  ): Promise<CandidateShard[]> {
    if (this.departCandidates !== null) {
      return this.departCandidates;
    }

    if (this.departTranscriptLines === null) {
      const lines = await transcript.read();
      await transcript.destroy();
      this.departTranscriptLines = lines;
    }

    const screenCategories = new Set<ScreenCategory>();
    const candidates = await distillTranscripts(
      new MemoryTranscriptSource(this.departTranscriptLines),
      brain,
      {
        onScreenReject: (category) => {
          screenCategories.add(category);
        }
      }
    );
    this.departCandidates = candidates;
    this.departScreenCategories = [...screenCategories];
    return candidates;
  }

  /**
   * Generate and write the journal once; reuse path/markdown on retry.
   */
  private async ensureDepartJournal(
    brain: Brain,
    candidates: readonly CandidateShard[],
    journalDir: string
  ): Promise<{ path: string; markdown: string }> {
    if (this.departJournal !== null) {
      return this.departJournal;
    }

    const shardTexts = candidates.map((shard) => shard.text);
    const markdown = await generateJournal(
      { doorId: this.doorId, epoch: this.epochValue, shardTexts },
      brain
    );
    const path = await writeJournalFile(journalDir, this.doorId, this.epochValue, markdown);
    this.departJournal = { path, markdown };
    return this.departJournal;
  }

  /**
   * Cosign review once; filter/dedupe Door decisions to the proposed shard set.
   * After departure is on chain, reconstruct decisions from candidates vs chain
   * (Door may refuse a second review).
   */
  private async ensureDepartReviewDecisions(
    candidates: readonly CandidateShard[],
    options: DepartOptions
  ): Promise<ReviewDecision[]> {
    if (this.departReviewDecisions !== null) {
      return this.departReviewDecisions;
    }

    const progress = await this.scanDepartChainProgress();
    if (progress.hasDeparture) {
      const reconstructed: ReviewDecision[] = candidates.map((shard) => ({
        shard_id: shard.shard_id,
        status: progress.candidateCidsByText.has(shard.text)
          ? ("approved" as const)
          : ("rejected" as const)
      }));
      this.departReviewDecisions = reconstructed;
      return reconstructed;
    }

    const sessionPubkeyEncoded = encodePublicKey(this.sessionPublicKeyValue);
    const unsignedReview: Omit<Extract<CosignRequest, { phase: "review" }>, "sig"> = {
      protocol_version: DOOR_PROTOCOL_VERSION,
      phase: "review",
      door_id: this.doorId,
      epoch: this.epochValue,
      session_pubkey: sessionPubkeyEncoded,
      shards: [...candidates],
      issued_at: this.clock.now(),
      ...(options.farewell !== undefined ? { farewell: options.farewell } : {})
    };
    const reviewSig = encodeSignature(
      this.sessionSigner.sign(cosignReviewSigningPayload(unsignedReview))
    );
    const reviewResponse = await this.door.cosign({
      ...unsignedReview,
      sig: reviewSig
    });

    if (reviewResponse.phase !== "review") {
      throw new SessionError("unexpected cosign response phase");
    }

    const filtered = filterReviewDecisions(candidates, reviewResponse.decisions);
    this.departReviewDecisions = filtered;
    return filtered;
  }

  /**
   * Scan this residency for depart-stage records already on the soulchain.
   */
  private async scanDepartChainProgress(): Promise<{
    screenCategories: Set<ScreenCategory>;
    hasHostRejected: boolean;
    candidateCidsByText: Map<string, string>;
    hasDeparture: boolean;
    hasTravel: boolean;
  }> {
    const screenCategories = new Set<ScreenCategory>();
    let hasHostRejected = false;
    const candidateCidsByText = new Map<string, string>();
    let hasDeparture = false;
    let hasTravel = false;

    for await (const record of this.store.iterate()) {
      if (record.residency !== this.residency) {
        continue;
      }

      if (record.type === "memory") {
        const body = record.body;
        if (body.kind === "candidate") {
          candidateCidsByText.set(body.text, await computeCid(record));
          continue;
        }
        if (body.kind === "rejected") {
          if (body.category === "host_rejected") {
            hasHostRejected = true;
          } else if (isScreenCategory(body.category)) {
            screenCategories.add(body.category);
          }
        }
        continue;
      }

      if (record.type === "attestation") {
        const body = record.body;
        if (
          body.kind === "departure" &&
          body.door_id === this.doorId &&
          body.epoch === this.epochValue
        ) {
          hasDeparture = true;
        }
        if (
          body.kind === "travel" &&
          body.from_door_id === this.doorId &&
          body.from_epoch === this.epochValue
        ) {
          hasTravel = true;
        }
      }
    }

    return {
      screenCategories,
      hasHostRejected,
      candidateCidsByText,
      hasDeparture,
      hasTravel
    };
  }

  /** Drop in-process depart caches after a successful depart. */
  private clearDepartCaches(): void {
    this.departTranscriptLines = null;
    this.departCandidates = null;
    this.departScreenCategories = null;
    this.departJournal = null;
    this.departReviewDecisions = null;
  }

  private pushHistory(message: BrainHistoryMessage): void {
    this.history.push(message);
    while (this.history.length > this.maxHistoryMessages) {
      this.history.shift();
    }
  }

  private enqueueAppend<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.appendChain.then(fn, fn);
    this.appendChain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async onHeartbeatTick(): Promise<void> {
    if (this.phase !== "live") {
      return;
    }

    try {
      await this.enqueueAppend(async () => {
        await this.runHeartbeat();
      });
      this.lastHeartbeatErrorValue = null;
    } catch (error) {
      this.lastHeartbeatErrorValue = error;
    }
  }

  private async runHeartbeat(): Promise<void> {
    if (this.phase !== "live") {
      return;
    }

    const head = await this.store.head();
    if (head === null) {
      throw new SessionError("heartbeat: store has no head");
    }

    const seq = this.heartbeatSeq + 1;
    const issuedAt = this.clock.now();
    const sessionPubkeyEncoded = encodePublicKey(this.sessionPublicKeyValue);

    const unsignedHeartbeat: Omit<HeartbeatRequest, "sig"> = {
      protocol_version: DOOR_PROTOCOL_VERSION,
      door_id: this.doorId,
      epoch: this.epochValue,
      session_pubkey: sessionPubkeyEncoded,
      seq,
      issued_at: issuedAt
    };
    const heartbeatSig = encodeSignature(this.sessionSigner.sign(canonicalize(unsignedHeartbeat)));

    await this.door.heartbeat({
      ...unsignedHeartbeat,
      sig: heartbeatSig
    });

    this.heartbeatSeq = seq;

    const heartbeatBody = {
      kind: "heartbeat" as const,
      pop_version: POP_VERSION,
      door_id: this.doorId,
      epoch: this.epochValue,
      session_pubkey: sessionPubkeyEncoded,
      at: this.clock.now()
    };

    await this.appendAttestation({
      kind: "heartbeat",
      body: heartbeatBody,
      residency: this.residency,
      seq: head.seq + 1,
      prev: head.cid,
      signAttest: (unsigned) => {
        const bytes = attestSigningPayload(unsigned);
        return encodeSignature(this.sessionSigner.sign(bytes));
      }
    });
  }

  private async appendMemoryRecord(params: {
    seq: number;
    prev: string;
    body: CreateRecordFields["body"];
    cosigners: readonly string[];
  }): Promise<{ cid: string }> {
    const { record, cid } = await sealRecord(this.keyring, {
      seq: params.seq,
      prev: params.prev,
      type: "memory",
      body: params.body,
      residency: this.residency,
      cosigners: [...params.cosigners]
    });
    await this.store.append(record);
    return { cid };
  }

  private async appendAttestation(params: {
    kind: "arrival" | "heartbeat" | "departure";
    body: CreateRecordFields["body"];
    residency: string;
    seq: number;
    prev: string;
    signAttest: (unsigned: Omit<AttestRequest, "sig">) => string;
  }): Promise<void> {
    const core = new TextDecoder().decode(
      canonicalize(
        corePayload({
          spec: OSP_SPEC,
          seq: params.seq,
          prev: params.prev,
          type: "attestation",
          body: params.body,
          residency: params.residency
        })
      )
    );

    const issuedAt = this.clock.now();
    const sessionPubkeyEncoded = encodePublicKey(this.sessionPublicKeyValue);

    const unsignedAttest: Omit<AttestRequest, "sig"> = {
      protocol_version: DOOR_PROTOCOL_VERSION,
      door_id: this.doorId,
      epoch: this.epochValue,
      kind: params.kind,
      core,
      session_pubkey: sessionPubkeyEncoded,
      issued_at: issuedAt
    };

    const attestSig = params.signAttest(unsignedAttest);
    const attestResponse = await this.door.attest({
      ...unsignedAttest,
      sig: attestSig
    });

    const { record } = await sealRecord(this.keyring, {
      seq: params.seq,
      prev: params.prev,
      type: "attestation",
      body: params.body,
      residency: params.residency,
      cosigners: [attestResponse.door_cosig]
    });

    await this.store.append(record);
  }
}

const SCREEN_CATEGORY_VALUES: readonly ScreenCategory[] = [
  "pii.email",
  "pii.phone",
  "pii.handle",
  "injection.instruction",
  "injection.role_marker",
  "injection.url_payload"
];

/**
 * Narrow a rejection category string to a known immune {@link ScreenCategory}.
 */
function isScreenCategory(category: string): category is ScreenCategory {
  return (SCREEN_CATEGORY_VALUES as readonly string[]).includes(category);
}

/**
 * Keep Door review decisions that name a proposed shard_id; first decision wins per id.
 */
function filterReviewDecisions(
  candidates: readonly CandidateShard[],
  decisions: readonly ReviewDecision[]
): ReviewDecision[] {
  const proposedIds = new Set(candidates.map((shard) => shard.shard_id));
  const seen = new Set<string>();
  const filtered: ReviewDecision[] = [];

  for (const decision of decisions) {
    if (!proposedIds.has(decision.shard_id)) {
      continue;
    }
    if (seen.has(decision.shard_id)) {
      continue;
    }
    seen.add(decision.shard_id);
    filtered.push(decision);
  }

  return filtered;
}

/** Scan the chain for the maximum global epoch on attestation records. */
async function scanMaxAttestationEpoch(store: SoulStore): Promise<number> {
  let maxEpoch = 0;

  for await (const record of store.iterate()) {
    const epoch = extractAttestationEpoch(record);
    if (epoch !== null && epoch > maxEpoch) {
      maxEpoch = epoch;
    }
  }

  return maxEpoch;
}

/** Extract a numeric epoch from attestation bodies that carry one. */
function extractAttestationEpoch(record: OspRecord): number | null {
  if (record.type !== "attestation") {
    return null;
  }

  const body = record.body;
  if (!isAttestationKindWithEpoch(body.kind)) {
    return null;
  }

  if (body.kind === "arrival" || body.kind === "departure" || body.kind === "heartbeat") {
    return body.epoch;
  }

  if (body.kind === "travel") {
    return body.from_epoch;
  }

  return null;
}

/** Seal a signed record using the Keyring (never touches raw private keys in Session). */
async function sealRecord(
  keyring: Keyring,
  fields: CreateRecordFields
): Promise<{ record: OspRecord; cid: string }> {
  const sortedCosigners = [...fields.cosigners].sort();

  const soulBytes = canonicalize(
    soulPayload({
      spec: OSP_SPEC,
      seq: fields.seq,
      prev: fields.prev,
      type: fields.type,
      body: fields.body,
      residency: fields.residency,
      cosigners: sortedCosigners
    })
  );
  const soulSignature = encodeSignature(keyring.signWithSoulKey(soulBytes));

  const unsignedRecord = {
    spec: OSP_SPEC,
    seq: fields.seq,
    prev: fields.prev,
    type: fields.type,
    body: fields.body,
    residency: fields.residency,
    cosigners: sortedCosigners,
    sig: soulSignature
  };

  const parsed = RecordSchema.safeParse(unsignedRecord);
  if (!parsed.success) {
    throw new SessionError(`invalid record: ${parsed.error.message}`);
  }

  const record = parsed.data;
  const cid = await computeCid(record);
  return { record, cid };
}
