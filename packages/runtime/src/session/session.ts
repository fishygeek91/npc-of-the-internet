import { screenText, type ScreenCategory, type ScreenLogger } from "@npc/immune";
import { DoorError, MEMORY_ATTEST_TEXT_MAX, WitnessReasonSchema } from "@npc/door-sdk";
import {
  OSP_SPEC_V02,
  RecordSchema,
  canonicalize,
  computeCid,
  corePayload,
  decodeShardTextBlob,
  encodePublicKey,
  encodeSignature,
  soulPayload,
  type CreateRecordFields,
  type OspRecord,
  type SoulStore
} from "@npc/osp-core";

import {
  DEFAULT_ATTENTION_POLICY,
  isAddressed,
  resolveAttention,
  type AttentionNote,
  type AttentionPolicy
} from "../attention/decision.js";
import { RoomLog, type RoomEntry } from "../attention/room-log.js";
import type { Brain, BrainMessage } from "../brain/types.js";
import { BrainError } from "../brain/errors.js";
import { composeSelf } from "../compose/compose-self.js";
import { assertRuntimeWritableChain } from "../osp-spec.js";
import { distillTranscripts } from "../distill/distill-transcripts.js";
import { DistillError } from "../distill/errors.js";
import { MemoryTranscriptSource } from "../distill/memory-transcript-source.js";
import type { ResidencyTranscript } from "../distill/residency-transcript.js";
import type { TranscriptLine, TranscriptSource } from "../distill/types.js";
import { generateJournal } from "../journal/generate-journal.js";
import { writeJournalFile } from "../journal/write-journal-file.js";
import type { Keyring, SessionSigner } from "../keyring/types.js";
import {
  addressJournalBlob,
  addressShardTextBlob,
  putAddressedBlob
} from "../memory-side-blobs.js";
import {
  ATTENTION_REACTIONS_OFF,
  ATTENTION_REACTIONS_ON,
  ATTENTION_SYSTEM,
  ATTENTION_USER_TEMPLATE
} from "../prompts/attention/system.js";
import { SessionError } from "./errors.js";
import {
  DOOR_PROTOCOL_VERSION,
  InboundFrameSchema,
  attestSigningPayload,
  type AttestRequest,
  type Clock,
  type DoorConnection,
  type HeartbeatRequest,
  type InboundFrame,
  type OutboundFrame,
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

/** Where a heartbeat failure occurred (Door call vs soulchain append). */
export type HeartbeatErrorStage = "door" | "append";

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
  /**
   * Door `hello.active_epoch` floor for crash recovery. When set, the next
   * arrival epoch is `max(chainDerivedEpoch, activeEpoch + 1)`.
   */
  activeEpoch?: number | null;
  /** Called when a heartbeat Door call or chain append fails (production logging). */
  onHeartbeatError?: (error: unknown, stage: HeartbeatErrorStage) => void;
  /** Optional callback after a successful depart (e.g. replication manifest cadence). */
  onDeparted?: () => void;
  /**
   * Live in-memory residency transcript (WHITEPAPER §3.2). When set, every screened
   * inbound message and every spoken reply is recorded, and {@link Session.depart}
   * distills from it when `DepartOptions.transcript` is omitted. Never persisted.
   */
  transcript?: ResidencyTranscript;
  /** Selective-attention tuning for {@link Session.observe}; defaults apply per field. */
  attention?: Partial<AttentionPolicy>;
  /**
   * The Door advertised `attest.memory` in `hello`: it witnesses memories, so depart may
   * form them. Default `false` — no memories are formed at a Door that does not witness.
   */
  witnessesMemories?: boolean;
};

/** Result of {@link Session.handleInbound}. */
export type HandleInboundResult =
  | { ok: true; outbound: OutboundFrame }
  | { ok: false; error: BrainError }
  | { ok: false; screened: true; categories: readonly ScreenCategory[] };

