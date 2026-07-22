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

describe("bot-loop safety", () => {
  it("ignores the adapter bot and other bots", async () => {
    const gateway = new FakeGateway("bot-self");
    const clock = new TestClock("2026-07-21T00:00:00.000Z");
    const timer = new FakeTimer();
    const config = await testConfig();
    const store = await genesisStore();
    let session: Session | null = null;
    let inboundCount = 0;

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
      brain: new FakeBrain(["human reply"]),
      clock,
      timer,
      heartbeatIntervalMs: 60_000,
      doorPublicKeys: [DOOR.publicKey]
    });

    await gateway.emitMessage({
      id: "bot-self-1",
      guildId: GUILD_ID,
      channelId: CHANNEL_ID,
      authorId: "bot-self",
      authorDisplay: "DoorBot",
      content: "echo",
      isBot: true,
      replyToId: undefined
    });
    await gateway.emitMessage({
      id: "other-bot-1",
      guildId: GUILD_ID,
      channelId: CHANNEL_ID,
      authorId: "other-bot",
      authorDisplay: "OtherBot",
      content: "noise",
      isBot: true,
      replyToId: undefined
    });

    expect(inboundCount).toBe(0);

    await gateway.emitMessage({
      id: "human-1",
      guildId: GUILD_ID,
      channelId: CHANNEL_ID,
      authorId: USER_ID,
      authorDisplay: "Human",
      content: "hello",
      isBot: false,
      replyToId: undefined
    });
    expect(inboundCount).toBe(1);
    expect(gateway.sent.some((m) => m.content === "human reply")).toBe(true);

    session.stop();
    await handle.stop();
  });
});
