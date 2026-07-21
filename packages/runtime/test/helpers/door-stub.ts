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
  type AttestRequest,
  type AttestResponse,
  type Clock,
  type DoorConnection,
  type HeartbeatRequest,
  type HeartbeatResponse,
  type OutboundFrame
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

export type DoorStubOptions = {
  doorId: string;
  doorKeypair: Ed25519Keypair;
  soulPublicKey: Uint8Array;
  clock: Clock;
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
  private activeSession: ActiveSession | null = null;
  private lastHeartbeatSeq = 0;

  constructor(options: DoorStubOptions) {
    this.doorId = options.doorId;
    this.doorKeypair = options.doorKeypair;
    this.soulPublicKey = options.soulPublicKey;
    this.clock = options.clock;
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
    } else {
      this.requireActiveSession(request.door_id, request.epoch, request.session_pubkey);
      const sessionPublicKey = decodePublicKey(request.session_pubkey);
      if (!verify(payload, requestSig, sessionPublicKey)) {
        throw new DoorStubError(`${request.kind} attest: invalid session signature`);
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

  private requireActiveSession(doorId: string, epoch: number, sessionPubkey: string): void {
    if (this.activeSession === null) {
      throw new DoorStubError("no active session");
    }
    if (this.activeSession.epoch !== epoch) {
      throw new DoorStubError(
        `epoch mismatch: expected ${String(this.activeSession.epoch)}, got ${String(epoch)}`
      );
    }
    if (this.activeSession.sessionPubkey !== sessionPubkey) {
      throw new DoorStubError("session_pubkey mismatch");
    }
    if (doorId !== this.doorId) {
      throw new DoorStubError(`door_id mismatch: expected ${this.doorId}, got ${doorId}`);
    }
  }
}
