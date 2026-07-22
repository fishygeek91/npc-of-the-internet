import type { CandidateShard } from "@npc/door-sdk";

import type { DiscordGateway, GatewayCommand, GatewayReaction } from "./discord/gateway.js";

/** Approve emoji for reaction-based cosign review. */
export const APPROVE_EMOJI = "✅";
/** Reject emoji for reaction-based cosign review. */
export const REJECT_EMOJI = "❌";

export type ShardDecision = "approved" | "rejected";

export type ReviewGateClock = {
  nowMs(): number;
};

export type ReviewGateSleep = (ms: number) => Promise<void>;

export type ReviewGateOptions = {
  gateway: DiscordGateway;
  /** Channel (or thread) where candidate shards are posted for operator review. */
  reviewChannelId: string;
  operatorIds: ReadonlySet<string>;
  /** After this many ms without a decision, the shard is rejected (safe default). */
  timeoutMs: number;
  clock: ReviewGateClock;
  sleep: ReviewGateSleep;
  /** Optional logger hook for debug (dropped/timeout events). */
  debug?: (message: string, fields?: Record<string, string | number | boolean>) => void;
};

type PendingReview = {
  remaining: Set<string>;
  messageToShard: Map<string, string>;
  resolve: () => void;
};

/**
 * Collects host cosign decisions from Discord reactions/commands.
 *
 * **Timeout default is `rejected`:** a host who ignores review must not
 * silently endorse memories. Document this in operator docs and status text.
 *
 * `decideShard` stays synchronous — call {@link collect} before `door.cosign(review)`.
 */
export class ReviewGate {
  private readonly decisions = new Map<string, ShardDecision>();
  private pending: PendingReview | null = null;
  private readonly options: ReviewGateOptions;

  constructor(options: ReviewGateOptions) {
    this.options = options;
  }

  /** Number of shards still awaiting an operator decision. */
  pendingCount(): number {
    return this.pending?.remaining.size ?? 0;
  }

  /**
   * Sync HostPolicy hook: reads decisions populated by {@link collect}.
   * Missing ids reject (fail-closed).
   */
  decideShard(shard: CandidateShard): ShardDecision {
    return this.decisions.get(shard.shard_id) ?? "rejected";
  }

  /**
   * Post each candidate to Discord and wait until every shard is decided or timed out.
   * Clears prior decisions at the start of each review round.
   */
  async collect(shards: readonly CandidateShard[]): Promise<void> {
    this.decisions.clear();
    if (shards.length === 0) {
      return;
    }

    const remaining = new Set(shards.map((shard) => shard.shard_id));
    const messageToShard = new Map<string, string>();

    const done = new Promise<void>((resolve) => {
      this.pending = { remaining, messageToShard, resolve };
    });

    for (const shard of shards) {
      const content = formatShardReviewMessage(shard);
      const posted = await this.options.gateway.sendMessage(this.options.reviewChannelId, content);
      messageToShard.set(posted.id, shard.shard_id);
      await this.options.gateway.addReaction(
        this.options.reviewChannelId,
        posted.id,
        APPROVE_EMOJI
      );
      await this.options.gateway.addReaction(this.options.reviewChannelId, posted.id, REJECT_EMOJI);
    }

    const deadline = this.options.clock.nowMs() + this.options.timeoutMs;
    while (this.pending !== null && this.pending.remaining.size > 0) {
      const now = this.options.clock.nowMs();
      if (now >= deadline) {
        this.applyTimeouts();
        break;
      }
      const waitMs = Math.min(50, deadline - now);
      await this.options.sleep(waitMs);
    }

    await done;
    this.pending = null;
  }

  /** Handle a reaction from Discord (ignore non-operators / unknown messages). */
  handleReaction(reaction: GatewayReaction): void {
    if (!this.options.operatorIds.has(reaction.userId)) {
      return;
    }
    if (this.pending === null) {
      return;
    }
    const shardId = this.pending.messageToShard.get(reaction.messageId);
    if (shardId === undefined) {
      return;
    }

    if (reaction.emoji === APPROVE_EMOJI) {
      this.record(shardId, "approved");
    } else if (reaction.emoji === REJECT_EMOJI) {
      this.record(shardId, "rejected");
    }
  }

  /** Handle `/wanderer approve|reject <shard_id>` from an allowlisted operator. */
  handleCommand(command: GatewayCommand): boolean {
    if (command.kind !== "approve" && command.kind !== "reject") {
      return false;
    }
    if (!this.options.operatorIds.has(command.userId)) {
      return false;
    }
    this.record(command.shardId, command.kind === "approve" ? "approved" : "rejected");
    return true;
  }

  private record(shardId: string, decision: ShardDecision): void {
    if (this.decisions.has(shardId)) {
      return;
    }
    this.decisions.set(shardId, decision);
    const pending = this.pending;
    if (pending === null) {
      return;
    }
    pending.remaining.delete(shardId);
    if (pending.remaining.size === 0) {
      pending.resolve();
    }
  }

  private applyTimeouts(): void {
    const pending = this.pending;
    if (pending === null) {
      return;
    }
    for (const shardId of pending.remaining) {
      this.decisions.set(shardId, "rejected");
      this.options.debug?.("review_timeout_rejected", { shard_id: shardId });
    }
    pending.remaining.clear();
    pending.resolve();
  }
}

/** Format a candidate shard for operator review in-channel. */
export function formatShardReviewMessage(shard: CandidateShard): string {
  return [
    `**Cosign review** — shard \`${shard.shard_id}\``,
    "",
    shard.text,
    "",
    `React ${APPROVE_EMOJI} to approve or ${REJECT_EMOJI} to reject.`,
    "Timeout without a decision **rejects** (safe default).",
    `Or: \`/wanderer approve ${shard.shard_id}\` / \`/wanderer reject ${shard.shard_id}\``
  ].join("\n");
}
