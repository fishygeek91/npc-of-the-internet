import {
  canonicalize,
  cidMatchesHash,
  decodePublicKey,
  decodeSignature,
  encodeJournalBlob,
  encodePublicKey,
  encodeShardTextBlob,
  hashBlobBytes,
  verify,
  type Ed25519Keypair
} from "@npc/osp-core";

import { DoorError } from "./errors.js";
import type { HostPolicy } from "./policy.js";
import {
  DOOR_PROTOCOL_VERSION,
  HelloRequestSchema,
  type AttestRequest,
  type AttestResponse,
  type Clock,
  type ControlFrame,
  type HeartbeatRequest,
  type HeartbeatResponse,
  type HelloResponse,
  type InboundFrame,
  type OutboundFrame,
  type SessionBindParams
} from "./schemas.js";
import {
  attestSigningPayload,
  heartbeatSigningPayload,
  outboundSigningPayload,
  sessionBindSigningPayload,
  signCanonical,
  signDoorCosig
} from "./signing.js";
import { ResidencyRecord, type ResidencyRecordOptions } from "./residency-record.js";
import type { MemoryKind } from "./witness.js";

/** Default ±skew for Wanderer `issued_at` vs Door clock (5 minutes). */
export const DEFAULT_MAX_ISSUED_AT_SKEW_MS = 300_000;

/**
 * Accepted outbound `msg_id`s remembered per epoch for replay rejection (oldest
 * evicted first). Combined with the `issued_at` freshness window this bounds replay.
 */
export const OUTBOUND_MSG_ID_MEMORY = 10_000;

/**
 * Session lifecycle event: an epoch began here (`arrived`), departed (`retired`), or was
 * replaced by a newer arrival (`superseded` — e.g. the Wanderer restarted).
 */
export type SessionLifecycleEvent = {
  type: "arrived" | "retired" | "superseded";
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
  /** Bounds on the in-memory residency record the witness reads (default 120 000 chars). */
  residencyRecord?: ResidencyRecordOptions;
};

type ActiveSession = {
  epoch: number;
  sessionPubkey: string;
};

type UnsignedHeartbeatFields = Omit<HeartbeatRequest, "sig">;

type UnsignedOutboundFrame = Omit<OutboundFrame, "sig">;

type UnsignedControlFrame = Omit<ControlFrame, "sig">;

