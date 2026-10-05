import {
  canonicalize,
  cidMatchesHash,
  decodePublicKey,
  decodeSignature,
  encodeMemoryTextBlob,
  encodePublicKey,
  hashBlobBytes,
  verify,
  type Ed25519Keypair
} from "@npc/osp-core";

import {
  PersistedCosignStateSchema,
  type CosignStateStore,
  type PersistedCosignState
} from "./cosign-state-store.js";
import { DoorError } from "./errors.js";
import type { HostPolicy } from "./policy.js";
import {
  DOOR_PROTOCOL_VERSION,
  HelloRequestSchema,
  type AttestRequest,
  type AttestResponse,
  type Clock,
  type ControlFrame,
  type CosignRequest,
  type CosignResponse,
  type CandidateShard,
  type HeartbeatRequest,
  type HeartbeatResponse,
  type HelloResponse,
  type InboundFrame,
  type OutboundFrame,
  type ReviewDecision,
  type SessionBindParams
} from "./schemas.js";
import {
  attestSigningPayload,
  cosignCommitSigningPayload,
  cosignReviewSigningPayload,
  heartbeatSigningPayload,
  outboundSigningPayload,
  sessionBindSigningPayload,
  signCanonical,
  signDoorCosig
} from "./signing.js";

/** Default ±skew for Wanderer `issued_at` vs Door clock (5 minutes). */
export const DEFAULT_MAX_ISSUED_AT_SKEW_MS = 300_000;

/**
 * Accepted outbound `msg_id`s remembered per epoch for replay rejection (oldest
 * evicted first). Combined with the `issued_at` freshness window this bounds replay.
 */
export const OUTBOUND_MSG_ID_MEMORY = 10_000;

/** Default number of reviewed epochs whose cosign review state a Door retains (16). */
export const DEFAULT_COSIGN_RETAIN_EPOCHS = 64;

/** Default maximum age of a retained cosign review (7 days, by review completion time). */
export const DEFAULT_COSIGN_RETAIN_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Bounds on retained per-epoch cosign review state (`spec/door/api.md` — **Review
 * retention**). A review is evicted once it is older than `maxAgeMs` or once more than
 * `maxEpochs` reviews are retained (lowest epoch first).
 */
export type CosignRetention = {
  /** Max reviewed epochs retained (default {@link DEFAULT_COSIGN_RETAIN_EPOCHS}). */
  maxEpochs?: number;
  /** Max review age in ms (default {@link DEFAULT_COSIGN_RETAIN_MS}). */
  maxAgeMs?: number;
};

/** Session lifecycle event emitted when a residency epoch is closed or superseded. */
export type SessionLifecycleEvent = {
  type: "retired" | "superseded";
  doorId: string;
  epoch: number;
};

/** Configuration for a transport-agnostic Door host core. */
export type DoorOptions = {
  doorId: string;
  doorKeypair: Ed25519Keypair;
  soulPublicKey: Uint8Array;
  clock: Clock;
  policy: HostPolicy;
  /**
   * Max absolute skew between request `issued_at` and Door clock (ms).
   * Defaults to {@link DEFAULT_MAX_ISSUED_AT_SKEW_MS}.
   */
  maxIssuedAtSkewMs?: number;
  /** Retention bounds for per-epoch cosign review state (defaults: 16 epochs, 7 days). */
  cosignRetention?: CosignRetention;
  /**
   * Durable store for retained cosign review state. When set, state is loaded at
   * construction (a corrupt file or a file for another `door_id` throws) and saved
   * after every review and commit, so commits for past epochs survive a Door restart.
   * Default: in-memory only (lost on restart).
   */
  cosignStateStore?: CosignStateStore;
};

type ActiveSession = {
  epoch: number;
  sessionPubkey: string;
};

type CosignReviewResponse = Extract<CosignResponse, { phase: "review" }>;
type CosignCommitResponse = Extract<CosignResponse, { phase: "commit" }>;

/** Last commit co-signed for a `shard_id` (single-use binding + idempotent retry). */
type CommittedShard = {
  seq: number;
  core: string;
  response: CosignCommitResponse;
};

/** Completed cosign review of one epoch, retained until evicted (see {@link CosignRetention}). */
type CosignEpochState = {
  /** Approved `shard_id` → reviewed plaintext (commit `core` must reference this text). */
  approvedShards: Map<string, string>;
  /** `shard_id` → highest-`seq` commit already co-signed (single-use binding). */
  committed: Map<string, CommittedShard>;
  /** Bound at review; commits for this epoch authenticate with this session key. */
  epoch: number;
  sessionPubkey: string;
  /** Door-clock time the review completed (ISO) — retention age. */
  reviewedAt: string;
  /**
   * {@link Door.cosignReviewKey} of the completed review (authenticated retry replay).
   * `null` for state restored from a {@link CosignStateStore}: the key embeds rejected
   * shard text, which is never persisted, so a restored review is not replayable.
   */
  reviewKey: string | null;
  /** Signed response of the completed review, returned verbatim to a matching retry. */
  reviewResponse: CosignReviewResponse | null;
};

type UnsignedHeartbeatFields = Omit<HeartbeatRequest, "sig">;

type UnsignedOutboundFrame = Omit<OutboundFrame, "sig">;

type UnsignedControlFrame = Omit<ControlFrame, "sig">;

/**
 * Transport-agnostic Door host core implementing discovery, attest, heartbeat,
 * cosign, session binding, and WebSocket frame helpers per `spec/door/api.md`.
 */