/**
 * Result of {@link Session.observe} (selective attention).
 *
 * - `acted`: the Wanderer spoke and/or reacted; deliver `outbound`.
 * - `silent`: it read the batch and chose (or was guarded into) silence.
 * - `coalesced`: this message was folded into another in-flight decision.
 * - `screened`: the immune screen dropped the message (never enters the room log).
 * - `error`: the Brain failed; the batch is treated as read.
 */
export type ObserveResult =
  | {
      kind: "acted";
      outbound: OutboundFrame;
      spoke: boolean;
      reacted: boolean;
      batchSize: number;
      notes: readonly AttentionNote[];
    }
  | { kind: "silent"; batchSize: number; notes: readonly AttentionNote[] }
  | { kind: "coalesced" }
  | { kind: "screened"; categories: readonly ScreenCategory[] }
  | { kind: "error"; error: BrainError };

/** Options for {@link Session.depart}. */
export type DepartOptions = {
  /** Defaults to the Session's live {@link SessionOptions.transcript} when omitted. */
  transcript?: TranscriptSource;
  journalDir: string;
  /** Brain for distill + journal; defaults to session brain if omitted */
  brain?: Brain;
  /** Next Door, recorded as the travel attestation's `to_door_id`. */
  toDoorId?: string;
  /**
   * A stay with fewer transcript lines forms no memories (no distill call). Default
   * {@link DEFAULT_MIN_MEMORY_LINES}; operator-requested departs pass 1.
   */
  minMemoryLines?: number;
};

/** Default {@link DepartOptions.minMemoryLines}. */
export const DEFAULT_MIN_MEMORY_LINES = 10;

/** Result of {@link Session.depart} (counts cover the whole residency, retries included). */
export type DepartResult = {
  /** Witnessed `shard` records on chain for this residency. */
  witnessed: number;
  /** `rejected` records with a `witness_<reason>` category (declined shards and journal). */
  declined: number;
  /** `rejected` records for immune-screen categories. */
  screened: number;
  /** Journal file written under `journalDir`, or `null` when no journal was witnessed. */
  journalPath: string | null;
};

