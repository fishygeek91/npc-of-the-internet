import { DoorError } from "@npc/door-sdk";
import { FakeBrain, Session, SingleKeyKeyring } from "@npc/runtime";
import { afterEach, describe, expect, it } from "vitest";

import { doorIdForGuild } from "../src/config.js";
import { DiscordDoorError, operatorNotice } from "../src/errors.js";
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

describe("error surfacing", () => {
  it("maps errors to short operator notices without stacks or payloads", () => {
    expect(
      operatorNotice(new DiscordDoorError("invalid_config", "DOOR_KEY_PATH is required"))
    ).toBe("Door error (invalid_config): DOOR_KEY_PATH is required");
    const notice = operatorNotice(
      DoorError.fromCode("session_invalid", "session_invalid: no active session")
    );
    expect(notice).toContain("session_invalid");
    expect(notice).not.toMatch(/at \S+/);
  });

  it("posts an operator notice and stays up when inbound delivery throws DoorError", async () => {
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
        handleInbound: async () => {
          throw DoorError.fromCode("internal_error", "simulated delivery failure");
        }
      }
    });

    session = await Session.start({
      store,
      door: handle.connection,
      doorId: doorIdForGuild(GUILD_ID),
      keyring: new SingleKeyKeyring(SOUL.privateKey),
      brain: new FakeBrain(["unused"]),
      clock,
      timer,
      heartbeatIntervalMs: 60_000,
      doorPublicKeys: [DOOR.publicKey]
    });

    await gateway.emitMessage({
      id: "m1",
      guildId: GUILD_ID,
      channelId: CHANNEL_ID,
      authorId: USER_ID,
      authorDisplay: "U",
      content: "hello",
      isBot: false,
      replyToId: undefined
    });

    expect(gateway.sent.some((m) => m.content.includes("simulated delivery failure"))).toBe(true);
    // Adapter still responds to status — stayed up.
    expect(handle.status().present).toBe(true);

    session.stop();
    await handle.stop();
  });
});
