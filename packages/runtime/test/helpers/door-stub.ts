import { Door, DoorError, type HostPolicy } from "@npc/door-sdk";
import type { Ed25519Keypair } from "@npc/osp-core";

import { SessionError } from "../../src/session/errors.js";
import type {
  AttestRequest,
  AttestResponse,
  Clock,
  CosignCandidateShard,
  CosignRequest,
  CosignResponse,
  DoorConnection,
  HeartbeatRequest,
  HeartbeatResponse,
  OutboundFrame
} from "../../src/session/types.js";

/** Thrown by `DoorStub` when a Door contract check fails in tests. */
export class DoorStubError extends SessionError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = "DoorStubError";
  }
}

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

/**
 * In-process Door implementation for integration tests.
 * Thin wrapper around `@npc/door-sdk` `Door` with `DoorStubError` mapping.
 */
export class DoorStub implements DoorConnection {
  private readonly door: Door;

  constructor(options: DoorStubOptions) {
    const policy: HostPolicy = {
      community: {
        name: "test",
        description: "DoorStub community",
        platform: "test",
        invitation_required: false
      },
      capabilities: ["session.text", "heartbeat", "attest", "cosign.manual"],
      decideShard: (shard) => {
        if (options.decide !== undefined) {
          return options.decide(shard);
        }
        if (options.rejectShardIds?.has(shard.shard_id)) {
          return "rejected";
        }
        return "approved";
      }
    };

    this.door = new Door({
      doorId: options.doorId,
      doorKeypair: options.doorKeypair,
      soulPublicKey: options.soulPublicKey,
      clock: options.clock,
      policy
    });
  }

  /** Active session public key after a successful arrival attest, if any. */
  getActiveSessionPubkey(): string | null {
    return this.door.getActiveSessionPubkey();
  }

  async attest(request: AttestRequest): Promise<AttestResponse> {
    return this.wrap(() => this.door.attest(request));
  }

  async heartbeat(request: HeartbeatRequest): Promise<HeartbeatResponse> {
    return this.wrap(() => this.door.heartbeat(request));
  }

  async cosign(request: CosignRequest): Promise<CosignResponse> {
    return this.wrap(() => this.door.cosign(request));
  }

  /**
   * Verify an outbound session frame against the active session public key.
   * Returns `false` when binding or signature checks fail.
   */
  verifyOutbound(frame: OutboundFrame): boolean {
    return this.door.verifyOutbound(frame);
  }

  private async wrap<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof DoorError) {
        throw new DoorStubError(error.message, error);
      }
      throw error;
    }
  }
}