/**
 * Transport-agnostic Door host core implementing discovery, attest (presence and
 * witnessed memory), heartbeat, session binding, and WebSocket frame helpers per
 * `spec/door/api.md` (`door/0.2`).
 *
 * The Door keeps an in-memory {@link ResidencyRecord} of the active epoch (community
 * messages relayed inbound, Wanderer messages delivered outbound) — the only material
 * its witness may judge memories against. It is cleared when the epoch ends.
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
  private readonly sessionLifecycleListeners = new Set<(event: SessionLifecycleEvent) => void>();
  private sessionEndMsgCounter = 0;
  /** Outbound `msg_id`s accepted for the active epoch (bounded; reset on arrival). */
  private readonly seenOutboundMsgIds = new Set<string>();
  /** What happened in the active epoch, as this Door saw it (witness input). */
  private readonly transcript: ResidencyRecord;

  constructor(options: DoorOptions) {
    this.doorId = options.doorId;
    this.doorKeypair = options.doorKeypair;
    this.soulPublicKey = options.soulPublicKey;
    this.clock = options.clock;
    this.policy = options.policy;
    this.maxIssuedAtSkewMs = options.maxIssuedAtSkewMs ?? DEFAULT_MAX_ISSUED_AT_SKEW_MS;
    this.transcript = new ResidencyRecord(options.residencyRecord);
  }

  /** True when this Door witnesses memories (`attest.memory`). */
  witnessesMemories(): boolean {
    return this.policy.witnessMemory !== undefined;
  }

  /** Advertised capabilities: the policy's list, plus `attest.memory` when a witness is set. */
  capabilities(): string[] {
    const capabilities: string[] = this.policy.capabilities.filter(
      (value) => value !== "attest.memory"
    );
    if (this.witnessesMemories()) {
      capabilities.push("attest.memory");
    }
    return capabilities;
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
   * Subscribe to session lifecycle events (arrival, departure, supersession). Transports
   * (e.g. WS) use this to close stale sockets; platform adapters to announce presence.
   * Listener errors are swallowed. Returns an unsubscribe function.
   */
  addSessionLifecycleListener(listener: (event: SessionLifecycleEvent) => void): () => void {
    this.sessionLifecycleListeners.add(listener);
    return () => {
      this.sessionLifecycleListeners.delete(listener);
    };
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
      capabilities: this.capabilities(),
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


  /**
   * `POST /door/attest` — verify soul/session signatures, bind `core` to the request,
   * witness memories, and produce the Door co-signature over `core`.
   */
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
      this.lastHeartbeatSeq = 0;
      this.seenOutboundMsgIds.clear();
      this.transcript.clear();
      this.lastKnownEpoch = request.epoch;
      this.emitSessionLifecycle({ type: "arrived", doorId: this.doorId, epoch: request.epoch });
    } else {
      this.assertSessionRequest(request, payload, requestSig);
      if (request.kind === "memory") {
        await this.witness(request);
        // The witness may take seconds: the session must still be the one that asked.
        this.assertSessionRequest(request, payload, requestSig);
      } else {
        this.assertAttestCoreBound(request);
      }
      if (request.kind === "departure") {
        const departedEpoch = request.epoch;
        this.activeSession = null;
        this.sessionRetired = true;
        this.transcript.clear();
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

  /** Lines the active epoch's residency record currently holds (ops / tests). */
  residencyRecordSize(): number {
    return this.transcript.size();
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
    if (frame.body.text !== undefined) {
      this.transcript.record({ role: "wanderer", text: frame.body.text, at: frame.issued_at });
    }
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

    const issuedAt = this.clock.now();
    this.transcript.record({
      role: "community",
      author: args.body.author_display ?? args.body.author_id,
      text: args.body.text,
      at: issuedAt
    });
    return {
      type: "inbound",
      door_id: this.doorId,
      epoch: this.activeSession.epoch,
      msg_id: args.msg_id,
      issued_at: issuedAt,
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

  /** Session-bound (non-arrival) attest: active session, matching epoch, session signature. */
  private assertSessionRequest(
    request: AttestRequest,
    payload: Uint8Array,
    requestSig: Uint8Array
  ): void {
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
  }

  /**
   * Witness a `memory` attest: bind `core` to `text`, then ask the host witness to judge
   * `text` against this Door's own record of the residency. Declines are final
   * (`witness_declined`); a witness that cannot decide is `witness_unavailable`.
   */
  private async witness(request: AttestRequest): Promise<void> {
    const witnessMemory = this.policy.witnessMemory;
    if (witnessMemory === undefined) {
      throw DoorError.fromCode(
        "unsupported_kind",
        "unsupported_kind: this door does not witness memories (attest.memory)"
      );
    }
    const text = request.text;
    if (text === undefined) {
      throw DoorError.fromCode("invalid_request", "invalid_request: memory attest requires text");
    }
    const kind = await this.assertMemoryCoreBound(request, text);

    let verdict: Awaited<ReturnType<typeof witnessMemory>>;
    try {
      verdict = await witnessMemory({
        doorId: this.doorId,
        epoch: request.epoch,
        kind,
        text,
        transcript: this.transcript.lines()
      });
    } catch (error) {
      if (error instanceof DoorError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : "witness failed";
      throw DoorError.fromCode(
        "witness_unavailable",
        `witness_unavailable: ${message}`,
        undefined,
        error
      );
    }
    if (!verdict.witnessed) {
      throw DoorError.fromCode(
        "witness_declined",
        `witness_declined: ${verdict.reason}`,
        { reason: verdict.reason }
      );
    }
  }

  /** OSP residency string for this Door at `epoch` (`door:<door_id>/epoch:<n>`). */
  private residencyFor(epoch: number): string {
    return `door:${this.doorId}/epoch:${String(epoch)}`;
  }


  /**
   * Bind an attestation `core` to the request: it must be a canonical OSP `attestation`
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
   * Bind a `memory` attest `core` to its prose: canonical `osp/0.2` memory core of this
   * Door's residency at the request epoch, whose body is exactly a shard
   * (`text_cid`, `text_hash`, `distilled_at`) or a journal (`journal_cid`, `journal_hash`,
   * `written_at`) and whose hash is the side-blob hash of `text`. Returns the kind.
   */
  private async assertMemoryCoreBound(request: AttestRequest, text: string): Promise<MemoryKind> {
    const core = parseCanonicalCore(request.core);
    if (core === null) {
      throw DoorError.fromCode("core_invalid", "core_invalid: core is not canonical JSON");
    }
    const body = core.body;
    if (
      core.spec !== "osp/0.2" ||
      core.type !== "memory" ||
      !isPlainRecord(body) ||
      core.residency !== this.residencyFor(request.epoch)
    ) {
      throw DoorError.fromCode(
        "core_invalid",
        "core_invalid: core must be an osp/0.2 memory record of this door's residency at the request epoch"
      );
    }
    const keys = Object.keys(body).sort().join(",");
    let kind: MemoryKind;
    let blob: Uint8Array;
    let hashField: unknown;
    let cidField: unknown;
    try {
      if (body.kind === "shard" && keys === "distilled_at,kind,text_cid,text_hash") {
        kind = "shard";
        blob = encodeShardTextBlob(text);
        hashField = body.text_hash;
        cidField = body.text_cid;
      } else if (body.kind === "journal" && keys === "journal_cid,journal_hash,kind,written_at") {
        kind = "journal";
        blob = encodeJournalBlob(text);
        hashField = body.journal_hash;
        cidField = body.journal_cid;
      } else {
        throw new Error("unsupported memory body");
      }
    } catch {
      throw DoorError.fromCode(
        "core_invalid",
        "core_invalid: memory core must be a shard or journal body (and shard text ≤ 500 code points)"
      );
    }
    const expectedHash = await hashBlobBytes(blob);
    if (
      hashField !== expectedHash ||
      typeof cidField !== "string" ||
      !cidMatchesHashSafe(cidField, expectedHash)
    ) {
      throw DoorError.fromCode(
        "core_invalid",
        "core_invalid: memory core does not reference the submitted text"
      );
    }
    return kind;
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


  private emitSessionLifecycle(event: SessionLifecycleEvent): void {
    for (const listener of [...this.sessionLifecycleListeners]) {
      try {
        listener(event);
      } catch {
        // A failing listener must not break the protocol path.
      }
    }
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

/** {@link cidMatchesHash} that never throws on malformed input. */
function cidMatchesHashSafe(cid: string, hash: string): boolean {
  try {
    return cidMatchesHash(cid, hash);
  } catch {
    return false;
  }
}

/** Read `protocol_version` from an untyped hello request body, if present. */
function readProtocolVersion(req: unknown): unknown {
  if (typeof req !== "object" || req === null || !("protocol_version" in req)) {
    return undefined;
  }
  return Reflect.get(req, "protocol_version");
}
