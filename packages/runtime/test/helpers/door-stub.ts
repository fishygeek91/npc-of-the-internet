import {
  Door,
  type HelloResponse,
  type HostPolicy,
  type WitnessInput,
  type WitnessMemory,
  type WitnessVerdict
} from "@npc/door-sdk";
import type { Ed25519Keypair } from "@npc/osp-core";

import type {
  AttestRequest,
  AttestResponse,
  Clock,
  DoorConnection,
  HeartbeatRequest,
  HeartbeatResponse,
  OutboundFrame
} from "../../src/session/types.js";

/** A witness decision, or `"unavailable"` to make the witness throw (→ `witness_unavailable`). */
export type WitnessDecision = WitnessVerdict | "unavailable";

/**
 * Scriptable memory witness for tests: records every input and answers with `decide`
 * (default: witness everything). `decide` may be swapped between depart attempts.
 */
export class ScriptedWitness {
  readonly calls: WitnessInput[] = [];
  decide: (input: WitnessInput) => WitnessDecision;

  constructor(decide: (input: WitnessInput) => WitnessDecision = () => ({ witnessed: true })) {
    this.decide = decide;
  }

  /** The `HostPolicy.witnessMemory` hook. */
  readonly witness: WitnessMemory = async (input) => {
    this.calls.push(input);
    const decision = this.decide(input);
    if (decision === "unavailable") {
      throw new Error("witness model unreachable");
    }
    return decision;
  };

  /** Texts of every memory the Door was asked to witness, in order. */
  texts(kind?: "shard" | "journal"): string[] {
    return this.calls.filter((call) => kind === undefined || call.kind === kind).map((c) => c.text);
  }
}

export type DoorStubOptions = {
  doorId: string;
  doorKeypair: Ed25519Keypair;
  soulPublicKey: Uint8Array;
  clock: Clock;
  /**
   * Memory witness. Default: a {@link ScriptedWitness} that witnesses everything;
   * `null` = the Door does not witness memories (no `attest.memory`).
   */
  witness?: ScriptedWitness | null;
};

/**
 * In-process Door for integration tests: a thin wrapper around `@npc/door-sdk` `Door`
 * (real signatures, real core binding). Door errors propagate as `DoorError`.
 */
export class DoorStub implements DoorConnection {
  private readonly door: Door;
  /** The scripted witness, or `null` when this Door does not witness memories. */
  readonly witness: ScriptedWitness | null;

  constructor(options: DoorStubOptions) {
    this.witness = options.witness === undefined ? new ScriptedWitness() : options.witness;
    const policy: HostPolicy = {
      community: {
        name: "test",
        description: "DoorStub community",
        platform: "test",
        invitation_required: false
      },
      capabilities: ["session.text", "heartbeat", "attest"],
      ...(this.witness === null ? {} : { witnessMemory: this.witness.witness })
    };

    this.door = new Door({
      doorId: options.doorId,
      doorKeypair: options.doorKeypair,
      soulPublicKey: options.soulPublicKey,
      clock: options.clock,
      policy
    });
  }

  /** True when this Door advertises `attest.memory`. */
  get witnessesMemories(): boolean {
    return this.door.witnessesMemories();
  }

  /** Underlying Door core (inbound frames, residency record, lifecycle listeners). */
  get core(): Door {
    return this.door;
  }

  /** Active session public key after a successful arrival attest, if any. */
  getActiveSessionPubkey(): string | null {
    return this.door.getActiveSessionPubkey();
  }

  hello(request: unknown): Promise<HelloResponse> {
    return this.door.hello(request);
  }

  attest(request: AttestRequest): Promise<AttestResponse> {
    return this.door.attest(request);
  }

  heartbeat(request: HeartbeatRequest): Promise<HeartbeatResponse> {
    return this.door.heartbeat(request);
  }

  /**
   * Verify an outbound session frame against the active session public key.
   * Returns `false` when binding or signature checks fail.
   */
  verifyOutbound(frame: OutboundFrame): boolean {
    return this.door.verifyOutbound(frame);
  }
}
