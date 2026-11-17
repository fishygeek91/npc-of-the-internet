import type { Capability, CommunityDescriptor } from "./schemas.js";
import type { WitnessMemory } from "./witness.js";

/** Host-configurable policy hooks for Door discovery and residency. */
export interface HostPolicy {
  /** Community descriptor returned by /door/hello */
  community: CommunityDescriptor;
  /**
   * Capabilities advertised in hello. `attest.memory` is added automatically when
   * {@link witnessMemory} is set (and dropped when it is not).
   */
  capabilities: readonly Capability[];
  /** If false/throws, hello returns door_unavailable. Default true. */
  isAvailable?(): boolean | Promise<boolean>;
  /** Optional gate for arrival attest; default accept. */
  acceptArrival?(args: {
    epoch: number;
    sessionPubkey: string;
    core: string;
  }): void | Promise<void>;
  /**
   * The Door's memory witness (`attest.memory`). Unset = this Door does not witness
   * memories, so the Wanderer forms none here. Reference: {@link createAiWitness}.
   */
  witnessMemory?: WitnessMemory;
}
