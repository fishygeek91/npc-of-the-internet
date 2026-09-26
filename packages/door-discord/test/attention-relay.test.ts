import { encodePublicKey } from "@npc/osp-core";
import { FakeBrain, Session, SingleKeyKeyring, type InboundFrame } from "@npc/runtime";
import { afterEach, describe, expect, it } from "vitest";

import { doorIdForGuild } from "../src/config.js";
import { renderMentionTokens, WANDERER_MENTION_NAME } from "../src/discord/discord-js-gateway.js";
import type { GatewayMessage } from "../src/discord/gateway.js";
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

function message(id: string, content: string, extra: Partial<GatewayMessage> = {}): GatewayMessage {
  return {
    id,
    guildId: GUILD_ID,
    channelId: CHANNEL_ID,
    authorId: USER_ID,
    authorDisplay: "Traveler",
    content,
    isBot: false,
    replyToId: undefined,
    ...extra
  };
}

/** Door + in-process Session wired through Session.observe (selective attention). */
async function selectiveHarness(script: string[]) {
  const gateway = new FakeGateway();
  const clock = new TestClock("2026-07-21T00:00:00.000Z");
  const config = await testConfig();
  const store = await genesisStore();
  const inbound: InboundFrame[] = [];
  let session: Session | null = null;

  const handle = await startDiscordDoor({
    config,
    gateway,
    clock,
    disableServers: true,
    sessionBridge: {
      handleInbound: async (frame) => {
        inbound.push(frame);
        if (session === null) {
          return null;
        }
        const result = await session.observe(frame);
        return result.kind === "acted" ? result.outbound : null;
      }
    }
  });

  const hello = await handle.door.hello({
    protocol_version: "door/0.1",
    soul_pubkey: encodePublicKey(SOUL.publicKey)
  });
  session = await Session.start({
    store,
    door: handle.connection,
    doorId: doorIdForGuild(GUILD_ID),
    keyring: new SingleKeyKeyring(SOUL.privateKey),
    brain: new FakeBrain(script),
    clock,
    timer: new FakeTimer(),
    heartbeatIntervalMs: 60_000,
    doorPublicKeys: { [doorIdForGuild(GUILD_ID)]: DOOR.publicKey },
    attention: { reactions: hello.capabilities.includes("session.reactions") }
  });

  return {
    gateway,
    inbound,
    stop: async () => {
      session?.stop();
      await handle.stop();
    }
  };
}

describe("selective attention through the Discord Door", () => {
  it("advertises session.reactions + session.addressing", async () => {
    const config = await testConfig();
    const handle = await startDiscordDoor({
      config,
      gateway: new FakeGateway(),
      disableServers: true
    });
    const hello = await handle.door.hello({
      protocol_version: "door/0.1",
      soul_pubkey: encodePublicKey(SOUL.publicKey)
    });
    expect(hello.capabilities).toContain("session.reactions");
    expect(hello.capabilities).toContain("session.addressing");
    await handle.stop();
  });

  it("stays silent in chatter: nothing posted, no typing", async () => {
    const h = await selectiveHarness(['{"say": null, "reply_to": null, "react": null}']);

    await h.gateway.emitMessage(message("d-1", "anyone up for a game later?"));

    expect(h.inbound[0]?.body.addressed).toBe(false);
    expect(h.gateway.sent).toHaveLength(0);
    expect(h.gateway.reactions).toHaveLength(0);
    expect(h.gateway.typing).toHaveLength(0);
    await h.stop();
  });

  it("reacts with an emoji on the right Discord message", async () => {
    const h = await selectiveHarness([
      '{"say": null, "reply_to": null, "react": {"emoji": "😂", "to": "#1"}}'
    ]);

    await h.gateway.emitMessage(message("d-1", "my cat just knocked the router off the shelf"));

    expect(h.gateway.sent).toHaveLength(0);
    expect(h.gateway.reactions).toEqual([{ channelId: CHANNEL_ID, messageId: "d-1", emoji: "😂" }]);
    await h.stop();
  });

  it("@mention is addressed: typing shown, threaded reply resolves to the Discord id", async () => {
    const h = await selectiveHarness(['{"say": "Right here.", "reply_to": "#1", "react": null}']);

    await h.gateway.emitMessage(message("d-7", "Wanderer are you around?", { mentionsBot: true }));

    expect(h.inbound[0]?.body.addressed).toBe(true);
    expect(h.gateway.typing).toEqual([CHANNEL_ID]);
    expect(h.gateway.sent).toEqual([
      { channelId: CHANNEL_ID, content: "Right here.", replyToId: "d-7", id: "msg-1" }
    ]);
    await h.stop();
  });

  it("a Discord reply to the Wanderer's message is addressed and carries its protocol msg_id", async () => {
    const h = await selectiveHarness([
      '{"say": "Hello.", "reply_to": null, "react": null}',
      '{"say": null, "reply_to": null, "react": {"emoji": "❤️", "to": "#3"}}'
    ]);

    await h.gateway.emitMessage(message("d-1", "hey wanderer"));
    const botMessageId = h.gateway.sent[0]?.id;
    expect(botMessageId).toBeDefined();

    await h.gateway.emitMessage(message("d-2", "nice to meet you", { replyToId: botMessageId }));

    const replyFrame = h.inbound[1];
    expect(replyFrame?.body.addressed).toBe(true);
    expect(replyFrame?.body.reply_to).toBe("out-1");
    expect(h.gateway.reactions).toEqual([{ channelId: CHANNEL_ID, messageId: "d-2", emoji: "❤️" }]);
    await h.stop();
  });
});

describe("renderMentionTokens", () => {
  const lookup = {
    botId: "999",
    userName: (id: string) => (id === "111" ? "Ada" : undefined),
    channelName: (id: string) => (id === "222" ? "general" : undefined),
    roleName: (id: string) => (id === "333" ? "mods" : undefined)
  };

  it("renders bot, user, role, and channel mentions as screen-safe plain names", () => {
    expect(renderMentionTokens("<@999> hi <@!111>, ask <@&333> in <#222>", lookup)).toBe(
      `${WANDERER_MENTION_NAME} hi Ada, ask mods in #general`
    );
  });

  it("falls back for unknown ids and defuses @everyone/@here", () => {
    expect(renderMentionTokens("<@555> <@&444> <#666> @everyone @here", lookup)).toBe(
      "someone a role a channel everyone here"
    );
  });
});