export class Door {
  private readonly doorId: string;
  private readonly doorKeypair: Ed25519Keypair;
  private readonly soulPublicKey: Uint8Array;
  private readonly clock: Clock;
  private readonly policy: HostPolicy;
  private readonly maxIssuedAtSkewMs: number;
  private activeSession: ActiveSession | null = null;
  private sessionRetired = false;
  /** Highest arrival epoch ever accepted (in-memory; lost on process restart). */
  private lastKnownEpoch: number | null = null;
  private lastHeartbeatSeq = 0;
  /** Completed cosign reviews by epoch (bounded by {@link CosignRetention}; not reset on arrival). */
  private readonly cosignStates = new Map<number, CosignEpochState>();
  private readonly retainEpochs: number;
  private readonly retainMs: number;
  private readonly cosignStateStore: CosignStateStore | null;
  private sessionLifecycleListener: ((event: SessionLifecycleEvent) => void) | null = null;
  private sessionEndMsgCounter = 0;
  /** Outbound `msg_id`s accepted for the active epoch (bounded; reset on arrival). */
  private readonly seenOutboundMsgIds = new Set<string>();

  constructor(options: DoorOptions) {
    this.doorId = options.doorId;
    this.doorKeypair = options.doorKeypair;
    this.soulPublicKey = options.soulPublicKey;
    this.clock = options.clock;
    this.policy = options.policy;
    this.maxIssuedAtSkewMs = options.maxIssuedAtSkewMs ?? DEFAULT_MAX_ISSUED_AT_SKEW_MS;
    this.retainEpochs = options.cosignRetention?.maxEpochs ?? DEFAULT_COSIGN_RETAIN_EPOCHS;
    this.retainMs = options.cosignRetention?.maxAgeMs ?? DEFAULT_COSIGN_RETAIN_MS;
    if (!Number.isSafeInteger(this.retainEpochs) || this.retainEpochs < 1) {
      throw new RangeError("cosignRetention.maxEpochs must be a positive integer");
    }
    if (!Number.isSafeInteger(this.retainMs) || this.retainMs < 1) {
      throw new RangeError("cosignRetention.maxAgeMs must be a positive integer");
    }
    this.cosignStateStore = options.cosignStateStore ?? null;
    if (this.cosignStateStore !== null) {
      this.restoreCosignStates(this.cosignStateStore.load());
      this.pruneCosignStates();
    }
  }

  /** Epochs whose completed cosign review this Door currently retains (ascending). */
  getRetainedReviewEpochs(): number[] {
    this.pruneCosignStates();
    return [...this.cosignStates.keys()].sort((a, b) => a - b);
  }

  /** Active session public key after a successful arrival attest, if any. */
  getActiveSessionPubkey(): string | null {
    return this.activeSession?.sessionPubkey ?? null;
  }

  /** Active residency epoch for hello `active_epoch`, if any. */
  getActiveEpoch(): number | null {
    return this.activeSession?.epoch ?? null;
  }

  /** Highest arrival epoch accepted by this Door process, if any. */
  getLastKnownEpoch(): number | null {
    return this.lastKnownEpoch;
  }

  /** Current timestamp from the injected clock (for transport-issued frames). */
  now(): string {
    return this.clock.now();
  }

  /**
   * Register a listener for session retirement / supersession.
   * Transports (e.g. WS) use this to close stale sockets.
   */
  setSessionLifecycleListener(listener: ((event: SessionLifecycleEvent) => void) | null): void {
    this.sessionLifecycleListener = listener;
  }

  /**
   * Build a Door-signed `session_end` control frame for the given epoch.
   * Used by the WS transport when closing sockets after depart / supersede.
   */
  createSessionEndFrame(epoch: number, reason: string): ControlFrame {
    this.sessionEndMsgCounter += 1;
    const unsigned: UnsignedControlFrame = {
      type: "control",
      door_id: this.doorId,
      epoch,
      msg_id: `session_end_${String(this.sessionEndMsgCounter)}`,
      issued_at: this.clock.now(),
      body: { action: "session_end", reason }
    };
    const sig = signCanonical(
      {
        type: unsigned.type,
        door_id: unsigned.door_id,
        epoch: unsigned.epoch,
        msg_id: unsigned.msg_id,
        issued_at: unsigned.issued_at,
        body: unsigned.body
      },
      this.doorKeypair.privateKey
    );
    return { ...unsigned, sig };
  }

  /** `POST /door/hello` — capability negotiation and signed community descriptor. */
  async hello(req: unknown): Promise<HelloResponse> {
    const version = readProtocolVersion(req);
    if (version !== undefined && version !== DOOR_PROTOCOL_VERSION) {
      throw DoorError.fromCode(
        "unsupported_version",
        `unsupported protocol_version: expected ${DOOR_PROTOCOL_VERSION}, got ${String(version)}`
      );
    }

    const parsed = HelloRequestSchema.safeParse(req);
    if (!parsed.success) {
      throw DoorError.fromCode("invalid_request", `invalid hello request: ${parsed.error.message}`);
    }

    const available = await Promise.resolve(this.policy.isAvailable?.() ?? true);
    if (!available) {
      throw DoorError.fromCode("door_unavailable", "door is not accepting discovery");
    }

    const issuedAt = this.clock.now();
    const unsigned: Omit<HelloResponse, "sig"> = {
      protocol_version: DOOR_PROTOCOL_VERSION,
      door_id: this.doorId,
      door_pubkey: encodePublicKey(this.doorKeypair.publicKey),
      active_epoch: this.getActiveEpoch(),
      capabilities: [...this.policy.capabilities],
      community: this.policy.community,
      issued_at: issuedAt
    };
    const sig = signCanonical(
      {
        protocol_version: unsigned.protocol_version,
        door_id: unsigned.door_id,
        door_pubkey: unsigned.door_pubkey,
        active_epoch: unsigned.active_epoch,
        capabilities: unsigned.capabilities,
        community: unsigned.community,
        issued_at: unsigned.issued_at
      },
      this.doorKeypair.privateKey
    );

    return { ...unsigned, sig };
  }

