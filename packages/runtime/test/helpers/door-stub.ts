import {
  canonicalize,
  decodePublicKey,
  decodeSignature,
  encodeSignature,
  sign,
  verify,
  type Ed25519Keypair
} from "@npc/osp-core";

import { SessionError } from "../../src/session/errors.js";
import {
  attestSigningPayload,
  cosignCommitSigningPayload,
  cosignReviewSigningPayload,
  type AttestRequest,
  type AttestResponse,
  type Clock,
  type CosignCandidateShard,
  type CosignRequest,
  type CosignResponse,
  type DoorConnection,
  type HeartbeatRequest,
  type HeartbeatResponse,
  type OutboundFrame,
  type ReviewDecision
} from "../../src/session/types.js";

/** Thrown by `DoorStub` when a Door contract check fails in tests. */
export class DoorStubError extends SessionError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = "DoorStubError";
  }
}

type ActiveSession = {
  epoch: number;
  sessionPubkey: string;
};

type CosignEpochState = {
  reviewCompleted: boolean;
  approvedShardIds: Set<string>;
};

export type DoorStubOptions = {
  doorId: string;
  doorKeypair: Ed25519Keypair;
  soulPublicKey: Uint8Array;
  clock: Clock;
  /** Per-shard approve/reject during cosign review; defaults to approve all. */
  decide?: (shard: CosignCandidateShard) => "approved" | "rejected";
  /** Reject these shard ids during cosign review when `decide` is not set. */
  rejectShardIds?: ReadonlySet<string>;
};

type UnsignedHeartbeatFields = Omit<HeartbeatRequest, "sig">;

type UnsignedOutboundFrame = Omit<OutboundFrame, "sig">;

function heartbeatSigningPayload(request: UnsignedHeartbeatFields): Uint8Array {
  return canonicalize(request);
}

function outboundSigningPayload(frame: UnsignedOutboundFrame): Uint8Array {
  return canonicalize(frame);
}

/**
 * In-process Door implementation for integration tests.
 * Verifies soul/session signatures and produces door co-signatures per `spec/door/api.md`.
 */
export class DoorStub implements DoorConnection {
  private readonly doorId: string;
  private readonly doorKeypair: Ed25519Keypair;
  private readonly soulPublicKey: Uint8Array;
  private readonly clock: Clock;
  private readonly decide?: (shard: CosignCandidateShard) => "approved" | "rejected";
  private readonly rejectShardIds: ReadonlySet<string>;
  private activeSession: ActiveSession | null = null;
  private sessionRetired = false;
  private lastHeartbeatSeq = 0;
  private cosignState: CosignEpochState | null = null;

  constructor(options: DoorStubOptions) {
    this.doorId = options.doorId;
    this.doorKeypair = options.doorKeypair;
    this.soulPublicKey = options.soulPublicKey;
    this.clock = options.clock;
    this.decide = options.decide;
    this.rejectShardIds = options.rejectShardIds ?? new Set();
  }

  /** Active session public key after a successful arrival attest, if any. */
  getActiveSessionPubkey(): string | null {
    return this.activeSession?.sessionPubkey ?? null;
  }

  async attest(request: AttestRequest): Promise<AttestResponse> {
    if (request.door_id !== this.doorId) {
      throw new DoorStubError(`door_id mismatch: expected ${this.doorId}, got ${request.door_id}`);
    }

    const payload = attestSigningPayload(request);
    const requestSig = decodeSignature(request.sig);

    if (request.kind === "arrival") {
      if (!verify(payload, requestSig, this.soulPublicKey)) {
        throw new DoorStubError("arrival attest: invalid soul signature");
      }
      this.activeSession = {
        epoch: request.epoch,
        sessionPubkey: request.session_pubkey
      };
      this.sessionRetired = false;
      // Clear prior-epoch cosign/heartbeat state so revisit-same-door works (T4.1).
      this.cosignState = null;
      this.lastHeartbeatSeq = 0;
    } else {
      this.requireActiveSession(request.door_id, request.epoch, request.session_pubkey);
      const sessionPublicKey = decodePublicKey(request.session_pubkey);
      if (!verify(payload, requestSig, sessionPublicKey)) {
        throw new DoorStubError(`${request.kind} attest: invalid session signature`);
      }
      if (request.kind === "departure") {
        this.activeSession = null;
        this.sessionRetired = true;
      }
    }

    const receivedAt = this.clock.now();
    const coreBytes = new TextEncoder().encode(request.core);
    const doorCosig = encodeSignature(sign(coreBytes, this.doorKeypair.privateKey));
    const doorSigPayload = canonicalize({
      door_id: request.door_id,
      epoch: request.epoch,
      kind: request.kind,
      door_cosig: doorCosig,
      received_at: receivedAt
    });
    const doorSig = encodeSignature(sign(doorSigPayload, this.doorKeypair.privateKey));

    return {
      door_id: request.door_id,
      epoch: request.epoch,
      kind: request.kind,
      door_cosig: doorCosig,
      received_at: receivedAt,
      door_sig: doorSig
    };
  }

