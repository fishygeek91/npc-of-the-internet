import { FakeBrain, Session, SingleKeyKeyring } from "@npc/runtime";
import { afterEach, describe, expect, it } from "vitest";

import { doorIdForGuild } from "../src/config.js";
import { startDiscordDoor } from "../src/start.js";
import { FakeGateway } from "./helpers/fake-gateway.js";
import { FakeTimer } from "./helpers/fake-timer.js";
import { DOOR, SOUL } from "./helpers/fixed-keys.js";
import {
  CHANNEL_ID,
  cleanupTempDirs,
  genesisStore,
  GUILD_ID,
  testConfig,
  USER_ID
} from "./helpers/harness.js";
import { TestClock } from "./helpers/test-clock.js";

afterEach(async () => {
  await cleanupTempDirs();
});

describe("inbound rate limiting", () => {
  it("drops burst excess without crashing or replying", async () => {
    const gateway = new FakeGateway();
    const clock = new TestClock("2026-07-21T00:00:00.000Z");
    const timer = new FakeTimer();
    const config = await testConfig({
      userRatePerMinute: 60,
      userBurst: 2,
      channelRatePerMinute: 60,
      channelBurst: 2
    });
    const store = await genesisStore();
    let session: Session | null = null;
    let inboundCount = 0;

    const replies = ["r1", "r2", "r3", "r4", "r5"];
    const handle = await startDiscordDoor({
      config,
      gateway,
      clock,
      disableServers: true,
      sessionBridge: {
        handleInbound: async (frame) => {
          inboundCount += 1;
          if (session === null) {
            return null;
          }
          const result = await session.handleInbound(frame);
          return result.ok ? result.outbound : null;
        }
      }
    });

    session = await Session.start({
      store,
      door: handle.connection,
      doorId: doorIdForGuild(GUILD_ID),
      keyring: new SingleKeyKeyring(SOUL.privateKey),
      brain: new FakeBrain(replies),
      clock,
      timer,
      heartbeatIntervalMs: 60_000,
      doorPublicKeys: [DOOR.publicKey]
    });

    for (let i = 0; i < 5; i += 1) {
      await gateway.emitMessage({
        id: `burst-${String(i)}`,
        guildId: GUILD_ID,
        channelId: CHANNEL_ID,
        authorId: USER_ID,
        authorDisplay: "Burst",
        content: `msg ${String(i)}`,
        isBot: false,
        replyToId: undefined
      });
    }

    // Burst of 2: only two inbounds/replies; excess dropped silently.
    expect(inboundCount).toBe(2);
    expect(gateway.sent.filter((m) => m.content.startsWith("r")).length).toBe(2);

    session.stop();
    await handle.stop();
  });
});