  /** `POST /door/attest` — verify soul/session signatures and produce door co-signatures. */
  async attest(request: AttestRequest): Promise<AttestResponse> {
    if (request.door_id !== this.doorId) {
      throw DoorError.fromCode(
        "session_invalid",
        `door_id mismatch: expected ${this.doorId}, got ${request.door_id}`
      );
    }

    this.assertIssuedAtFresh(request.issued_at);

    const payload = attestSigningPayload(request);
    const requestSig = decodeSignature(request.sig);

    if (request.kind === "arrival") {
      if (!verify(payload, requestSig, this.soulPublicKey)) {
        throw DoorError.fromCode("signature_invalid", "arrival attest: invalid soul signature");
      }

      // Replay defense: epoch must strictly exceed the highest ever accepted (in-memory).
      if (this.lastKnownEpoch !== null && request.epoch <= this.lastKnownEpoch) {
        throw DoorError.fromCode(
          "epoch_replay",
          `epoch_replay: arrival epoch ${String(request.epoch)} <= last known ${String(this.lastKnownEpoch)}`,
          { field: "epoch", last_known: this.lastKnownEpoch, got: request.epoch }
        );
      }

      this.assertAttestCoreBound(request);

      // Host policy must approve before any session state mutation (not_hosting).
      if (this.policy.acceptArrival !== undefined) {
        try {
          await this.policy.acceptArrival({
            epoch: request.epoch,
            sessionPubkey: request.session_pubkey,
            core: request.core
          });
        } catch (error) {
          if (error instanceof DoorError) {
            throw error;
          }
          const message = error instanceof Error ? error.message : "host declined arrival";
          throw DoorError.fromCode("not_hosting", message, undefined, error);
        }
      }

      // Supersession: strictly greater epoch retires any active different-epoch session.
      if (this.activeSession !== null && this.activeSession.epoch !== request.epoch) {
        const oldEpoch = this.activeSession.epoch;
        this.activeSession = null;
        this.emitSessionLifecycle({
          type: "superseded",
          doorId: this.doorId,
          epoch: oldEpoch
        });
      }

      this.activeSession = {
        epoch: request.epoch,
        sessionPubkey: request.session_pubkey
      };
      this.sessionRetired = false;
      // Completed cosign reviews of earlier epochs are retained (bounded): commits for
      // a past epoch may arrive while this newer residency is live.
      this.lastHeartbeatSeq = 0;
      this.seenOutboundMsgIds.clear();
      this.lastKnownEpoch = request.epoch;
    } else {
      // Spec: epoch_mismatch (409) when Door has an active session with a different epoch.
      if (this.activeSession !== null && this.activeSession.epoch !== request.epoch) {
        throw DoorError.fromCode(
          "epoch_mismatch",
          `epoch_mismatch: expected ${String(this.activeSession.epoch)}, got ${String(request.epoch)}`
        );
      }
      this.requireActiveSession(request.door_id, request.epoch, request.session_pubkey);
      const sessionPublicKey = decodePublicKey(request.session_pubkey);
      if (!verify(payload, requestSig, sessionPublicKey)) {
        throw DoorError.fromCode(
          "signature_invalid",
          `${request.kind} attest: invalid session signature`
        );
      }
      this.assertAttestCoreBound(request);
      if (request.kind === "departure") {
        const departedEpoch = request.epoch;
        this.activeSession = null;
        this.sessionRetired = true;
        this.emitSessionLifecycle({
          type: "retired",
          doorId: this.doorId,
          epoch: departedEpoch
        });
      }
    }

    const receivedAt = this.clock.now();
    const doorCosig = signDoorCosig(request.core, this.doorKeypair.privateKey);
    const doorSig = signCanonical(
      {
        door_id: request.door_id,
        epoch: request.epoch,
        kind: request.kind,
        door_cosig: doorCosig,
        received_at: receivedAt
      },
      this.doorKeypair.privateKey
    );

    return {
      door_id: request.door_id,
      epoch: request.epoch,
      kind: request.kind,
      door_cosig: doorCosig,
      received_at: receivedAt,
      door_sig: doorSig
    };
  }

  /** `POST /door/heartbeat` — monotonic presence ping with session-key signature. */
  async heartbeat(request: HeartbeatRequest): Promise<HeartbeatResponse> {
    if (request.door_id !== this.doorId) {
      throw DoorError.fromCode(
        "session_invalid",
        `door_id mismatch: expected ${this.doorId}, got ${request.door_id}`
      );
    }

    this.requireActiveSession(request.door_id, request.epoch, request.session_pubkey);

    if (request.seq <= this.lastHeartbeatSeq) {
      throw DoorError.fromCode(
        "seq_replay",
        `seq_replay: heartbeat seq ${String(request.seq)} <= last accepted ${String(this.lastHeartbeatSeq)}`
      );
    }

    const unsigned: UnsignedHeartbeatFields = {
      protocol_version: request.protocol_version,
      door_id: request.door_id,
      epoch: request.epoch,
      session_pubkey: request.session_pubkey,
      seq: request.seq,
      issued_at: request.issued_at
    };
    const payload = heartbeatSigningPayload(unsigned);
    const requestSig = decodeSignature(request.sig);
    const sessionPublicKey = decodePublicKey(request.session_pubkey);
    if (!verify(payload, requestSig, sessionPublicKey)) {
      throw DoorError.fromCode("signature_invalid", "heartbeat: invalid session signature");
    }

    this.lastHeartbeatSeq = request.seq;

    const receivedAt = this.clock.now();
    const accepted = true;
    const doorSig = signCanonical(
      {
        door_id: request.door_id,
        epoch: request.epoch,
        seq: request.seq,
        accepted,
        received_at: receivedAt
      },
      this.doorKeypair.privateKey
    );

    return {
      door_id: request.door_id,
      epoch: request.epoch,
      seq: request.seq,
      accepted,
      received_at: receivedAt,
      door_sig: doorSig
    };
  }

