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
import type { TranscriptSource } from "../distill/types.js";
import { generateJournal } from "../journal/generate-journal.js";
import { writeJournalFile } from "../journal/write-journal-file.js";
import type { Keyring, SessionSigner } from "../keyring/types.js";
import { SessionError } from "./errors.js";
import {
  DOOR_PROTOCOL_VERSION,
  InboundFrameSchema,
  attestSigningPayload,
  cosignCommitSigningPayload,
  cosignReviewSigningPayload,
  type AttestRequest,
  type Clock,
  type CosignRequest,
  type DoorConnection,
  type HeartbeatRequest,
  type InboundFrame,
  type OutboundFrame,
  type Timer
} from "./types.js";

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
  doorPublicKeys?: readonly Uint8Array[];
};

/** Result of {@link Session.handleInbound}. */
export type HandleInboundResult =
  { ok: true; outbound: OutboundFrame } | { ok: false; error: BrainError };

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
  private readonly sessionSigner: SessionSigner;
  private readonly systemPromptValue: string;
  private readonly residency: string;
  private readonly epochValue: number;
  private readonly sessionPublicKeyValue: Uint8Array;
  private live = true;
  private heartbeatTimerId: unknown = null;
  private heartbeatSeq = 0;
  private outboundCounter = 0;
  private readonly history: BrainHistoryMessage[] = [];
  private appendChain: Promise<unknown> = Promise.resolve();
  private lastHeartbeatErrorValue: unknown = null;

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
    if (!this.live) {
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

    // T3.1: immune screen hook
    const text = validatedFrame.body.text;

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
   */
  stop(): void {
    if (!this.live) {
      return;
    }
    this.live = false;
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
   * End a residency: distill transcripts, cosign memory shards, append departure
   * and travel attestations. Stops the session first; session remains not-live.
   *
   * If the host rejects every shard, the journal file is still written but never
   * reaches the chain (no memory record to carry `body.journal`); departure and
   * travel still append. Revisit with quarantine in T3.2.
   */
  async depart(options: DepartOptions): Promise<DepartResult> {
    if (!this.live) {
      throw new SessionError("session is not live");
    }

    this.stop();
    await this.drainAppends();

    const brain = options.brain ?? this.brain;
    const candidates = await distillTranscripts(options.transcript, brain);
    const shardTexts = candidates.map((shard) => shard.text);

    const journalMarkdown = await generateJournal(
      { doorId: this.doorId, epoch: this.epochValue, shardTexts },
      brain
    );
    const journalPath = await writeJournalFile(
      options.journalDir,
      this.doorId,
      this.epochValue,
      journalMarkdown
    );

    const sessionPubkeyEncoded = encodePublicKey(this.sessionPublicKeyValue);
    const unsignedReview: Omit<Extract<CosignRequest, { phase: "review" }>, "sig"> = {
      protocol_version: DOOR_PROTOCOL_VERSION,
      phase: "review",
      door_id: this.doorId,
      epoch: this.epochValue,
      session_pubkey: sessionPubkeyEncoded,
      shards: candidates,
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

    const approvedSet = new Set<string>();
    const rejectedShardIds: string[] = [];
    for (const decision of reviewResponse.decisions) {
      if (decision.status === "approved") {
        approvedSet.add(decision.shard_id);
      } else {
        rejectedShardIds.push(decision.shard_id);
      }
    }

    const approvedShardIds: string[] = [];
    let isFirstApproved = true;

    for (const shard of candidates) {
      if (!approvedSet.has(shard.shard_id)) {
        continue;
      }
      approvedShardIds.push(shard.shard_id);

      const head = await this.store.head();
      if (head === null) {
        throw new SessionError("depart: store has no head");
      }

      const memoryBody: {
        kind: "shard";
        text: string;
        distilled_at: string;
        journal?: string;
      } = {
        kind: "shard",
        text: shard.text,
        distilled_at: this.clock.now()
      };
      if (isFirstApproved) {
        memoryBody.journal = journalMarkdown;
        isFirstApproved = false;
      }

      const seq = head.seq + 1;
      const prev = head.cid;

      const core = new TextDecoder().decode(
        canonicalize(
          corePayload({
            spec: OSP_SPEC,
            seq,
            prev,
            type: "memory",
            body: memoryBody,
            residency: this.residency
          })
        )
      );

      const unsignedCommit: Omit<Extract<CosignRequest, { phase: "commit" }>, "sig"> = {
        protocol_version: DOOR_PROTOCOL_VERSION,
        phase: "commit",
        door_id: this.doorId,
        epoch: this.epochValue,
        session_pubkey: sessionPubkeyEncoded,
        shard_id: shard.shard_id,
        core,
        issued_at: this.clock.now()
      };
      const commitSig = encodeSignature(
        this.sessionSigner.sign(cosignCommitSigningPayload(unsignedCommit))
      );
      const commitResponse = await this.door.cosign({
        ...unsignedCommit,
        sig: commitSig
      });

      if (commitResponse.phase !== "commit") {
        throw new SessionError("unexpected cosign commit response phase");
      }

      const { record } = await sealRecord(this.keyring, {
        seq,
        prev,
        type: "memory",
        body: memoryBody,
        residency: this.residency,
        cosigners: [commitResponse.door_cosig]
      });
      await this.store.append(record);
    }

    let chainHead = await this.store.head();
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

    chainHead = await this.store.head();
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

    return {
      journalPath,
      journalMarkdown,
      approvedShardIds,
      rejectedShardIds
    };
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
    if (!this.live) {
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
    if (!this.live) {
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
