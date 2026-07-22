import {
  decodePublicKey,
  decodeSignature,
  encodePublicKey,
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

/** Configuration for a transport-agnostic Door host core. */
export type DoorOptions = {
  doorId: string;
  doorKeypair: Ed25519Keypair;
  soulPublicKey: Uint8Array;
  clock: Clock;
  policy: HostPolicy;
};

type ActiveSession = {
  epoch: number;
  sessionPubkey: string;
};

type CosignEpochState = {
  reviewCompleted: boolean;
  approvedShardIds: Set<string>;
  /** Bound at review; commit may run after departure using this binding. */
  epoch: number;
  sessionPubkey: string;
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
  private activeSession: ActiveSession | null = null;
  private sessionRetired = false;
  private lastHeartbeatSeq = 0;
  private cosignState: CosignEpochState | null = null;

  constructor(options: DoorOptions) {
    this.doorId = options.doorId;
    this.doorKeypair = options.doorKeypair;
    this.soulPublicKey = options.soulPublicKey;
    this.clock = options.clock;
    this.policy = options.policy;
  }

  /** Active session public key after a successful arrival attest, if any. */
  getActiveSessionPubkey(): string | null {
    return this.activeSession?.sessionPubkey ?? null;
  }

  /** Active residency epoch for hello `active_epoch`, if any. */
  getActiveEpoch(): number | null {
    return this.activeSession?.epoch ?? null;
  }

  /** Current timestamp from the injected clock (for transport-issued frames). */
  now(): string {
    return this.clock.now();
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

    const payload = attestSigningPayload(request);
    const requestSig = decodeSignature(request.sig);

    if (request.kind === "arrival") {
      if (!verify(payload, requestSig, this.soulPublicKey)) {
        throw DoorError.fromCode("signature_invalid", "arrival attest: invalid soul signature");
      }
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
      this.activeSession = {
        epoch: request.epoch,
        sessionPubkey: request.session_pubkey
      };
      this.sessionRetired = false;
      this.cosignState = null;
      this.lastHeartbeatSeq = 0;
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
      if (request.kind === "departure") {
        this.activeSession = null;
        this.sessionRetired = true;
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

  private async cosignReview(
    request: Extract<CosignRequest, { phase: "review" }>
  ): Promise<Extract<CosignResponse, { phase: "review" }>> {
    if (this.cosignState !== null && this.cosignState.reviewCompleted) {
      throw DoorError.fromCode(
        "epoch_closed",
        "epoch_closed: cosign review already completed for this epoch"
      );
    }

    this.requireActiveSession(request.door_id, request.epoch, request.session_pubkey);

    if (request.shards.length < 5 || request.shards.length > 20) {
      throw DoorError.fromCode(
        "shard_count",
        `shard_count: expected 5–20 shards, got ${String(request.shards.length)}`
      );
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

    const payload = cosignReviewSigningPayload(request);
    const requestSig = decodeSignature(request.sig);
    const sessionPublicKey = decodePublicKey(request.session_pubkey);
    if (!verify(payload, requestSig, sessionPublicKey)) {
      throw DoorError.fromCode(
        "signature_invalid",
        "signature_invalid: cosign review request signature failed"
      );
    }

    const approvedShardIds = new Set<string>();
    const decisions: ReviewDecision[] = request.shards.map((shard) => {
      const decision = this.resolveShardDecision(shard, request.door_id, request.epoch);
      if (decision.status === "approved") {
        approvedShardIds.add(shard.shard_id);
      }
      return decision;
    });

    this.cosignState = {
      reviewCompleted: true,
      approvedShardIds,
      epoch: request.epoch,
      sessionPubkey: request.session_pubkey
    };

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

    return {
      phase: "review",
      door_id: request.door_id,
      epoch: request.epoch,
      decisions,
      received_at: receivedAt,
      door_sig: doorSig
    };
  }

  private async cosignCommit(
    request: Extract<CosignRequest, { phase: "commit" }>
  ): Promise<Extract<CosignResponse, { phase: "commit" }>> {
    if (this.cosignState === null || !this.cosignState.reviewCompleted) {
      throw DoorError.fromCode(
        "review_pending",
        "review_pending: cosign review not completed for this epoch"
      );
    }

    // Commit may run after departure (quarantine window). Bind to the review
    // session instead of requireActiveSession, which fails once retired.
    if (request.door_id !== this.doorId) {
      throw DoorError.fromCode(
        "session_invalid",
        `door_id mismatch: expected ${this.doorId}, got ${request.door_id}`
      );
    }
    if (request.epoch !== this.cosignState.epoch) {
      throw DoorError.fromCode(
        "session_invalid",
        `epoch mismatch: expected ${String(this.cosignState.epoch)}, got ${String(request.epoch)}`
      );
    }
    if (request.session_pubkey !== this.cosignState.sessionPubkey) {
      throw DoorError.fromCode(
        "session_invalid",
        "session_pubkey does not match the review-phase session"
      );
    }

    if (request.core.length === 0) {
      throw DoorError.fromCode("shard_invalid", "shard_invalid: commit core must not be empty");
    }

    if (!this.cosignState.approvedShardIds.has(request.shard_id)) {
      throw DoorError.fromCode(
        "shard_not_approved",
        `shard_not_approved: shard ${request.shard_id} was not approved in review`
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

    return {
      phase: "commit",
      door_id: request.door_id,
      epoch: request.epoch,
      shard_id: request.shard_id,
      door_cosig: doorCosig,
      received_at: receivedAt,
      door_sig: doorSig
    };
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
}

/** Read `protocol_version` from an untyped hello request body, if present. */
function readProtocolVersion(req: unknown): unknown {
  if (typeof req !== "object" || req === null || !("protocol_version" in req)) {
    return undefined;
  }
  return Reflect.get(req, "protocol_version");
}
