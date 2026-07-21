import type { CandidateShard, Capability, CommunityDescriptor, ReviewDecision } from "./schemas.js";

/** Host-configurable policy hooks for Door discovery and residency. */
export interface HostPolicy {
  /** Community descriptor returned by /door/hello */
  community: CommunityDescriptor;
  /** Capabilities advertised in hello */
  capabilities: readonly Capability[];
  /** If false/throws, hello returns door_unavailable. Default true. */
  isAvailable?(): boolean | Promise<boolean>;
  /** Optional gate for arrival attest; default accept. */
  acceptArrival?(args: {
    epoch: number;
    sessionPubkey: string;
    core: string;
  }): void | Promise<void>;
  /** Per-shard review decision; default approve all. */
  decideShard?(
    shard: CandidateShard
  ): "approved" | "rejected" | Pick<ReviewDecision, "status" | "reason">;
  /** When true, attach host_audit_sig over {shard_id, text, door_id, epoch} on approved/rejected decisions. Default false. */
  includeHostAuditSig?: boolean;
}
