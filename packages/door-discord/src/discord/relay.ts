import type { Door, InboundFrame, OutboundFrame } from "@npc/door-sdk";

import { operatorNotice } from "../errors.js";
import type { DualRateLimiter } from "../rate-limit.js";
import { chunkDiscordMessage } from "./chunk.js";
import type { DiscordGateway, GatewayMessage } from "./gateway.js";

export type RelayLogger = {
  debug: (message: string, fields?: Record<string, string | number | boolean>) => void;
  warn: (message: string, fields?: Record<string, string | number | boolean>) => void;
};

export type MessageRelayOptions = {
  gateway: DiscordGateway;
  door: Door;
  doorId: string;
  guildId: string;
  channelId: string;
  rateLimiter: DualRateLimiter;
  logger: RelayLogger;
  /**
   * Deliver an inbound frame to the Wanderer (in-process Session bridge or WS broadcast).
   * Must not throw into Discord event loop — relay catches and posts operator notices.
   */
  deliverInbound: (frame: InboundFrame) => Promise<void>;
  /** Optional: surface DoorError-style failures to the bound channel. */
  notifyOperators?: (notice: string) => Promise<void>;
};

/** How many protocol msg_id ↔ Discord message id bindings the relay remembers. */
export const MESSAGE_ID_MAP_CAPACITY = 1000;

/** Discord snowflakes are 17–20 decimal digits; legacy frames may carry them raw. */
const SNOWFLAKE_PATTERN = /^\d{5,20}$/u;

/**
 * Bounded bidirectional msg_id ↔ Discord id map (oldest bindings evicted first).
 * Lets the Wanderer address messages by protocol `msg_id` while the Door speaks Discord.
 *
 * Partitioned by residency epoch: the runtime's outbound `out-N` counter restarts with
 * every Session (= every epoch), so protocol ids from an older epoch are cleared instead
 * of aliasing new messages. The set of the Wanderer's own Discord message ids survives
 * epochs (reply-to-Wanderer addressing) and is bounded separately.
 */
class MessageIdMap {
  private epoch: number | null = null;
  /** msg_id → Discord ids (first entry is the reply / reaction target). */
  private readonly toDiscord = new Map<string, string[]>();
  private readonly toProtocol = new Map<string, string>();
  private readonly selfDiscordIds = new Set<string>();

  /** Clear protocol bindings when the residency epoch changes. */
  useEpoch(epoch: number): void {
    if (this.epoch === epoch) {
      return;
    }
    this.epoch = epoch;
    this.toDiscord.clear();
    this.toProtocol.clear();
  }

  bind(msgId: string, discordIds: readonly string[], fromSelf: boolean): void {
    if (discordIds.length === 0) {
      return;
    }
    // Rebinding a msg_id drops its previous reverse entries (no orphaned growth).
    this.unbind(msgId);
    this.toDiscord.set(msgId, [...discordIds]);
    for (const discordId of discordIds) {
      const previous = this.toProtocol.get(discordId);
      if (previous !== undefined && previous !== msgId) {
        this.unbind(previous);
      }
      this.toProtocol.set(discordId, msgId);
      if (fromSelf) {
        this.selfDiscordIds.delete(discordId);
        this.selfDiscordIds.add(discordId);
      }
    }
    while (this.toDiscord.size > MESSAGE_ID_MAP_CAPACITY) {
      const oldest = this.toDiscord.keys().next();
      if (oldest.done === true) {
        break;
      }
      this.unbind(oldest.value);
    }
    while (this.selfDiscordIds.size > MESSAGE_ID_MAP_CAPACITY) {
      const oldest = this.selfDiscordIds.values().next();
      if (oldest.done === true) {
        break;
      }
      this.selfDiscordIds.delete(oldest.value);
    }
  }

  discordIdFor(msgId: string): string | undefined {
    const mapped = this.toDiscord.get(msgId)?.[0];
    if (mapped !== undefined) {
      return mapped;
    }
    // Legacy: some frames carry a raw Discord id (e.g. an echoed inbound reply_to).
    return SNOWFLAKE_PATTERN.test(msgId) ? msgId : undefined;
  }

  protocolIdFor(discordId: string): string | undefined {
    return this.toProtocol.get(discordId);
  }

  isSelf(discordId: string): boolean {
    return this.selfDiscordIds.has(discordId);
  }

  /** Sizes of the three internal structures (tests / diagnostics). */
  sizes(): { toDiscord: number; toProtocol: number; selfDiscordIds: number } {
    return {
      toDiscord: this.toDiscord.size,
      toProtocol: this.toProtocol.size,
      selfDiscordIds: this.selfDiscordIds.size
    };
  }

  private unbind(msgId: string): void {
    const discordIds = this.toDiscord.get(msgId);
    if (discordIds === undefined) {
      return;
    }
    this.toDiscord.delete(msgId);
    for (const discordId of discordIds) {
      if (this.toProtocol.get(discordId) === msgId) {
        this.toProtocol.delete(discordId);
      }
    }
  }
}

/**
 * Channel-bound Discord ↔ Door session relay.
 * Ignores other guilds/channels, bots, and rate-limited traffic (no in-channel reply on drop).
 *
 * `session.addressing`: inbound frames carry `addressed` when the message @mentions the bot
 * or replies to one of its messages. `session.reactions`: outbound `reaction` bodies become
 * Discord reactions. Outbound `reply_to` / `reaction.target_msg_id` are protocol msg_ids,
 * resolved to Discord ids through {@link MessageIdMap}.
 */
