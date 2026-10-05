import type { Door, InboundFrame, OutboundFrame } from "@npc/door-sdk";
import {
  Events,
  MessagePayload,
  TextChannel,
  type Client,
  type MessageCreateOptions
} from "discord.js";
import { afterEach, describe, expect, it } from "vitest";

import {
  DISCORD_MESSAGE_MAX_CHARS,
  chunkDiscordMessage,
  clampDiscordMessage
} from "../src/discord/chunk.js";
import { DiscordJsGateway } from "../src/discord/discord-js-gateway.js";
import type { GatewayMessage } from "../src/discord/gateway.js";
import { MESSAGE_ID_MAP_CAPACITY, MessageRelay } from "../src/discord/relay.js";
import { DualRateLimiter } from "../src/rate-limit.js";
import { FakeGateway } from "./helpers/fake-gateway.js";

const GUILD = "g1";
const CHAN = "c1";
const HOSTILE = "hey @everyone @here <@&123456789012345678> <@234567890123456789>";

describe("DiscordJsGateway: no pings, safe replies, bounded length", () => {
  const gateways: DiscordJsGateway[] = [];

  afterEach(async () => {
    while (gateways.length > 0) {
      await gateways.pop()?.stop();
    }
  });

  function gatewayWithMockChannel(): {
    gateway: DiscordJsGateway;
    client: Client;
    sends: MessageCreateOptions[];
    errors: Array<{ event: string; error: unknown }>;
  } {
    const errors: Array<{ event: string; error: unknown }> = [];
    const gateway = new DiscordJsGateway({
      token: "t",
      guildId: GUILD,
      onError: (event, error) => {
        errors.push({ event, error });
      }
    });
    gateways.push(gateway);
    const client = (gateway as unknown as { client: Client }).client;
    const sends: MessageCreateOptions[] = [];
    const channel = {
      isTextBased: () => true,
      isDMBased: () => false,
      send: async (options: MessageCreateOptions) => {
        sends.push(options);
        return { id: `sent-${String(sends.length)}` };
      }
    };
    Object.defineProperty(client.channels, "fetch", { value: async () => channel });
    return { gateway, client, sends, errors };
  }

  /** Resolve the REST body discord.js would send for `options`. */
  function resolveBody(client: Client, options: MessageCreateOptions): Record<string, unknown> {
    const target = Object.create(TextChannel.prototype) as TextChannel;
    Object.defineProperty(target, "client", { value: client });
    Object.defineProperty(target, "messages", { value: { resolveId: (id: string) => id } });
    return new MessagePayload(target, options).resolveBody().body as Record<string, unknown>;
  }

  it("client default and every send suppress all mentions, including the replied user", async () => {
    const { gateway, client, sends } = gatewayWithMockChannel();
    expect(client.options.allowedMentions).toEqual({ parse: [], repliedUser: false });

    await gateway.sendMessage(CHAN, HOSTILE);
    await gateway.sendMessage(CHAN, HOSTILE, { replyToId: "111111111111111111" });
    expect(sends).toHaveLength(2);
    for (const options of sends) {
      expect(options.allowedMentions).toEqual({ parse: [], repliedUser: false });
      const body = resolveBody(client, options);
      expect(body.allowed_mentions).toEqual({ parse: [], replied_user: false });
    }
  });

  it("replies do not fail when the parent message was deleted", async () => {
    const { gateway, client, sends } = gatewayWithMockChannel();
    await gateway.sendMessage(CHAN, "hi", { replyToId: "111111111111111111" });
    expect(sends[0]?.reply).toEqual({
      messageReference: "111111111111111111",
      failIfNotExists: false
    });
    const reference = resolveBody(client, sends[0] ?? {}).message_reference as Record<
      string,
      unknown
    >;
    expect(reference.fail_if_not_exists).toBe(false);
  });

  it("clamps content over Discord's 2000-char limit", async () => {
    const { gateway, sends } = gatewayWithMockChannel();
    await gateway.sendMessage(CHAN, "x".repeat(4000));
    expect(String(sends[0]?.content).length).toBeLessThanOrEqual(DISCORD_MESSAGE_MAX_CHARS);
  });

  it("a throwing message handler is reported, not an unhandled rejection", async () => {
    const { gateway, client, errors } = gatewayWithMockChannel();
    gateway.onMessage(() => {
      throw new Error("boom");
    });
    const fakeMessage = {
      id: "m1",
      guildId: GUILD,
      channelId: CHAN,
      content: "hello",
      author: { id: "u1", username: "u", bot: false },
      member: null,
      reference: null,
      mentions: {
        users: new Map(),
        members: null,
        channels: new Map(),
        roles: new Map(),
        repliedUser: null
      }
    };
    client.emit(Events.MessageCreate, fakeMessage as never);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.event).toBe("message");
  });
});

