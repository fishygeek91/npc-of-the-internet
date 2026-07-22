import {
  HttpDoorServer,
  InProcessDoorConnection,
  WsDoorSessionServer,
  type Clock,
  type HostPolicy,
  type InboundFrame,
  type OutboundFrame
} from "@npc/door-sdk";
import type { Logger } from "pino";
import pino from "pino";

import type { DiscordDoorConfig } from "./config.js";
import { doorIdForGuild } from "./config.js";
import { DiscordJsGateway } from "./discord/discord-js-gateway.js";
import type { DiscordGateway } from "./discord/gateway.js";
import { MessageRelay } from "./discord/relay.js";
import { DiscordDoorError, operatorNotice } from "./errors.js";
import { loadDoorKeypairFromPath } from "./load-door-key.js";
import { DualRateLimiter, type RateClock } from "./rate-limit.js";
import { ReviewGate, type ReviewGateSleep } from "./review-gate.js";
import { ReviewGatedDoor } from "./review-gated-door.js";
import { formatStatusReply, type DoorStatusSnapshot } from "./status.js";

/** Wall-clock adapter for Door + rate limits + review timeouts. */
class SystemClock implements Clock, RateClock {
  now(): string {
    return new Date().toISOString();
  }

  nowMs(): number {
    return Date.now();
  }
}

const systemSleep: ReviewGateSleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export type SessionBridge = {
  /**
   * Handle an inbound community frame and optionally return a signed outbound reply.
   * Used by in-process tests and the manual residency harness.
   */
  handleInbound: (frame: InboundFrame) => Promise<OutboundFrame | null>;
};

export type StartDiscordDoorOptions = {
  config: DiscordDoorConfig;
  /** Inject a fake gateway in tests; defaults to discord.js binding. */
  gateway?: DiscordGateway;
  clock?: Clock & RateClock;
  sleep?: ReviewGateSleep;
  logger?: Logger;
  /**
   * When set, community messages are delivered here (in-process Session).
   * When omitted, inbound frames are broadcast on the WS session server.
   */
  sessionBridge?: SessionBridge;
  /** Skip HTTP/WS servers (unit/integration tests that only need Door + Discord). */
  disableServers?: boolean;
};

export type DiscordDoorHandle = {
  doorId: string;
  door: ReviewGatedDoor;
  /** In-process DoorConnection for Session.attest / heartbeat / cosign. */
  connection: InProcessDoorConnection;
  gateway: DiscordGateway;
  reviewGate: ReviewGate;
  relay: MessageRelay;
  status: () => DoorStatusSnapshot;
  stop: () => Promise<void>;
};

/**
 * Start the Discord Door adapter: Door core, review gate, optional HTTP/WS servers, Discord gateway.
 * Clean entrypoint for T6.1 compose wrapping.
 */