export class MessageRelay {
  private readonly options: MessageRelayOptions;
  private msgCounter = 0;
  private readonly ids = new MessageIdMap();

  constructor(options: MessageRelayOptions) {
    this.options = options;
  }

  /** Sizes of the msg_id map's internal structures (bounded; for diagnostics/tests). */
  messageIdMapSizes(): { toDiscord: number; toProtocol: number; selfDiscordIds: number } {
    return this.ids.sizes();
  }

  /** Wire gateway message handler (returns the promise so FakeGateway can await it). */
  attach(): void {
    this.options.gateway.onMessage((message) => this.onMessage(message));
  }

  /**
   * Post an outbound Wanderer frame to the bound channel.
   * @param alreadyVerified - set when Door already accepted the frame (WS path).
   */
  async postOutbound(frame: OutboundFrame, alreadyVerified = false): Promise<void> {
    if (!alreadyVerified) {
      try {
        this.options.door.handleOutbound(frame);
      } catch (error: unknown) {
        await this.surfaceError(error);
        return;
      }
    }

    const channelId = frame.body.channel_id ?? this.options.channelId;
    if (channelId !== this.options.channelId) {
      this.options.logger.debug("outbound_channel_mismatch", {
        channel_id: channelId,
        expected: this.options.channelId
      });
      return;
    }

    this.ids.useEpoch(frame.epoch);

    const text = frame.body.text;
    if (text !== undefined) {
      const replyTarget = frame.body.reply_to;
      const replyToId = replyTarget === undefined ? undefined : this.ids.discordIdFor(replyTarget);
      // Discord caps messages at 2000 chars (protocol allows 4000): post in chunks;
      // only the first chunk carries the reply reference.
      const sentIds: string[] = [];
      try {
        for (const chunk of chunkDiscordMessage(text)) {
          const sent = await this.options.gateway.sendMessage(
            this.options.channelId,
            chunk,
            replyToId === undefined || sentIds.length > 0 ? undefined : { replyToId }
          );
          sentIds.push(sent.id);
        }
      } catch (error: unknown) {
        await this.surfaceError(error);
      }
      this.ids.bind(frame.msg_id, sentIds, true);
    }

    const reaction = frame.body.reaction;
    if (reaction !== undefined) {
      const targetId = this.ids.discordIdFor(reaction.target_msg_id);
      if (targetId === undefined) {
        this.options.logger.debug("reaction_target_unknown", {
          target_msg_id: reaction.target_msg_id
        });
        return;
      }
      try {
        await this.options.gateway.addReaction(this.options.channelId, targetId, reaction.emoji);
      } catch (error: unknown) {
        // A failed reaction is not worth an operator notice in the channel.
        this.options.logger.warn("reaction_failed", { notice: operatorNotice(error) });
      }
    }
  }

  private async onMessage(message: GatewayMessage): Promise<void> {
    if (message.guildId !== this.options.guildId) {
      return;
    }
    if (message.channelId !== this.options.channelId) {
      return;
    }

    const botId = this.options.gateway.botUserId();
    if (message.isBot || (botId !== null && message.authorId === botId)) {
      this.options.logger.debug("inbound_ignored_bot", { author_id: message.authorId });
      return;
    }

    const text = message.content.trim();
    if (text.length === 0) {
      return;
    }

    if (!this.options.rateLimiter.allow(message.authorId)) {
      this.options.logger.debug("inbound_rate_limited", {
        author_id: message.authorId,
        channel_id: message.channelId
      });
      return;
    }

    const epoch = this.options.door.getActiveEpoch();
    if (epoch === null) {
      this.options.logger.debug("inbound_no_active_session", {});
      return;
    }
    this.ids.useEpoch(epoch);

    this.msgCounter += 1;
    const msgId = `discord-${message.id}-${String(this.msgCounter)}`;
    const parentId = message.replyToId;
    const replyTo =
      parentId === undefined ? undefined : (this.ids.protocolIdFor(parentId) ?? parentId);
    const addressed =
      message.mentionsBot === true || (parentId !== undefined && this.ids.isSelf(parentId));
    const frame = this.options.door.createInboundFrame({
      msg_id: msgId,
      body: {
        text: text.slice(0, 4000),
        author_id: message.authorId,
        channel_id: message.channelId,
        addressed,
        ...(message.authorDisplay === undefined ? {} : { author_display: message.authorDisplay }),
        ...(replyTo === undefined ? {} : { reply_to: replyTo })
      }
    });

    // Door.createInboundFrame sets door_id/epoch from active session; re-check binding
    // before any side effect (id binding, typing). Log, never throw into the gateway.
    if (frame.door_id !== this.options.doorId) {
      this.options.logger.warn("inbound_door_id_mismatch", {
        expected: this.options.doorId,
        got: frame.door_id
      });
      return;
    }

    this.ids.bind(msgId, [message.id], false);

    if (addressed && this.options.gateway.sendTyping !== undefined) {
      // Likely to answer: show "typing…" while the Wanderer thinks (best-effort).
      void this.options.gateway.sendTyping(message.channelId).catch(() => undefined);
    }

    try {
      await this.options.deliverInbound(frame);
    } catch (error: unknown) {
      await this.surfaceError(error);
    }
  }

  private async surfaceError(error: unknown): Promise<void> {
    const notice = operatorNotice(error);
    this.options.logger.warn("relay_error", { notice });
    const notify = this.options.notifyOperators;
    if (notify !== undefined) {
      try {
        await notify(notice);
      } catch {
        // Stay up even if the operator notice fails.
      }
    }
  }
}