  /** `POST /door/cosign` — two-phase host review and shard commit co-signing. */
  async cosign(request: CosignRequest): Promise<CosignResponse> {
    if (request.door_id !== this.doorId) {
      throw DoorError.fromCode(
        "session_invalid",
        `door_id mismatch: expected ${this.doorId}, got ${request.door_id}`
      );
    }

    this.assertIssuedAtFresh(request.issued_at);

    return this.cosignReceivedFresh(request);
  }

  /**
   * Run a cosign phase for a request whose `issued_at` freshness was already checked
   * **once, on receipt** (by {@link cosign} or {@link verifyCosignRequest}). Session
   * binding, epoch state, and the request signature are (re)verified here; the clock is
   * not. Doors with asynchronous host review call this after the review completes so a
   * slow human review cannot turn a fresh request into `timestamp_stale`.
   */
  protected async cosignReceivedFresh(request: CosignRequest): Promise<CosignResponse> {
    if (request.phase === "review") {
      return this.cosignReview(request);
    }
    if (request.phase === "commit") {
      return this.cosignCommit(request);
    }

    throw DoorError.fromCode(
      "unsupported_phase",
      "unsupported_phase: cosign phase must be review or commit"
    );
  }

  /**
   * Identity of a review request for retry matching: `(epoch, session_pubkey, sorted
   * {shard_id, text})`. Independent of `issued_at` / `sig`, which a retrying Wanderer
   * re-signs. Canonical JSON string (texts compared exactly, i.e. by content).
   */
  protected cosignReviewKey(request: Extract<CosignRequest, { phase: "review" }>): string {
    const shards = request.shards
      .map((shard) => [shard.shard_id, shard.text] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([shardId, text]) => ({ shard_id: shardId, text }));
    return new TextDecoder().decode(
      canonicalize({
        door_id: request.door_id,
        epoch: request.epoch,
        session_pubkey: request.session_pubkey,
        shards
      })
    );
  }

  /** True while this Door retains a completed cosign review for `epoch` (decisions are fixed). */
  protected isCosignReviewCompleted(epoch: number): boolean {
    return this.getCosignState(epoch) !== undefined;
  }

  /**
   * Verify WebSocket session binding proof (`session_sig` over `{door_id, epoch, session_pubkey}`).
   */
  bindSession(params: SessionBindParams): void {
    if (params.door_id !== this.doorId) {
      throw DoorError.fromCode(
        "session_invalid",
        `session_invalid: door_id mismatch expected ${this.doorId}, got ${params.door_id}`
      );
    }

    this.requireActiveSession(params.door_id, params.epoch, params.session_pubkey);

    const payload = sessionBindSigningPayload({
      door_id: params.door_id,
      epoch: params.epoch,
      session_pubkey: params.session_pubkey
    });
    const sessionPublicKey = decodePublicKey(params.session_pubkey);
    if (!verify(payload, decodeSignature(params.session_sig), sessionPublicKey)) {
      throw DoorError.fromCode("signature_invalid", "session bind: invalid session signature");
    }
  }

  /**
   * Verify an outbound session frame against the active session public key.
   * Returns `false` when binding or signature checks fail.
   */
  verifyOutbound(frame: OutboundFrame): boolean {
    if (frame.door_id !== this.doorId) {
      return false;
    }
    if (this.activeSession === null) {
      return false;
    }
    if (frame.epoch !== this.activeSession.epoch) {
      return false;
    }

    const sessionPubkey = this.activeSession.sessionPubkey;
    const unsigned: UnsignedOutboundFrame = {
      type: frame.type,
      door_id: frame.door_id,
      epoch: frame.epoch,
      msg_id: frame.msg_id,
      issued_at: frame.issued_at,
      body: frame.body
    };
    const payload = outboundSigningPayload(unsigned);
    const frameSig = decodeSignature(frame.sig);
    const sessionPublicKey = decodePublicKey(sessionPubkey);
    return verify(payload, frameSig, sessionPublicKey);
  }

  /** Accept an outbound frame after verification; throws on failure. */
  handleOutbound(frame: OutboundFrame): void {
    if (frame.door_id !== this.doorId) {
      throw DoorError.fromCode(
        "session_invalid",
        `session_invalid: door_id mismatch expected ${this.doorId}, got ${frame.door_id}`
      );
    }
    if (this.activeSession === null) {
      throw DoorError.fromCode("session_invalid", "session_invalid: no active session");
    }
    if (frame.epoch !== this.activeSession.epoch) {
      throw DoorError.fromCode(
        "session_invalid",
        `session_invalid: epoch mismatch expected ${String(this.activeSession.epoch)}, got ${String(frame.epoch)}`
      );
    }
    if (!this.verifyOutbound(frame)) {
      throw DoorError.fromCode(
        "signature_invalid",
        "signature_invalid: outbound frame signature failed"
      );
    }
    // After signature verification so unauthenticated frames cannot probe the clock.
    this.assertIssuedAtFresh(frame.issued_at);
    if (this.seenOutboundMsgIds.has(frame.msg_id)) {
      throw DoorError.fromCode(
        "msg_replay",
        `msg_replay: outbound msg_id ${frame.msg_id} already accepted this epoch`,
        { field: "msg_id", got: frame.msg_id }
      );
    }
    this.seenOutboundMsgIds.add(frame.msg_id);
    while (this.seenOutboundMsgIds.size > OUTBOUND_MSG_ID_MEMORY) {
      const oldest = this.seenOutboundMsgIds.values().next();
      if (oldest.done === true) {
        break;
      }
      this.seenOutboundMsgIds.delete(oldest.value);
    }
  }