/** What this residency already has on chain (depart retry dedupe). */
type DepartProgress = {
  screenCategories: Set<ScreenCategory>;
  /** Decoded texts of witnessed shards, in chain order. */
  shardTexts: Set<string>;
  hasJournal: boolean;
  declined: number;
  hasDeparture: boolean;
  hasTravel: boolean;
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
  private readonly onHeartbeatError?: (error: unknown, stage: HeartbeatErrorStage) => void;
  private readonly onDeparted?: () => void;
  private readonly liveTranscript?: ResidencyTranscript;
  private readonly attentionPolicy: AttentionPolicy;
  private readonly roomLog: RoomLog;
  /**
   * Room entries observed but not yet covered by an attention decision. Captured at observe
   * time (not re-resolved from the bounded log) so a burst that evicts them from the room
   * log during a Brain call cannot drop them, or their `addressed` flag, from the batch.
   */
  private pendingEntries: RoomEntry[] = [];
  private readonly sessionSigner: SessionSigner;
  private readonly systemPromptValue: string;
  private readonly residency: string;
  private readonly epochValue: number;
  private readonly sessionPublicKeyValue: Uint8Array;
  private readonly witnessesMemories: boolean;
  private phase: SessionPhase = "live";
  private heartbeatTimerId: unknown = null;
  private heartbeatSeq = 0;
  private outboundCounter = 0;
  private readonly history: BrainHistoryMessage[] = [];
  private appendChain: Promise<unknown> = Promise.resolve();
  private inboundChain: Promise<unknown> = Promise.resolve();
  private lastHeartbeatErrorValue: unknown = null;
  /** Cached transcript lines after first depart read (live transcript destroyed for privacy). */
  private departTranscriptLines: readonly TranscriptLine[] | null = null;
  /** Cached distill output (shard texts) across depart retries. */
  private departCandidates: readonly string[] | null = null;
  /** Immune screen categories observed during the one distill. */
  private departScreenCategories: readonly ScreenCategory[] = [];
  /** Shard texts the Door already witnessed or declined in this process. */
  private readonly departDecidedTexts = new Set<string>();
  /** Journal markdown generated once across depart retries. */
  private departJournal: string | null = null;
  /** True once the journal was witnessed, declined, or skipped in this process. */
  private departJournalDecided = false;
  /** Journal file path once written. */
  private departJournalPath: string | null = null;

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
    if (options.onHeartbeatError !== undefined) {
      this.onHeartbeatError = options.onHeartbeatError;
    }
    if (options.onDeparted !== undefined) {
      this.onDeparted = options.onDeparted;
    }
    if (options.transcript !== undefined) {
      this.liveTranscript = options.transcript;
    }
    this.witnessesMemories = options.witnessesMemories ?? false;
    this.attentionPolicy = { ...DEFAULT_ATTENTION_POLICY, ...options.attention };
    this.roomLog = new RoomLog(this.maxHistoryMessages);
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
    // Refuse before any append — osp/0.1 chains must be migrated first.
    await assertRuntimeWritableChain(options.store);

    const doorPublicKeys = options.doorPublicKeys;
    const composed = await composeSelf(options.store, {
      ...(doorPublicKeys === undefined ? {} : { doorPublicKeys })
    });

    const chainDerivedEpoch = (await scanMaxAttestationEpoch(options.store)) + 1;
    const doorFloorEpoch =
      options.activeEpoch === undefined || options.activeEpoch === null
        ? 0
        : options.activeEpoch + 1;
    const newEpoch = Math.max(chainDerivedEpoch, doorFloorEpoch);
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
   * Serialized per session (at most one in-flight Brain call) so history stays ordered.
   * Brain failures return `{ ok: false }` without stopping the session.
   */
  async handleInbound(frame: InboundFrame): Promise<HandleInboundResult> {
    if (this.phase !== "live") {
      throw new SessionError("session is not live");
    }

    return this.enqueueInbound(async () => this.processInbound(frame));
  }

  /**
   * Screen, complete, and append history for one inbound frame (runs on inboundChain).
   */
  private async processInbound(frame: InboundFrame): Promise<HandleInboundResult> {
    if (this.phase !== "live") {
      throw new SessionError("session is not live");
    }

    const validatedFrame = this.validateInbound(frame);

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
      const result = await this.brain.complete(messages);
      assistantText = result.text;
    } catch (error) {
      if (error instanceof BrainError) {
        return { ok: false, error };
      }
      throw error;
    }
    this.assertStillLive();

    this.pushHistory({ role: "user", content: text });
    this.pushHistory({ role: "assistant", content: assistantText });
    this.liveTranscript?.record({
      role: "user",
      text,
      author_id: validatedFrame.body.author_id
    });
    this.liveTranscript?.record({ role: "assistant", text: assistantText });

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
   * Selective attention: observe one inbound frame and let the Wanderer decide whether to
   * speak, react, both, or stay quiet.
   *
   * Every screened message enters the room log (and the live transcript) immediately, even
   * while a decision is in flight. Decisions are serialized with {@link handleInbound}; a
   * decision covers **all** messages observed since the last one, so a burst of chatter
   * costs one Brain call and yields at most one outbound frame. Later calls whose message
   * was already covered resolve `coalesced`.
   */
  async observe(frame: InboundFrame): Promise<ObserveResult> {
    if (this.phase !== "live") {
      throw new SessionError("session is not live");
    }
    const validatedFrame = this.validateInbound(frame);
    const body = validatedFrame.body;

    const screenResult = screenText(body.text);
    if (!screenResult.ok) {
      for (const category of screenResult.categories) {
        this.onScreenReject?.(category, "session.inbound");
      }
      return { kind: "screened", categories: screenResult.categories };
    }

    const entry = this.roomLog.addHuman({
      msgId: validatedFrame.msg_id,
      authorId: body.author_id,
      text: body.text,
      addressed: isAddressed({
        doorAddressed: body.addressed,
        repliesToSelf: this.roomLog.isSelfMessage(body.reply_to),
        text: body.text
      }),
      ...(body.author_display === undefined ? {} : { authorDisplay: body.author_display }),
      ...(body.reply_to === undefined ? {} : { replyToMsgId: body.reply_to }),
      ...(body.channel_id === undefined ? {} : { channelId: body.channel_id })
    });
    this.liveTranscript?.record({ role: "user", text: body.text, author_id: body.author_id });
    this.pendingEntries.push(entry);

    return this.enqueueInbound(async () => this.decideAttention(entry.ref));
  }

  /** One attention decision over every pending room entry (runs on inboundChain). */
  private async decideAttention(ref: number): Promise<ObserveResult> {
    if (!this.pendingEntries.some((entry) => entry.ref === ref)) {
      return { kind: "coalesced" };
    }
    if (this.phase !== "live") {
      throw new SessionError("session is not live");
    }

    const batch = this.pendingEntries;
    this.pendingEntries = [];
    const addressed = batch.some((entry) => entry.addressed);
    const selfShare = this.roomLog.selfShare(this.attentionPolicy.shareWindow);

    const reactionsText = this.attentionPolicy.reactions
      ? ATTENTION_REACTIONS_ON
      : ATTENTION_REACTIONS_OFF;
    const system = `${this.systemPrompt}\n\n${ATTENTION_SYSTEM.replaceAll(
      "{{reactions}}",
      () => reactionsText
    )}`;
    // Single pass with a replacer function: `$&` / `` $` `` / `$'` / `$$` and `{{...}}` in
    // untrusted room text stay inert (a string replacement would expand `$` patterns and
    // could forge a left-edge log entry).
    const fills: Record<"log" | "new_refs", string> = {
      log: this.roomLog.render(),
      new_refs: batch.map((entry) => `#${String(entry.ref)}`).join(", ")
    };
    const user = ATTENTION_USER_TEMPLATE.replaceAll(
      /\{\{(log|new_refs)\}\}/gu,
      (_match, key: "log" | "new_refs"): string => fills[key]
    );
    const messages: BrainMessage[] = [
      { role: "system", content: system },
      { role: "user", content: user }
    ];

    let raw: string;
    try {
      const maxTokens = this.attentionPolicy.maxTokens;
      raw = (
        await this.brain.complete(messages, maxTokens === undefined ? undefined : { maxTokens })
      ).text;
    } catch (error) {
      if (error instanceof BrainError) {
        return { kind: "error", error };
      }
      throw error;
    }
    this.assertStillLive();

    const resolved = resolveAttention({
      raw,
      log: this.roomLog,
      policy: this.attentionPolicy,
      addressed,
      selfShare
    });

    if (resolved.say === null && resolved.react === undefined) {
      return { kind: "silent", batchSize: batch.length, notes: resolved.notes };
    }

    this.outboundCounter += 1;
    const msgId = `out-${String(this.outboundCounter)}`;
    const channelSource = resolved.replyTo ?? batch[batch.length - 1];
    const channelId = channelSource?.channelId;

    const unsignedOutbound: Omit<OutboundFrame, "sig"> = {
      type: "outbound",
      door_id: this.doorId,
      epoch: this.epochValue,
      msg_id: msgId,
      issued_at: this.clock.now(),
      body: {
        ...(resolved.say === null ? {} : { text: resolved.say }),
        ...(resolved.replyTo === undefined ? {} : { reply_to: resolved.replyTo.msgId }),
        ...(channelId === undefined ? {} : { channel_id: channelId }),
        ...(resolved.react === undefined
          ? {}
          : {
              reaction: {
                emoji: resolved.react.emoji,
                target_msg_id: resolved.react.target.msgId
              }
            })
      }
    };
    const outboundSig = encodeSignature(this.sessionSigner.sign(canonicalize(unsignedOutbound)));

    if (resolved.say !== null) {
      this.roomLog.addSelf({
        msgId,
        text: resolved.say,
        ...(resolved.replyTo === undefined ? {} : { replyToRef: resolved.replyTo.ref })
      });
      this.liveTranscript?.record({ role: "assistant", text: resolved.say });
    }

    return {
      kind: "acted",
      outbound: { ...unsignedOutbound, sig: outboundSig },
      spoke: resolved.say !== null,
      reacted: resolved.react !== undefined,
      batchSize: batch.length,
      notes: resolved.notes
    };
  }

  /**
   * Re-check the phase after an awaited Brain call: if the residency began departing while
   * the call was in flight, drop the result (no transcript record, no signed outbound) so
   * nothing is written into a transcript that depart has already read and destroyed.
   */
  private assertStillLive(): void {
    if (this.phase !== "live") {
      throw new SessionError("session stopped while the Brain call was in flight");
    }
  }

  /** Schema + binding checks shared by {@link handleInbound} and {@link observe}. */
  private validateInbound(frame: InboundFrame): InboundFrame {
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
    return validatedFrame;
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
   * End a residency with witnessed memory (`spec/door/api.md` §Memory witnessing):
   *
   * 1. Stop inbound and heartbeats; read and destroy the transcript once.
   * 2. Unless the Door does not witness memories ({@link SessionOptions.witnessesMemories})
   *    or the stay was quiet (fewer than `minMemoryLines` lines — no distill call), distill
   *    candidate shards and append one `rejected` record per immune-screen category.
   * 3. Ask the Door to witness each shard (`attest` kind `memory`). Witnessed → side blob +
   *    Door co-signed `shard` record, final immediately. Declined → `rejected`
   *    `witness_<reason>`; the declined prose never reaches the store.
   * 4. With ≥ 1 witnessed shard: a journal written from the witnessed shards only, witnessed
   *    the same way (`journal` record), then written to `journalDir`.
   * 5. Departure (Door co-signed) and travel (`to_door_id`) attestations.
   *
   * Any other failure (including `witness_unavailable`) throws and leaves the session
   * `departing`; depart is then safe to retry: transcript, candidates, decisions and journal
   * are cached in-process, and nothing already on chain for this residency is appended twice.
   */
  async depart(options: DepartOptions): Promise<DepartResult> {
    await this.beginDepart();
    const brain = options.brain ?? this.brain;
    const lines = await this.readTranscriptOnce(options.transcript);
    const progress = await this.scanDepartChainProgress();

    // Departure closes the epoch at the Door, for memories too.
    if (!progress.hasDeparture) {
      const candidates = await this.ensureDepartCandidates(
        lines,
        brain,
        options.minMemoryLines ?? DEFAULT_MIN_MEMORY_LINES
      );

      for (const category of this.departScreenCategories) {
        if (progress.screenCategories.has(category)) {
          continue;
        }
        const head = await this.requireHead("depart");
        await this.appendMemoryRecord({
          seq: head.seq + 1,
          prev: head.cid,
          body: { kind: "rejected", category, rejected_at: this.clock.now() },
          cosigners: []
        });
        progress.screenCategories.add(category);
      }

      for (const text of candidates) {
        if (this.departDecidedTexts.has(text) || progress.shardTexts.has(text)) {
          continue;
        }
        await this.witnessMemory("shard", text, progress);
        this.departDecidedTexts.add(text);
      }

      await this.departJournalStep(progress, brain, options.journalDir);
    }

    await this.appendDepartureAndTravel(progress, options.toDoorId);
    const result: DepartResult = {
      witnessed: progress.shardTexts.size,
      declined: progress.declined,
      screened: progress.screenCategories.size,
      journalPath: this.departJournalPath
    };
    this.finishDepart();
    return result;
  }

  /**
   * End a residency without forming memories: destroy the transcript, then departure and
   * travel attestations (skipping any already on chain). The controller's best-effort path
   * after {@link depart} kept failing; throws when the Door cannot attest the departure.
   */
  async departBare(toDoorId?: string): Promise<void> {
    await this.beginDepart();
    if (this.departTranscriptLines === null) {
      // Privacy: the raw conversation never outlives the residency.
      await this.liveTranscript?.destroy();
      this.departTranscriptLines = [];
    }
    const progress = await this.scanDepartChainProgress();
    await this.appendDepartureAndTravel(progress, toDoorId);
    this.finishDepart();
  }

  /** Enter (or resume) `departing`: stop heartbeats, drain appends and inbound. */
  private async beginDepart(): Promise<void> {
    if (this.phase === "departed") {
      throw new SessionError("session has already departed");
    }
    if (this.phase === "live") {
      this.stop();
      await this.drainAppends();
    }
    // Let any in-flight inbound decision settle (it re-checks the phase after its Brain
    // call and bails) before the transcript is read and destroyed. Also covers a caller
    // that ran stop() itself before depart.
    await this.inboundChain;
  }

  /** Read and destroy the transcript on the first depart attempt; cached for retries. */
  private async readTranscriptOnce(
    transcript: TranscriptSource | undefined
  ): Promise<readonly TranscriptLine[]> {
    if (this.departTranscriptLines !== null) {
      return this.departTranscriptLines;
    }
    const source = transcript ?? this.liveTranscript;
    if (source === undefined) {
      throw new SessionError("depart requires a transcript (none passed and no live transcript)");
    }
    const lines = await source.read();
    await source.destroy();
    if (this.liveTranscript !== undefined && this.liveTranscript !== source) {
      await this.liveTranscript.destroy();
    }
    this.departTranscriptLines = lines;
    return lines;
  }

  /**
   * Distill once (cached). No distill when the Door does not witness memories or the stay
   * has fewer than `minMemoryLines` lines; a distill that leaves no usable shard yields none.
   */
  private async ensureDepartCandidates(
    lines: readonly TranscriptLine[],
    brain: Brain,
    minMemoryLines: number
  ): Promise<readonly string[]> {
    if (this.departCandidates !== null) {
      return this.departCandidates;
    }
    if (!this.witnessesMemories || lines.length < minMemoryLines) {
      this.departCandidates = [];
      return this.departCandidates;
    }

    const screenCategories = new Set<ScreenCategory>();
    let texts: string[];
    try {
      const shards = await distillTranscripts(new MemoryTranscriptSource(lines), brain, {
        onScreenReject: (category) => {
          screenCategories.add(category);
        }
      });
      texts = shards.map((shard) => shard.text);
    } catch (error) {
      // Nothing usable survived (too few shards / screened out): no memories, not a failure.
      if (!(error instanceof DistillError) || error.reason === "malformed_output") {
        throw error;
      }
      texts = [];
    }
    this.departScreenCategories = [...screenCategories];
    this.departCandidates = texts;
    return texts;
  }

  /**
   * Journal: generated once from the witnessed shards only, witnessed like a shard, then
   * written to `journalDir`. Retry-safe: a journal already on chain is only (re)written to
   * disk; a decided journal is never re-attested in this process.
   */
  private async departJournalStep(
    progress: DepartProgress,
    brain: Brain,
    journalDir: string
  ): Promise<void> {
    if (progress.hasJournal) {
      if (this.departJournal !== null && this.departJournalPath === null) {
        this.departJournalPath = await writeJournalFile(
          journalDir,
          this.doorId,
          this.epochValue,
          this.departJournal
        );
      }
      return;
    }
    if (this.departJournalDecided || progress.shardTexts.size === 0) {
      return;
    }
    this.departJournal ??= await generateJournal(
      { doorId: this.doorId, epoch: this.epochValue, shardTexts: [...progress.shardTexts] },
      brain
    );
    if ([...this.departJournal].length > MEMORY_ATTEST_TEXT_MAX) {
      // Too long for a memory attest: keep the shards, skip the journal.
      this.departJournalDecided = true;
      return;
    }
    const witnessed = await this.witnessMemory("journal", this.departJournal, progress);
    this.departJournalDecided = true;
    if (witnessed) {
      this.departJournalPath = await writeJournalFile(
        journalDir,
        this.doorId,
        this.epochValue,
        this.departJournal
      );
    }
  }

  /**
   * Ask the Door to witness one memory (`attest` kind `memory`, session-signed; `core`
   * binds `text` by side-blob hash). Witnessed → store the side blob and append the
   * co-signed record. `witness_declined` → append `rejected` `witness_<reason>` (the blob
   * is never stored). Any other error propagates. Returns whether it was witnessed.
   */
  private async witnessMemory(
    kind: "shard" | "journal",
    text: string,
    progress: DepartProgress
  ): Promise<boolean> {
    const blob =
      kind === "shard" ? await addressShardTextBlob(text) : await addressJournalBlob(text);
    const head = await this.requireHead("depart");
    const at = this.clock.now();
    const body: CreateRecordFields["body"] =
      kind === "shard"
        ? { kind: "shard", text_cid: blob.cid, text_hash: blob.hash, distilled_at: at }
        : { kind: "journal", journal_cid: blob.cid, journal_hash: blob.hash, written_at: at };
    const core = new TextDecoder().decode(
      canonicalize(
        corePayload({
          spec: OSP_SPEC_V02,
          seq: head.seq + 1,
          prev: head.cid,
          type: "memory",
          body,
          residency: this.residency
        })
      )
    );
    const unsignedAttest: Omit<AttestRequest, "sig"> = {
      protocol_version: DOOR_PROTOCOL_VERSION,
      door_id: this.doorId,
      epoch: this.epochValue,
      kind: "memory",
      core,
      session_pubkey: encodePublicKey(this.sessionPublicKeyValue),
      text,
      issued_at: this.clock.now()
    };

    let doorCosig: string;
    try {
      const response = await this.door.attest({
        ...unsignedAttest,
        sig: encodeSignature(this.sessionSigner.sign(attestSigningPayload(unsignedAttest)))
      });
      doorCosig = response.door_cosig;
    } catch (error) {
      if (!(error instanceof DoorError) || error.code !== "witness_declined") {
        throw error;
      }
      const reason = WitnessReasonSchema.safeParse(error.details?.reason);
      await this.appendMemoryRecord({
        seq: head.seq + 1,
        prev: head.cid,
        body: {
          kind: "rejected",
          category: `witness_${reason.success ? reason.data : "other"}`,
          rejected_at: this.clock.now()
        },
        cosigners: []
      });
      progress.declined += 1;
      return false;
    }

    await putAddressedBlob(this.store, blob);
    await this.appendMemoryRecord({
      seq: head.seq + 1,
      prev: head.cid,
      body,
      cosigners: [doorCosig]
    });
    if (kind === "shard") {
      progress.shardTexts.add(text);
    } else {
      progress.hasJournal = true;
    }
    return true;
  }

  /** Departure (Door co-signed) then travel (soul-signed), each skipped if on chain. */
  private async appendDepartureAndTravel(
    progress: DepartProgress,
    toDoorId: string | undefined
  ): Promise<void> {
    if (!progress.hasDeparture) {
      const chainHead = await this.requireHead("departure");
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
      const chainHead = await this.requireHead("travel");
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
      if (toDoorId !== undefined) {
        travelBody.to_door_id = toDoorId;
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
      progress.hasTravel = true;
    }
  }

  /** Mark departed, drop in-process depart caches, notify. */
  private finishDepart(): void {
    this.phase = "departed";
    this.departTranscriptLines = null;
    this.departCandidates = null;
    this.departScreenCategories = [];
    this.departDecidedTexts.clear();
    this.departJournal = null;
    this.departJournalPath = null;
    this.onDeparted?.();
  }

  private async requireHead(stage: string): Promise<{ seq: number; cid: string }> {
    const head = await this.store.head();
    if (head === null) {
      throw new SessionError(`${stage}: store has no head`);
    }
    return head;
  }

  /** Scan this residency for depart-stage records already on the soulchain. */
  private async scanDepartChainProgress(): Promise<DepartProgress> {
    const progress: DepartProgress = {
      screenCategories: new Set<ScreenCategory>(),
      shardTexts: new Set<string>(),
      hasJournal: false,
      declined: 0,
      hasDeparture: false,
      hasTravel: false
    };

    for await (const record of this.store.iterate()) {
      if (record.residency !== this.residency) {
        continue;
      }

      if (record.type === "memory") {
        const body = record.body;
        if (body.kind === "shard") {
          if ("text" in body) {
            progress.shardTexts.add(body.text);
          } else {
            try {
              progress.shardTexts.add(
                decodeShardTextBlob(await this.store.getSideBlob(body.text_cid))
              );
            } catch {
              // Erased/missing blob: cannot dedupe by content (edge case after erasure).
            }
          }
        } else if (body.kind === "journal") {
          progress.hasJournal = true;
        } else if (body.kind === "rejected") {
          if (body.category.startsWith(WITNESS_CATEGORY_PREFIX)) {
            progress.declined += 1;
          } else if (isScreenCategory(body.category)) {
            progress.screenCategories.add(body.category);
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
          progress.hasDeparture = true;
        }
        if (
          body.kind === "travel" &&
          body.from_door_id === this.doorId &&
          body.from_epoch === this.epochValue
        ) {
          progress.hasTravel = true;
        }
      }
    }

    return progress;
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

  /** Serialize inbound handling so Brain+history updates never interleave. */
  private enqueueInbound<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.inboundChain.then(fn, fn);
    this.inboundChain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private notifyHeartbeatError(error: unknown, stage: HeartbeatErrorStage): void {
    this.onHeartbeatError?.(error, stage);
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

    try {
      await this.door.heartbeat({
        ...unsignedHeartbeat,
        sig: heartbeatSig
      });
    } catch (error) {
      this.notifyHeartbeatError(error, "door");
      throw error;
    }

    this.heartbeatSeq = seq;

    const heartbeatBody = {
      kind: "heartbeat" as const,
      pop_version: POP_VERSION,
      door_id: this.doorId,
      epoch: this.epochValue,
      session_pubkey: sessionPubkeyEncoded,
      at: this.clock.now()
    };

    await this.appendHeartbeatAttestation({
      body: heartbeatBody,
      seq: head.seq + 1,
      prev: head.cid
    });
  }

  /**
   * Heartbeat-only attest+append with stage-tagged errors for {@link onHeartbeatError}.
   */
  private async appendHeartbeatAttestation(params: {
    body: CreateRecordFields["body"];
    seq: number;
    prev: string;
  }): Promise<void> {
    const core = new TextDecoder().decode(
      canonicalize(
        corePayload({
          spec: OSP_SPEC_V02,
          seq: params.seq,
          prev: params.prev,
          type: "attestation",
          body: params.body,
          residency: this.residency
        })
      )
    );

    const issuedAt = this.clock.now();
    const sessionPubkeyEncoded = encodePublicKey(this.sessionPublicKeyValue);

    const unsignedAttest: Omit<AttestRequest, "sig"> = {
      protocol_version: DOOR_PROTOCOL_VERSION,
      door_id: this.doorId,
      epoch: this.epochValue,
      kind: "heartbeat",
      core,
      session_pubkey: sessionPubkeyEncoded,
      issued_at: issuedAt
    };

    const attestSig = encodeSignature(
      this.sessionSigner.sign(attestSigningPayload(unsignedAttest))
    );

    let doorCosig: string;
    try {
      const attestResponse = await this.door.attest({
        ...unsignedAttest,
        sig: attestSig
      });
      doorCosig = attestResponse.door_cosig;
    } catch (error) {
      this.notifyHeartbeatError(error, "door");
      throw error;
    }

    const { record } = await sealRecord(this.keyring, {
      seq: params.seq,
      prev: params.prev,
      type: "attestation",
      body: params.body,
      residency: this.residency,
      cosigners: [doorCosig]
    });

    try {
      await this.store.append(record);
    } catch (error) {
      this.notifyHeartbeatError(error, "append");
      throw error;
    }
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
          spec: OSP_SPEC_V02,
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

/** `rejected` category prefix for memories the Door's witness declined. */
const WITNESS_CATEGORY_PREFIX = "witness_";

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
      spec: OSP_SPEC_V02,
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
    spec: OSP_SPEC_V02,
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