export async function startDiscordDoor(
  options: StartDiscordDoorOptions
): Promise<DiscordDoorHandle> {
  const config = options.config;
  const logger = options.logger ?? pino({ name: "door-discord", level: "info" });
  const clock = options.clock ?? new SystemClock();
  const sleep = options.sleep ?? systemSleep;
  const doorId = doorIdForGuild(config.guildId);
  const doorKeypair = loadDoorKeypairFromPath(config.doorKeyPath);

  const gateway =
    options.gateway ??
    new DiscordJsGateway({
      token: config.botToken,
      guildId: config.guildId,
      channelId: config.channelId,
      operatorIds: config.operatorIds
    });

  const reviewChannelId = config.reviewChannelId ?? config.channelId;
  const reviewGate = new ReviewGate({
    gateway,
    reviewChannelId,
    operatorIds: new Set(config.operatorIds),
    timeoutMs: config.reviewTimeoutMs,
    clock,
    sleep,
    debug: (message, fields) => {
      logger.debug({ ...fields }, message);
    }
  });

  const policy: HostPolicy = {
    community: {
      name: config.communityName,
      description: config.communityDescription,
      platform: "discord",
      invitation_required: false
    },
    capabilities: ["session.text", "session.threads", "heartbeat", "attest", "cosign.manual"],
    decideShard: (shard) => reviewGate.decideShard(shard)
  };

  const door = new ReviewGatedDoor(
    {
      doorId,
      doorKeypair,
      soulPublicKey: config.soulPublicKey,
      clock,
      policy
    },
    reviewGate
  );

  const connection = new InProcessDoorConnection(door);

  let httpServer: HttpDoorServer | null = null;
  let wsServer: WsDoorSessionServer | null = null;

  if (options.disableServers !== true) {
    httpServer = new HttpDoorServer({
      door,
      host: config.httpHost,
      port: config.httpPort
    });
    const bound = await httpServer.start();
    logger.info({ baseUrl: bound.baseUrl }, "door_http_listening");

    wsServer = new WsDoorSessionServer({
      door,
      host: config.httpHost,
      port: 0
    });
    const wsBound = await wsServer.start();
    logger.info({ url: wsBound.url }, "door_ws_listening");
  }

  const rateLimiter = new DualRateLimiter(
    config.userRatePerMinute,
    config.userBurst,
    config.channelRatePerMinute,
    config.channelBurst,
    clock
  );

  const sessionBridge = options.sessionBridge;
  const activeWs = wsServer;

  const relay = new MessageRelay({
    gateway,
    door,
    doorId,
    guildId: config.guildId,
    channelId: config.channelId,
    rateLimiter,
    logger: {
      debug: (message, fields) => {
        logger.debug({ ...fields }, message);
      },
      warn: (message, fields) => {
        logger.warn({ ...fields }, message);
      }
    },
    deliverInbound: async (frame) => {
      if (sessionBridge !== undefined) {
        const outbound = await sessionBridge.handleInbound(frame);
        if (outbound !== null) {
          // Already verified path via postOutbound(false) below — Session signs; Door verifies.
          await relay.postOutbound(outbound);
        }
        return;
      }
      if (activeWs === null) {
        throw new DiscordDoorError("internal_error", "no session bridge and WS server is disabled");
      }
      activeWs.broadcastInbound(frame.body, frame.msg_id);
    },
    notifyOperators: async (notice) => {
      await gateway.sendMessage(config.channelId, notice);
    }
  });

  // WS clients: Door verifies outbound, then we post to Discord (skip re-verify).
  door.setOutboundListener((frame) => {
    if (sessionBridge !== undefined) {
      return;
    }
    void relay.postOutbound(frame, true);
  });

  gateway.onReaction((reaction) => {
    reviewGate.handleReaction(reaction);
  });

  gateway.onCommand(async (command) => {
    try {
      if (command.kind === "status") {
        await gateway.replyEphemeral(command.interactionId, formatStatusReply(readStatus()));
        return;
      }
      const handled = reviewGate.handleCommand(command);
      const reply = handled
        ? `Recorded ${command.kind} for \`${command.shardId}\`.`
        : "Ignored (not an operator, or no matching pending shard).";
      await gateway.replyEphemeral(command.interactionId, reply);
    } catch (error: unknown) {
      logger.warn({ notice: operatorNotice(error) }, "command_error");
      try {
        await gateway.replyEphemeral(command.interactionId, operatorNotice(error));
      } catch {
        // Stay up.
      }
    }
  });

  relay.attach();
  await gateway.start();

  function readStatus(): DoorStatusSnapshot {
    const epoch = door.getActiveEpoch();
    const present = epoch !== null;
    return {
      present,
      doorId,
      epoch,
      sessionLive: present,
      pendingReviewCount: reviewGate.pendingCount()
    };
  }

  return {
    doorId,
    door,
    connection,
    gateway,
    reviewGate,
    relay,
    status: readStatus,
    stop: async () => {
      door.setOutboundListener(null);
      await gateway.stop();
      if (wsServer !== null) {
        await wsServer.stop();
      }
      if (httpServer !== null) {
        await httpServer.stop();
      }
    }
  };
}