  /** Build a Door-originated inbound frame for the active session. */
  createInboundFrame(args: { msg_id: string; body: InboundFrame["body"] }): InboundFrame {
    if (this.activeSession === null) {
      throw DoorError.fromCode("session_invalid", "session_invalid: no active session");
    }

    return {
      type: "inbound",
      door_id: this.doorId,
      epoch: this.activeSession.epoch,
      msg_id: args.msg_id,
      issued_at: this.clock.now(),
      body: args.body
    };
  }

  /**
   * Handle a control frame; responds to `ping` with a Door-signed `pong`.
   * Returns `null` for `session_end` and unrecognized actions.
   */
  handleControl(frame: ControlFrame): ControlFrame | null {
    if (frame.body.action === "ping") {
      const pong: UnsignedControlFrame = {
        type: "control",
        door_id: frame.door_id,
        epoch: frame.epoch,
        msg_id: frame.msg_id,
        issued_at: this.clock.now(),
        body: { action: "pong" }
      };
      const sig = signCanonical(
        {
          type: pong.type,
          door_id: pong.door_id,
          epoch: pong.epoch,
          msg_id: pong.msg_id,
          issued_at: pong.issued_at,
          body: pong.body
        },
        this.doorKeypair.privateKey
      );
      return { ...pong, sig };
    }

    if (frame.body.action === "session_end") {
      return null;
    }

    return null;
  }

  /**
   * Validate cosign `issued_at` freshness, session binding, request signature, and
   * review shard count without mutating state. Call **on receipt**, before any side
   * effects (e.g. Discord review posts), so stale replays and unauthenticated or
   * oversized requests cannot reach host channels; then finish with
   * {@link cosignReceivedFresh}, which does not re-check the clock.
   * Per-shard field validation remains in {@link cosignReview}.
   */
  protected verifyCosignRequest(request: CosignRequest): void {
    if (request.door_id !== this.doorId) {
      throw DoorError.fromCode(
        "session_invalid",
        `door_id mismatch: expected ${this.doorId}, got ${request.door_id}`
      );
    }

    this.assertIssuedAtFresh(request.issued_at);

    this.verifyCosignAuth(request);
  }

  /**
   * Session binding / epoch state / request signature checks for cosign (no clock).
   * A review retry after the epoch's review completed passes only when it is signed by
   * the review session key and has the same {@link cosignReviewKey} (it then replays the
   * stored response); any other review is `epoch_closed`.
   */
  private verifyCosignAuth(request: CosignRequest): void {
    if (request.door_id !== this.doorId) {
      throw DoorError.fromCode(
        "session_invalid",
        `door_id mismatch: expected ${this.doorId}, got ${request.door_id}`
      );
    }

    if (request.phase === "review") {
      const state = this.getCosignState(request.epoch);
      if (state !== undefined) {
        // Replay only while no newer arrival happened: reviews for a past epoch are
        // closed even though its (commit) state is retained.
        const replayable =
          state.reviewKey !== null &&
          state.reviewResponse !== null &&
          (this.lastKnownEpoch === null || this.lastKnownEpoch <= request.epoch);
        const matchesCompleted =
          replayable &&
          request.session_pubkey === state.sessionPubkey &&
          verify(
            cosignReviewSigningPayload(request),
            decodeSignature(request.sig),
            decodePublicKey(state.sessionPubkey)
          ) &&
          this.cosignReviewKey(request) === state.reviewKey;
        if (matchesCompleted) {
          return;
        }
        throw DoorError.fromCode(
          "epoch_closed",
          "epoch_closed: cosign review already completed for this epoch"
        );
      }

      this.requireActiveSession(request.door_id, request.epoch, request.session_pubkey);

      // Bound review volume before any host-channel side effects (ReviewGatedDoor).
      if (request.shards.length < 5 || request.shards.length > 20) {
        throw DoorError.fromCode(
          "shard_count",
          `shard_count: expected 5–20 shards, got ${String(request.shards.length)}`
        );
      }

      const payload = cosignReviewSigningPayload(request);
      const requestSig = decodeSignature(request.sig);
      const sessionPublicKey = decodePublicKey(request.session_pubkey);
      if (!verify(payload, requestSig, sessionPublicKey)) {
        throw DoorError.fromCode(
          "signature_invalid",
          "signature_invalid: cosign review request signature failed"
        );
      }
      return;
    }

    if (request.phase === "commit") {
      // Commit may run after departure (quarantine window), including while a later
      // residency is live: bind to the retained review of `request.epoch` (its session
      // key) instead of requireActiveSession, which fails once retired.
      const state = this.getCosignState(request.epoch);
      if (state === undefined) {
        if (this.lastKnownEpoch !== null && request.epoch < this.lastKnownEpoch) {
          throw DoorError.fromCode(
            "review_not_retained",
            `review_not_retained: no cosign review retained for past epoch ${String(request.epoch)}`,
            { field: "epoch", got: request.epoch }
          );
        }
        throw DoorError.fromCode(
          "review_pending",
          "review_pending: cosign review not completed for this epoch"
        );
      }
      if (request.session_pubkey !== state.sessionPubkey) {
        throw DoorError.fromCode(
          "session_invalid",
          "session_pubkey does not match the review-phase session"
        );
      }

      const payload = cosignCommitSigningPayload(request);
      const requestSig = decodeSignature(request.sig);
      const sessionPublicKey = decodePublicKey(request.session_pubkey);
      if (!verify(payload, requestSig, sessionPublicKey)) {
        throw DoorError.fromCode(
          "signature_invalid",
          "signature_invalid: cosign commit request signature failed"
        );
      }
      return;
    }

    throw DoorError.fromCode(
      "unsupported_phase",
      "unsupported_phase: cosign phase must be review or commit"
    );
  }