  async heartbeat(request: HeartbeatRequest): Promise<HeartbeatResponse> {
    if (request.door_id !== this.doorId) {
      throw new DoorStubError(`door_id mismatch: expected ${this.doorId}, got ${request.door_id}`);
    }

    this.requireActiveSession(request.door_id, request.epoch, request.session_pubkey);

    if (request.seq <= this.lastHeartbeatSeq) {
      throw new DoorStubError(
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
      throw new DoorStubError("heartbeat: invalid session signature");
    }

    this.lastHeartbeatSeq = request.seq;

    const receivedAt = this.clock.now();
    const accepted = true;
    const doorSigPayload = canonicalize({
      door_id: request.door_id,
      epoch: request.epoch,
      seq: request.seq,
      accepted,
      received_at: receivedAt
    });
    const doorSig = encodeSignature(sign(doorSigPayload, this.doorKeypair.privateKey));

    return {
      door_id: request.door_id,
      epoch: request.epoch,
      seq: request.seq,
      accepted,
      received_at: receivedAt,
      door_sig: doorSig
    };
  }

  async cosign(request: CosignRequest): Promise<CosignResponse> {
    if (request.door_id !== this.doorId) {
      throw new DoorStubError(`door_id mismatch: expected ${this.doorId}, got ${request.door_id}`);
    }

    if (request.phase === "review") {
      return this.cosignReview(request);
    }
    if (request.phase === "commit") {
      return this.cosignCommit(request);
    }

    throw new DoorStubError("unsupported_phase: cosign phase must be review or commit");
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

  private async cosignReview(
    request: Extract<CosignRequest, { phase: "review" }>
  ): Promise<Extract<CosignResponse, { phase: "review" }>> {
    if (this.cosignState !== null && this.cosignState.reviewCompleted) {
      throw new DoorStubError("epoch_closed: cosign review already completed for this epoch");
    }

    this.requireActiveSession(request.door_id, request.epoch, request.session_pubkey);

    if (request.shards.length < 5 || request.shards.length > 20) {
      throw new DoorStubError(
        `shard_count: expected 5–20 shards, got ${String(request.shards.length)}`
      );
    }

    const seenShardIds = new Set<string>();
    for (const shard of request.shards) {
      if (shard.shard_id.length === 0) {
        throw new DoorStubError("shard_invalid: missing shard_id");
      }
      if (shard.text.length > 500) {
        throw new DoorStubError(`shard_invalid: shard ${shard.shard_id} text exceeds 500 chars`);
      }
      if (seenShardIds.has(shard.shard_id)) {
        throw new DoorStubError(`shard_invalid: duplicate shard_id ${shard.shard_id}`);
      }
      seenShardIds.add(shard.shard_id);
    }

    const payload = cosignReviewSigningPayload(request);
    const requestSig = decodeSignature(request.sig);
    const sessionPublicKey = decodePublicKey(request.session_pubkey);
    if (!verify(payload, requestSig, sessionPublicKey)) {
      throw new DoorStubError("signature_invalid: cosign review request signature failed");
    }

    const approvedShardIds = new Set<string>();
    const decisions: ReviewDecision[] = request.shards.map((shard) => {
      const status = this.decideShard(shard);
      if (status === "approved") {
        approvedShardIds.add(shard.shard_id);
        return { shard_id: shard.shard_id, status };
      }
      return {
        shard_id: shard.shard_id,
        status,
        reason: "rejected by host policy"
      };
    });

    this.cosignState = {
      reviewCompleted: true,
      approvedShardIds
    };

    const receivedAt = this.clock.now();
    const doorSigPayload = canonicalize({
      door_id: request.door_id,
      epoch: request.epoch,
      phase: request.phase,
      decisions,
      received_at: receivedAt
    });
    const doorSig = encodeSignature(sign(doorSigPayload, this.doorKeypair.privateKey));

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
      throw new DoorStubError("review_pending: cosign review not completed for this epoch");
    }

    this.requireActiveSession(request.door_id, request.epoch, request.session_pubkey);

    if (request.core.length === 0) {
      throw new DoorStubError("shard_invalid: commit core must not be empty");
    }

    if (!this.cosignState.approvedShardIds.has(request.shard_id)) {
      throw new DoorStubError(
        `shard_not_approved: shard ${request.shard_id} was not approved in review`
      );
    }

    const payload = cosignCommitSigningPayload(request);
    const requestSig = decodeSignature(request.sig);
    const sessionPublicKey = decodePublicKey(request.session_pubkey);
    if (!verify(payload, requestSig, sessionPublicKey)) {
      throw new DoorStubError("signature_invalid: cosign commit request signature failed");
    }

    const receivedAt = this.clock.now();
    const coreBytes = new TextEncoder().encode(request.core);
    const doorCosig = encodeSignature(sign(coreBytes, this.doorKeypair.privateKey));
    const doorSigPayload = canonicalize({
      door_id: request.door_id,
      epoch: request.epoch,
      phase: request.phase,
      shard_id: request.shard_id,
      door_cosig: doorCosig,
      received_at: receivedAt
    });
    const doorSig = encodeSignature(sign(doorSigPayload, this.doorKeypair.privateKey));

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

  private decideShard(shard: CosignCandidateShard): "approved" | "rejected" {
    if (this.decide !== undefined) {
      return this.decide(shard);
    }
    if (this.rejectShardIds.has(shard.shard_id)) {
      return "rejected";
    }
    return "approved";
  }

  private requireActiveSession(doorId: string, epoch: number, sessionPubkey: string): void {
    if (this.sessionRetired) {
      throw new DoorStubError("epoch_closed: residency already departed");
    }
    if (this.activeSession === null) {
      throw new DoorStubError("session_invalid: no active session");
    }
    if (this.activeSession.epoch !== epoch) {
      throw new DoorStubError(
        `session_invalid: epoch mismatch expected ${String(this.activeSession.epoch)}, got ${String(epoch)}`
      );
    }
    if (this.activeSession.sessionPubkey !== sessionPubkey) {
      throw new DoorStubError("session_invalid: session_pubkey mismatch");
    }
    if (doorId !== this.doorId) {
      throw new DoorStubError(
        `session_invalid: door_id mismatch expected ${this.doorId}, got ${doorId}`
      );
    }
  }
}