describe("chunkDiscordMessage", () => {
  it("splits on newline/space boundaries within the limit", () => {
    const text = `${"a".repeat(1500)}\n${"b".repeat(1500)} ${"c".repeat(900)}`;
    const chunks = chunkDiscordMessage(text);
    expect(chunks).toEqual(["a".repeat(1500), "b".repeat(1500), "c".repeat(900)]);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(DISCORD_MESSAGE_MAX_CHARS);
    }
  });

  it("never splits a surrogate pair on a hard split", () => {
    const text = `a${"😀".repeat(1500)}`;
    const chunks = chunkDiscordMessage(text);
    expect(chunks.join("")).toBe(text);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(DISCORD_MESSAGE_MAX_CHARS);
      expect(/[\uD800-\uDBFF]$/u.test(chunk)).toBe(false);
      expect(/^[\uDC00-\uDFFF]/u.test(chunk)).toBe(false);
    }
  });

  it("leaves short text alone and clamps surrogate-safely", () => {
    expect(chunkDiscordMessage("short")).toEqual(["short"]);
    const clamped = clampDiscordMessage(`${"x".repeat(1998)}😀😀`);
    expect(clamped.length).toBeLessThanOrEqual(DISCORD_MESSAGE_MAX_CHARS);
    expect(/[\uD800-\uDBFF]…$/u.test(clamped)).toBe(false);
  });
});

