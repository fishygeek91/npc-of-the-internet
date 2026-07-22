import { afterEach, describe, expect, it } from "vitest";

import { doorIdForGuild } from "../src/config.js";
import { formatStatusReply } from "../src/status.js";
import { startDiscordDoor } from "../src/start.js";
import { FakeGateway } from "./helpers/fake-gateway.js";
import { MutableClock } from "./helpers/mutable-clock.js";
import {
  cleanupTempDirs,
  TEST_CHANNEL_ID,
  TEST_GUILD_ID,
  TEST_OPERATOR_ID,
  writeTempDoorKey
} from "./helpers/test-env.js";
import { SOUL } from "./helpers/fixed-keys.js";

afterEach(async () => {
  await cleanupTempDirs();
});

describe("formatStatusReply", () => {
  it("formats a present door with epoch and pending review count", () => {
    const reply = formatStatusReply({
      present: true,
      doorId: "discord:123456789012345678",
      epoch: 3,
      sessionLive: true,
      pendingReviewCount: 2
    });

    expect(reply).toContain("presence: present");
    expect(reply).toContain("epoch: 3");
    expect(reply).toContain("session: live");
    expect(reply).toContain("pending review shards: 2");
  });

  it("formats an absent door before arrival", () => {
    const reply = formatStatusReply({
      present: false,
      doorId: "discord:123456789012345678",
      epoch: null,
      sessionLive: false,
      pendingReviewCount: 0
    });

    expect(reply).toContain("presence: absent");
    expect(reply).toContain("epoch: none");
    expect(reply).toContain("session: not live");
    expect(reply).toContain("pending review shards: 0");
  });
});

describe("startDiscordDoor status command", () => {
  it("replies absent before the Wanderer has arrived", async () => {
    const doorKeyPath = await writeTempDoorKey();
    const gateway = new FakeGateway();
    const clock = new MutableClock(0);

    const handle = await startDiscordDoor({
      config: {
        botToken: "test-bot-token",
        guildId: TEST_GUILD_ID,
        channelId: TEST_CHANNEL_ID,
        operatorIds: [TEST_OPERATOR_ID],
        doorKeyPath,
        soulPublicKey: SOUL.publicKey,
        httpHost: "127.0.0.1",
        httpPort: 9090,
        reviewTimeoutMs: 300_000,
        userRatePerMinute: 20,
        userBurst: 5,
        channelRatePerMinute: 60,
        channelBurst: 15,
        communityName: "Discord Door",
        communityDescription: "A Discord channel hosting the Wanderer."
      },
      gateway,
      clock,
      sleep: async () => {
        await Promise.resolve();
      },
      disableServers: true
    });

    try {
      await gateway.emitCommand({
        kind: "status",
        interactionId: "ix-status",
        userId: TEST_OPERATOR_ID,
        ephemeral: true
      });

      expect(gateway.ephemerals).toHaveLength(1);
      const reply = gateway.ephemerals[0];
      if (reply === undefined) {
        throw new Error("missing ephemeral status reply");
      }

      expect(reply.content).toContain("presence: absent");
      expect(reply.content).toContain(`door_id: \`${doorIdForGuild(TEST_GUILD_ID)}\``);
      expect(handle.status().present).toBe(false);

      await gateway.emitCommand({
        kind: "status",
        interactionId: "ix-status-non-op",
        userId: "999888777666555444",
        ephemeral: true
      });
      expect(gateway.ephemerals).toHaveLength(2);
      expect(gateway.ephemerals[1]?.content).toBe("Ignored (not an operator).");
    } finally {
      await handle.stop();
    }
  });
});