  private async cosignReview(
    request: Extract<CosignRequest, { phase: "review" }>
  ): Promise<CosignReviewResponse> {
    this.verifyCosignAuth(request);

    // Authenticated retry of the completed review (lost reply): replay, do not re-review.
    const completed = this.getCosignState(request.epoch);
    if (completed !== undefined) {
      if (completed.reviewResponse === null) {
        // Unreachable: verifyCosignAuth only passes a replayable completed review.
        throw DoorError.fromCode("epoch_closed", "epoch_closed: cosign review already completed");
      }
      return completed.reviewResponse;
    }

    const seenShardIds = new Set<string>();
    for (const shard of request.shards) {
      if (shard.shard_id.length === 0) {
        throw DoorError.fromCode("shard_invalid", "shard_invalid: missing shard_id");
      }
      if (shard.text.length > 500) {
        throw DoorError.fromCode(
          "shard_invalid",
          `shard_invalid: shard ${shard.shard_id} text exceeds 500 chars`
        );
      }
      if (seenShardIds.has(shard.shard_id)) {
        throw DoorError.fromCode(
          "shard_invalid",
          `shard_invalid: duplicate shard_id ${shard.shard_id}`
        );
      }
      seenShardIds.add(shard.shard_id);
    }

    const approvedShards = new Map<string, string>();
    const decisions: ReviewDecision[] = request.shards.map((shard) => {
      const decision = this.resolveShardDecision(shard, request.door_id, request.epoch);
      if (decision.status === "approved") {
        approvedShards.set(shard.shard_id, shard.text);
      }
      return decision;
    });

    const receivedAt = this.clock.now();
    const doorSig = signCanonical(
      {
        door_id: request.door_id,
        epoch: request.epoch,
        phase: request.phase,
        decisions,
        received_at: receivedAt
      },
      this.doorKeypair.privateKey
    );
    const response: CosignReviewResponse = {
      phase: "review",
      door_id: request.door_id,
      epoch: request.epoch,
      decisions,
      received_at: receivedAt,
      door_sig: doorSig
    };

    this.cosignStates.set(request.epoch, {
      approvedShards,
      committed: new Map(),
      epoch: request.epoch,
      sessionPubkey: request.session_pubkey,
      reviewedAt: receivedAt,
      reviewKey: this.cosignReviewKey(request),
      reviewResponse: response
    });
    this.pruneCosignStates();
    this.persistCosignStates(() => {
      this.cosignStates.delete(request.epoch);
    });

    return response;
  }

  private async cosignCommit(
    request: Extract<CosignRequest, { phase: "commit" }>
  ): Promise<CosignCommitResponse> {
    this.verifyCosignAuth(request);

    if (request.core.length === 0) {
      throw DoorError.fromCode("shard_invalid", "shard_invalid: commit core must not be empty");
    }

    // Retained after verifyCosignAuth for commit (no await in between).
    const cosignState = this.getCosignState(request.epoch);
    if (cosignState === undefined) {
      throw DoorError.fromCode(
        "review_pending",
        "review_pending: cosign review not completed for this epoch"
      );
    }

    const approvedText = cosignState.approvedShards.get(request.shard_id);
    if (approvedText === undefined) {
      throw DoorError.fromCode(
        "shard_not_approved",
        `shard_not_approved: shard ${request.shard_id} was not approved in review`
      );
    }

    const seq = await this.assertCommitCoreBound(request.core, cosignState.epoch, approvedText);

    // Single-use approval: one co-signature per chain position. A re-commit is only
    // accepted for a strictly later `seq` (runtime retry after the chain head moved),
    // except an idempotent retry of the same `seq` with byte-identical `core` (the
    // Wanderer lost the reply), which gets the stored response — same `door_cosig`.
    // No await between this check and the update below.
    const last = cosignState.committed.get(request.shard_id);
    if (last !== undefined) {
      if (seq === last.seq && request.core === last.core) {
        return last.response;
      }
      if (seq <= last.seq) {
        throw DoorError.fromCode(
          "shard_not_approved",
          `shard_not_approved: approval for shard ${request.shard_id} already used at seq ${String(last.seq)}`
        );
      }
    }

    const receivedAt = this.clock.now();
    const doorCosig = signDoorCosig(request.core, this.doorKeypair.privateKey);
    const doorSig = signCanonical(
      {
        door_id: request.door_id,
        epoch: request.epoch,
        phase: request.phase,
        shard_id: request.shard_id,
        door_cosig: doorCosig,
        received_at: receivedAt
      },
      this.doorKeypair.privateKey
    );

    const response: CosignCommitResponse = {
      phase: "commit",
      door_id: request.door_id,
      epoch: request.epoch,
      shard_id: request.shard_id,
      door_cosig: doorCosig,
      received_at: receivedAt,
      door_sig: doorSig
    };
    cosignState.committed.set(request.shard_id, { seq, core: request.core, response });
    // Durable before the co-signature leaves the Door; on failure no cosig is returned
    // and the single-use record is rolled back (the retry is then a fresh commit).
    this.persistCosignStates(() => {
      if (last === undefined) {
        cosignState.committed.delete(request.shard_id);
      } else {
        cosignState.committed.set(request.shard_id, last);
      }
    });
    return response;
  }