describe("MessageRelay hardening", () => {
  function harness(options?: { frameDoorId?: string }) {
    const gateway = new FakeGateway();
    const inbound: InboundFrame[] = [];
    const warnings: string[] = [];
    let epoch = 1;
    const door = {
      getActiveEpoch: () => epoch,
      handleOutbound: () => undefined,
      createInboundFrame: (a: { msg_id: string; body: InboundFrame["body"] }): InboundFrame => ({
        type: "inbound",
        door_id: options?.frameDoorId ?? "discord:g1",
        epoch,
        msg_id: a.msg_id,
        issued_at: "2026-01-01T00:00:00.000Z",
        body: a.body
      })
    } as unknown as Door;
    const relay = new MessageRelay({
      gateway,
      door,
      doorId: "discord:g1",
      guildId: GUILD,
      channelId: CHAN,
      rateLimiter: new DualRateLimiter(1e9, 1e9, 1e9, 1e9, { nowMs: () => 0 }),
      logger: {
        debug: () => undefined,
        warn: (message) => {
          warnings.push(message);
        }
      },
      deliverInbound: async (frame) => {
        inbound.push(frame);
      }
    });
    relay.attach();
    return {
      gateway,
      relay,
      inbound,
      warnings,
      setEpoch: (next: number) => {
        epoch = next;
      }
    };
  }

  function out(msgId: string, body: OutboundFrame["body"], epoch = 1): OutboundFrame {
    return {
      type: "outbound",
      door_id: "discord:g1",
      epoch,
      msg_id: msgId,
      issued_at: "2026-01-01T00:00:00.000Z",
      body,
      sig: "x"
    };
  }

  function msg(id: string, extra: Partial<GatewayMessage> = {}): GatewayMessage {
    return {
      id,
      guildId: GUILD,
      channelId: CHAN,
      authorId: "u1",
      authorDisplay: "U",
      content: "hello",
      isBot: false,
      replyToId: undefined,
      ...extra
    };
  }

  it("long outbound text is chunked; only the first chunk replies", async () => {
    const h = harness();
    await h.gateway.start();
    await h.gateway.emitMessage(msg("d-1"));
    const target = h.inbound[0]?.msg_id ?? "";
    const text = `${"a".repeat(1900)}\n${"b".repeat(1900)}\n${"c".repeat(190)}`;
    await h.relay.postOutbound(out("out-1", { text, reply_to: target }), true);
    expect(h.gateway.sent.map((m) => m.content.length)).toEqual([1900, 1900, 190]);
    expect(h.gateway.sent[0]?.replyToId).toBe("d-1");
    expect(h.gateway.sent[1]?.replyToId).toBeUndefined();
    expect(h.gateway.sent[2]?.replyToId).toBeUndefined();

    // A reply to the second chunk maps back to the frame's msg_id and is addressed.
    await h.gateway.emitMessage(msg("d-2", { replyToId: h.gateway.sent[1]?.id }));
    expect(h.inbound[1]?.body.reply_to).toBe("out-1");
    expect(h.inbound[1]?.body.addressed).toBe(true);
  });

  it("a reply to an old-epoch message is not aliased to the new session's msg_id", async () => {
    const h = harness();
    await h.gateway.start();
    await h.relay.postOutbound(out("out-1", { text: "old session message" }, 1), true); // msg-1
    h.setEpoch(2);
    await h.relay.postOutbound(out("out-1", { text: "new session message" }, 2), true); // msg-2
    await h.gateway.emitMessage(msg("d-9", { replyToId: "msg-1" }));
    expect(h.inbound[0]?.body.reply_to).not.toBe("out-1");
    // Still recognised as a reply to the Wanderer (addressing survives epochs).
    expect(h.inbound[0]?.body.addressed).toBe(true);
    await h.gateway.emitMessage(msg("d-10", { replyToId: "msg-2" }));
    expect(h.inbound[1]?.body.reply_to).toBe("out-1");
  });

  it("all three id structures stay bounded under msg_id reuse", async () => {
    const h = harness();
    await h.gateway.start();
    for (let round = 0; round < 15; round += 1) {
      for (let n = 1; n <= 100; n += 1) {
        await h.relay.postOutbound(out(`out-${String(n)}`, { text: "x" }), true);
      }
    }
    for (let n = 0; n < 1200; n += 1) {
      await h.gateway.emitMessage(msg(`d-${String(n)}`));
    }
    const sizes = h.relay.messageIdMapSizes();
    expect(sizes.toDiscord).toBeLessThanOrEqual(MESSAGE_ID_MAP_CAPACITY);
    expect(sizes.toProtocol).toBeLessThanOrEqual(MESSAGE_ID_MAP_CAPACITY);
    expect(sizes.selfDiscordIds).toBeLessThanOrEqual(MESSAGE_ID_MAP_CAPACITY);
    // Rebinding a reused msg_id replaced (not accumulated) its reverse entry.
    expect(sizes.toProtocol).toBe(sizes.toDiscord);
  });

  it("an inbound door_id mismatch is logged before any side effect (no throw)", async () => {
    const h = harness({ frameDoorId: "discord:other" });
    await h.gateway.start();
    await expect(h.gateway.emitMessage(msg("d-1", { mentionsBot: true }))).resolves.toBeUndefined();
    expect(h.warnings).toContain("inbound_door_id_mismatch");
    expect(h.inbound).toHaveLength(0);
    expect(h.gateway.typing).toHaveLength(0);
    expect(h.relay.messageIdMapSizes().toDiscord).toBe(0);
  });
});
