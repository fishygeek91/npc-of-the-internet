import type { CandidateShard } from "@npc/door-sdk";
import { describe, expect, it } from "vitest";

import { APPROVE_EMOJI, REJECT_EMOJI, ReviewGate } from "../src/review-gate.js";
import { FakeGateway } from "./helpers/fake-gateway.js";
import { CHANNEL_ID, OPERATOR_ID } from "./helpers/harness.js";
import { TestClock } from "./helpers/test-clock.js";

function shard(id: string): CandidateShard {
  return { shard_id: id, text: `Memory text for ${id}` };
}

const briefSleep = async (ms: number): Promise<void> => {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, Math.min(ms, 10));
  });
};

async function waitForReviewMessage(
  gateway: FakeGateway,
  shardId: string
): Promise<{ id: string; channelId: string; content: string }> {
  for (let i = 0; i < 100; i += 1) {
    const found = gateway.sent.find((m) => m.content.includes(`\`${shardId}\``));
    if (found !== undefined) {
      return found;
    }
    await briefSleep(10);
  }
  throw new Error(`review message for ${shardId} not posted`);
}

describe("ReviewGate approvals", () => {
  it("approves via reaction", async () => {
    const gateway = new FakeGateway();
    await gateway.start();
    const clock = new TestClock("2026-07-21T00:00:00.000Z");
    const gate = new ReviewGate({
      gateway,
      reviewChannelId: CHANNEL_ID,
      operatorIds: new Set([OPERATOR_ID]),
      timeoutMs: 5_000,
      clock,
      sleep: briefSleep
    });
    gateway.onReaction((reaction) => {
      gate.handleReaction(reaction);
    });

    const collect = gate.collect([shard("s1")]);
    const reviewMsg = await waitForReviewMessage(gateway, "s1");
    await gateway.emitReaction({
      messageId: reviewMsg.id,
      channelId: CHANNEL_ID,
      userId: OPERATOR_ID,
      emoji: APPROVE_EMOJI
    });
    await collect;
    expect(gate.decideShard(shard("s1"))).toBe("approved");
  });

  it("approves via command", async () => {
    const gateway = new FakeGateway();
    await gateway.start();
    const clock = new TestClock("2026-07-21T00:00:00.000Z");
    const gate = new ReviewGate({
      gateway,
      reviewChannelId: CHANNEL_ID,
      operatorIds: new Set([OPERATOR_ID]),
      timeoutMs: 5_000,
      clock,
      sleep: briefSleep
    });

    const collect = gate.collect([shard("s2")]);
    await waitForReviewMessage(gateway, "s2");
    gate.handleCommand({
      kind: "approve",
      interactionId: "ix-a",
      userId: OPERATOR_ID,
      shardId: "s2",
      ephemeral: true
    });
    await collect;
    expect(gate.decideShard(shard("s2"))).toBe("approved");
  });

  it("rejects via reaction", async () => {
    const gateway = new FakeGateway();
    await gateway.start();
    const clock = new TestClock("2026-07-21T00:00:00.000Z");
    const gate = new ReviewGate({
      gateway,
      reviewChannelId: CHANNEL_ID,
      operatorIds: new Set([OPERATOR_ID]),
      timeoutMs: 5_000,
      clock,
      sleep: briefSleep
    });
    gateway.onReaction((reaction) => {
      gate.handleReaction(reaction);
    });

    const collect = gate.collect([shard("s3")]);
    const reviewMsg = await waitForReviewMessage(gateway, "s3");
    await gateway.emitReaction({
      messageId: reviewMsg.id,
      channelId: CHANNEL_ID,
      userId: OPERATOR_ID,
      emoji: REJECT_EMOJI
    });
    await collect;
    expect(gate.decideShard(shard("s3"))).toBe("rejected");
  });

  it("ignores approve for a shard id not in the pending round", async () => {
    const gateway = new FakeGateway();
    await gateway.start();
    const clock = new TestClock("2026-07-21T00:00:00.000Z");
    const gate = new ReviewGate({
      gateway,
      reviewChannelId: CHANNEL_ID,
      operatorIds: new Set([OPERATOR_ID]),
      timeoutMs: 5_000,
      clock,
      sleep: briefSleep
    });
    gateway.onReaction((reaction) => {
      gate.handleReaction(reaction);
    });

    const collect = gate.collect([shard("s5")]);
    const reviewMsg = await waitForReviewMessage(gateway, "s5");
    expect(
      gate.handleCommand({
        kind: "approve",
        interactionId: "ix-typo",
        userId: OPERATOR_ID,
        shardId: "typo-id",
        ephemeral: true
      })
    ).toBe(false);

    await gateway.emitReaction({
      messageId: reviewMsg.id,
      channelId: CHANNEL_ID,
      userId: OPERATOR_ID,
      emoji: APPROVE_EMOJI
    });
    await collect;
    expect(gate.decideShard(shard("s5"))).toBe("approved");
  });

  it("rejects on timeout by default", async () => {
    const gateway = new FakeGateway();
    await gateway.start();
    const clock = new TestClock("2026-07-21T00:00:00.000Z");
    const gate = new ReviewGate({
      gateway,
      reviewChannelId: CHANNEL_ID,
      operatorIds: new Set([OPERATOR_ID]),
      timeoutMs: 50,
      clock,
      sleep: async () => {
        clock.advanceMs(50);
      }
    });

    await gate.collect([shard("s4")]);
    expect(gate.decideShard(shard("s4"))).toBe("rejected");
  });
});