  private resolveShardDecision(
    shard: CandidateShard,
    doorId: string,
    epoch: number
  ): ReviewDecision {
    const policyResult = this.policy.decideShard?.(shard);
    let decision: ReviewDecision;

    if (policyResult === undefined || policyResult === "approved") {
      decision = { shard_id: shard.shard_id, status: "approved" };
    } else if (policyResult === "rejected") {
      decision = {
        shard_id: shard.shard_id,
        status: "rejected",
        reason: "rejected by host policy"
      };
    } else {
      decision = {
        shard_id: shard.shard_id,
        status: policyResult.status,
        reason: policyResult.reason
      };
    }

    if (this.policy.includeHostAuditSig === true) {
      decision = {
        ...decision,
        host_audit_sig: signCanonical(
          {
            shard_id: shard.shard_id,
            text: shard.text,
            door_id: doorId,
            epoch
          },
          this.doorKeypair.privateKey
        )
      };
    }

    return decision;
  }

  /** OSP residency string for this Door at `epoch` (`door:<door_id>/epoch:<n>`). */
  private residencyFor(epoch: number): string {
    return `door:${this.doorId}/epoch:${String(epoch)}`;
  }

  /**
   * Bind an attest `core` to the request: it must be a canonical OSP `attestation`
   * envelope core whose `body.kind` equals the request `kind`, for this Door's
   * residency at the request epoch (`body.door_id` / `body.epoch` must match; a
   * `body.session_pubkey`, when present, must equal the request `session_pubkey`).
   */
  private assertAttestCoreBound(request: AttestRequest): void {
    const core = parseCanonicalCore(request.core);
    if (core === null) {
      throw DoorError.fromCode("core_invalid", "core_invalid: core is not canonical JSON");
    }
    const body = core.body;
    if (core.type !== "attestation" || !isPlainRecord(body) || body.kind !== request.kind) {
      throw DoorError.fromCode(
        "core_invalid",
        `core_invalid: core must be an attestation record of kind ${request.kind}`
      );
    }
    if (
      core.residency !== this.residencyFor(request.epoch) ||
      body.door_id !== this.doorId ||
      body.epoch !== request.epoch
    ) {
      throw DoorError.fromCode(
        "core_invalid",
        "core_invalid: core residency must match this door and the request epoch"
      );
    }
    if (body.session_pubkey !== undefined && body.session_pubkey !== request.session_pubkey) {
      throw DoorError.fromCode(
        "core_invalid",
        "core_invalid: core session_pubkey must match the request session_pubkey"
      );
    }
  }

  /**
   * Bind a commit `core` to the reviewed shard: canonical OSP `memory` envelope core,
   * `body.kind: "shard"`, residency of the reviewed epoch, and text equal to the
   * approved review text — via `text_hash` (osp/0.2 side blob; `text_cid` must match
   * the hash when present) or inline `text` (osp/0.1). Returns the envelope `seq`.
   */
  private async assertCommitCoreBound(
    rawCore: string,
    epoch: number,
    approvedText: string
  ): Promise<number> {
    const core = parseCanonicalCore(rawCore);
    if (core === null) {
      throw DoorError.fromCode("shard_invalid", "shard_invalid: commit core is not canonical JSON");
    }
    const body = core.body;
    if (core.type !== "memory" || !isPlainRecord(body) || body.kind !== "shard") {
      throw DoorError.fromCode(
        "shard_invalid",
        "shard_invalid: commit core must be a memory record of kind shard"
      );
    }
    if (core.residency !== this.residencyFor(epoch)) {
      throw DoorError.fromCode(
        "shard_invalid",
        "shard_invalid: commit core residency must match the reviewed epoch"
      );
    }
    const seq = core.seq;
    if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 1) {
      throw DoorError.fromCode("shard_invalid", "shard_invalid: commit core seq is invalid");
    }

