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
  OTHER_CHANNEL_ID,
  testConfig,
  USER_ID
} from "./helpers/harness.js";
import { TestClock } from "./helpers/test-clock.js";

afterEach(async () => {
  await cleanupTempDirs();
});

describe("channel binding", () => {
  it("never relays messages from a different channel id", async () => {
    const gateway = new FakeGateway();
    const clock = new TestClock("2026-07-21T00:00:00.000Z");
    const timer = new FakeTimer();
    const config = await testConfig();
    const store = await genesisStore();
    let session: Session | null = null;

    const handle = await startDiscordDoor({
      config,
      gateway,
      clock,
      disableServers: true,
      sessionBridge: {
        handleInbound: async (frame) => {
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
      brain: new FakeBrain(["should not appear"]),
      clock,
      timer,
      heartbeatIntervalMs: 60_000,
      doorPublicKeys: [DOOR.publicKey]
    });

    const before = gateway.sent.length;
    await gateway.emitMessage({
      id: "other-channel-1",
      guildId: GUILD_ID,
      channelId: OTHER_CHANNEL_ID,
      authorId: USER_ID,
      authorDisplay: "Traveler",
      content: "Wrong channel",
      isBot: false,
      replyToId: undefined
    });

    expect(gateway.sent.length).toBe(before);
    expect(gateway.sent.some((m) => m.content === "should not appear")).toBe(false);

    // Bound channel still works.
    await gateway.emitMessage({
      id: "bound-1",
      guildId: GUILD_ID,
      channelId: CHANNEL_ID,
      authorId: USER_ID,
      authorDisplay: "Traveler",
      content: "Right channel",
      isBot: false,
      replyToId: undefined
    });
    expect(gateway.sent.some((m) => m.content === "should not appear")).toBe(true);

    session.stop();
    await handle.stop();
  });
});