    if (body.text_hash !== undefined) {
      const expectedHash = await hashBlobBytes(encodeMemoryTextBlob(approvedText));
      const cidOk =
        body.text_cid === undefined ||
        (typeof body.text_cid === "string" && cidMatchesHash(body.text_cid, expectedHash));
      if (body.text_hash !== expectedHash || !cidOk || body.text !== undefined) {
        throw DoorError.fromCode(
          "shard_invalid",
          "shard_invalid: commit core text does not match the reviewed shard"
        );
      }
      return seq;
    }
    if (body.text !== approvedText) {
      throw DoorError.fromCode(
        "shard_invalid",
        "shard_invalid: commit core text does not match the reviewed shard"
      );
    }
    return seq;
  }

  private requireActiveSession(doorId: string, epoch: number, sessionPubkey: string): void {
    if (this.sessionRetired) {
      throw DoorError.fromCode("epoch_closed", "epoch_closed: residency already departed");
    }
    if (this.activeSession === null) {
      throw DoorError.fromCode("session_invalid", "session_invalid: no active session");
    }
    if (this.activeSession.epoch !== epoch) {
      throw DoorError.fromCode(
        "session_invalid",
        `session_invalid: epoch mismatch expected ${String(this.activeSession.epoch)}, got ${String(epoch)}`
      );
    }
    if (this.activeSession.sessionPubkey !== sessionPubkey) {
      throw DoorError.fromCode("session_invalid", "session_invalid: session_pubkey mismatch");
    }
    if (doorId !== this.doorId) {
      throw DoorError.fromCode(
        "session_invalid",
        `session_invalid: door_id mismatch expected ${this.doorId}, got ${doorId}`
      );
    }
  }

  /**
   * Reject Wanderer `issued_at` outside the configured absolute skew of Door clock.
   * Invalid / non-ISO timestamps are treated as stale.
   */
  private assertIssuedAtFresh(issuedAt: string): void {
    const issuedMs = parseIsoToMs(issuedAt);
    const nowMs = parseIsoToMs(this.clock.now());
    if (issuedMs === null || nowMs === null) {
      throw DoorError.fromCode(
        "timestamp_stale",
        "timestamp_stale: issued_at is not a valid ISO 8601 timestamp",
        { field: "issued_at", got: issuedAt }
      );
    }
    const skew = Math.abs(nowMs - issuedMs);
    if (skew > this.maxIssuedAtSkewMs) {
      // Omit door_now from details: this check runs before request-sig verification,
      // so echoing the Door clock would let unauthenticated callers probe it.
      throw DoorError.fromCode(
        "timestamp_stale",
        `timestamp_stale: issued_at skew ${String(skew)}ms exceeds max ${String(this.maxIssuedAtSkewMs)}ms`,
        {
          field: "issued_at",
          got: issuedAt,
          max_skew_ms: this.maxIssuedAtSkewMs
        }
      );
    }
  }

  /** Retained completed review for `epoch` after applying retention bounds. */
  private getCosignState(epoch: number): CosignEpochState | undefined {
    this.pruneCosignStates();
    return this.cosignStates.get(epoch);
  }

  /**
   * Evict reviews older than the retention age, then the lowest epochs beyond the
   * retention count. In-memory only; the next save persists the pruned set.
   */
  private pruneCosignStates(): void {
    if (this.cosignStates.size === 0) {
      return;
    }
    const nowMs = parseIsoToMs(this.clock.now());
    if (nowMs !== null) {
      for (const [epoch, state] of this.cosignStates) {
        const reviewedMs = parseIsoToMs(state.reviewedAt);
        if (reviewedMs === null || nowMs - reviewedMs > this.retainMs) {
          this.cosignStates.delete(epoch);
        }
      }
    }
    if (this.cosignStates.size > this.retainEpochs) {
      const epochs = [...this.cosignStates.keys()].sort((a, b) => a - b);
      for (const epoch of epochs.slice(0, epochs.length - this.retainEpochs)) {
        this.cosignStates.delete(epoch);
      }
    }
  }

  /**
   * Save retained review state to the {@link CosignStateStore}, if any. On failure run
   * `rollback` (undo the in-memory change being persisted) and throw `internal_error`.
   */
  private persistCosignStates(rollback: () => void): void {
    const store = this.cosignStateStore;
    if (store === null) {
      return;
    }
    const snapshot: PersistedCosignState = {
      version: 1,
      door_id: this.doorId,
      epochs: [...this.cosignStates.values()]
        .sort((a, b) => a.epoch - b.epoch)
        .map((state) => ({
          epoch: state.epoch,
          session_pubkey: state.sessionPubkey,
          reviewed_at: state.reviewedAt,
          approved: [...state.approvedShards].map(([shardId, text]) => ({
            shard_id: shardId,
            text
          })),
          committed: [...state.committed].map(([shardId, entry]) => ({
            shard_id: shardId,
            seq: entry.seq,
            core: entry.core,
            response: entry.response
          }))
        }))
    };
    try {
      store.save(snapshot);
    } catch (error: unknown) {
      rollback();
      throw DoorError.fromCode(
        "internal_error",
        "internal_error: failed to persist cosign review state",
        undefined,
        error
      );
    }
  }

  /** Install state loaded from the {@link CosignStateStore} (throws on invalid / foreign state). */
  private restoreCosignStates(raw: unknown): void {
    if (raw === null) {
      return;
    }
    const parsed = PersistedCosignStateSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`invalid persisted cosign review state: ${parsed.error.message}`);
    }
    if (parsed.data.door_id !== this.doorId) {
      throw new Error(
        `persisted cosign review state belongs to door ${parsed.data.door_id}, not ${this.doorId}`
      );
    }
    for (const entry of parsed.data.epochs) {
      this.cosignStates.set(entry.epoch, {
        approvedShards: new Map(entry.approved.map((shard) => [shard.shard_id, shard.text])),
        committed: new Map(
          entry.committed.map((commit) => [
            commit.shard_id,
            { seq: commit.seq, core: commit.core, response: commit.response }
          ])
        ),
        epoch: entry.epoch,
        sessionPubkey: entry.session_pubkey,
        reviewedAt: entry.reviewed_at,
        reviewKey: null,
        reviewResponse: null
      });
    }
    // Arrival replay guard survives a restart: no epoch at or below a reviewed (hence
    // departed) epoch may arrive again, and past-epoch commits keep their 410 semantics.
    for (const entry of parsed.data.epochs) {
      if (this.lastKnownEpoch === null || entry.epoch > this.lastKnownEpoch) {
        this.lastKnownEpoch = entry.epoch;
      }
    }
  }

  private emitSessionLifecycle(event: SessionLifecycleEvent): void {
    this.sessionLifecycleListener?.(event);
  }
}

/** True for a non-null, non-array JSON object. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse an OSP `core` string; null unless it is a JSON object whose canonical
 * serialization equals the input bytes (no parser differentials between what the
 * Door checks and what it signs).
 */
function parseCanonicalCore(core: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(core) as unknown;
  } catch {
    return null;
  }
  if (!isPlainRecord(parsed)) {
    return null;
  }
  try {
    if (new TextDecoder().decode(canonicalize(parsed)) !== core) {
      return null;
    }
  } catch {
    return null;
  }
  return parsed;
}

/** Parse an ISO 8601 timestamp to epoch milliseconds; null when invalid. */
function parseIsoToMs(value: string): number | null {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    return null;
  }
  return ms;
}

/** Read `protocol_version` from an untyped hello request body, if present. */
function readProtocolVersion(req: unknown): unknown {
  if (typeof req !== "object" || req === null || !("protocol_version" in req)) {
    return undefined;
  }
  return Reflect.get(req, "protocol_version");
}
