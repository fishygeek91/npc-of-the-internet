import { randomBytes } from "node:crypto";

import {
  createAiWitness,
  Door,
  HttpDoorServer,
  loadWitnessConfig,
  openAiCompatComplete,
  WsDoorSessionServer,
  type Clock,
  type HostPolicy,
  type OutboundFrame
} from "@npc/door-sdk";
import pino, { type Logger } from "pino";

import { AtlasWhereabouts } from "./atlas.js";
import type { WebDoorConfig } from "./config.js";
import { loadDoorKeypairFromPath } from "./load-door-key.js";
import type { MsClock } from "./rate-limit.js";
import { Room } from "./room.js";
import { VisitorSite } from "./site.js";
import { relayText } from "./visitor.js";

/** How often presence is re-derived (the WS server exposes no connect/disconnect hook). */
export const PRESENCE_POLL_MS = 2_000;

/** Wall clock for the Door (ISO) and the site (ms). */
class SystemClock implements Clock, MsClock {
  now(): string {
    return new Date().toISOString();
  }

  nowMs(): number {
    return Date.now();
  }
}

/** Options for {@link startWebDoor}. */
export type StartWebDoorOptions = {
  config: WebDoorConfig;
  logger?: Logger;
  clock?: Clock & MsClock;
  /** Env read for the memory witness (`DOOR_WITNESS_*` / `NPC_BRAIN_*`); default `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Presence poll interval (tests shorten it). */
  presencePollMs?: number;
};

/** A running website Door. */
export type WebDoorHandle = {
  doorId: string;
  door: Door;
  /** Door protocol base URL (`/door/*`, WS `/door/session`). */
  doorUrl: string;
  /** Visitor site base URL. */
  publicUrl: string;
  room: Room;
  site: VisitorSite;
  /** True while the Wanderer resides here and its runtime is connected. */
  isPresent: () => boolean;
  stop: () => Promise<void>;
};

/** Room id for a Wanderer-side msg_id: visitor ids pass through, others are epoch-scoped. */
function roomIdFor(epoch: number, msgId: string): string {
  return msgId.startsWith("web-") ? msgId : `w${String(epoch)}-${msgId}`;
}

/**
 * Start the website Door: Door core + protocol listeners (HTTP + WS session) for the
 * runtime, and the public visitor site where people talk with the Wanderer while it is here.
 */
export async function startWebDoor(options: StartWebDoorOptions): Promise<WebDoorHandle> {
  const { config } = options;
  const logger = options.logger ?? pino({ name: "door-web" });
  const clock = options.clock ?? new SystemClock();
  const doorKeypair = loadDoorKeypairFromPath(config.doorKeyPath);

  const witness = loadWitnessConfig(options.env ?? process.env);
  logger.info({ enabled: witness !== null, model: witness?.model ?? null }, "door_witness_config");

  const policy: HostPolicy = {
    community: {
      name: config.communityName,
      description: config.communityDescription,
      platform: "web",
      invitation_required: false
    },
    capabilities: [
      "session.text",
      "session.reactions",
      "session.addressing",
      "heartbeat",
      "attest"
    ],
    ...(witness === null
      ? {}
      : { witnessMemory: createAiWitness({ complete: openAiCompatComplete(witness) }) })
  };

  const door = new Door({
    doorId: config.doorId,
    doorKeypair,
    soulPublicKey: config.soulPublicKey,
    clock,
    policy
  });

  const httpServer = new HttpDoorServer({
    door,
    host: config.doorHttpHost,
    port: config.doorHttpPort
  });
  const bound = await httpServer.start();
  logger.info({ host: bound.host, port: bound.port }, "door_http_listening");
  const wsServer = new WsDoorSessionServer({ door, server: httpServer.nodeServer });
  await wsServer.start();

  const room = new Room();
  const isPresent = (): boolean =>
    door.getActiveEpoch() !== null && wsServer.getActiveClients().size > 0;
  let present = false;
  let lastSeenHere: string | null = null;

  const atlas =
    config.atlasApiUrl === undefined
      ? undefined
      : new AtlasWhereabouts(config.atlasApiUrl, () => clock.nowMs());

  const site = new VisitorSite({
    door: {
      id: config.doorId,
      name: config.communityName,
      description: config.communityDescription
    },
    room,
    isPresent,
    lastSeenHere: () => lastSeenHere,
    ...(atlas === undefined ? {} : { whereabouts: () => atlas.get() }),
    relay: (request) => {
      if (!isPresent()) {
        return false;
      }
      wsServer.broadcastInbound(
        {
          text: relayText(request.text),
          author_id: request.authorId,
          author_display: request.name,
          addressed: request.addressed
        },
        request.msgId
      );
      return true;
    },
    maxClients: config.maxClients,
    globalPerMinute: config.globalPerMinute,
    dailyMax: config.dailyMax,
    trustProxy: config.trustProxy,
    clock,
    logger
  });

  const checkPresence = (): void => {
    const now = isPresent();
    if (now === present) {
      return;
    }
    present = now;
    if (!now) {
      lastSeenHere = clock.now();
    }
    logger.info({ present: now }, "door_web_presence");
    site.broadcastPresence(now);
  };

  const systemLine = (text: string): void => {
    room.append({
      id: `sys-${randomBytes(6).toString("hex")}`,
      at: clock.now(),
      from: "system",
      text
    });
  };

  const offLifecycle = door.addSessionLifecycleListener((event) => {
    if (event.type === "arrived") {
      systemLine("The Wanderer has arrived.");
    } else if (event.type === "retired") {
      systemLine("The Wanderer has moved on.");
    }
    checkPresence();
  });

  const offOutbound = door.addOutboundListener((frame: OutboundFrame) => {
    const { text, reply_to: replyTo, reaction } = frame.body;
    if (text !== undefined) {
      room.append({
        id: roomIdFor(frame.epoch, frame.msg_id),
        at: clock.now(),
        from: "wanderer",
        name: "The Wanderer",
        text,
        ...(replyTo === undefined ? {} : { reply_to: roomIdFor(frame.epoch, replyTo) })
      });
    }
    if (reaction !== undefined) {
      room.react(roomIdFor(frame.epoch, reaction.target_msg_id), reaction.emoji);
    }
  });

  const poll = setInterval(checkPresence, options.presencePollMs ?? PRESENCE_POLL_MS);
  poll.unref();

  const publicBound = await site.start(config.publicHost, config.publicPort);
  logger.info({ host: publicBound.host, port: publicBound.port }, "door_web_public_listening");

  return {
    doorId: config.doorId,
    door,
    doorUrl: bound.baseUrl,
    publicUrl: publicBound.url,
    room,
    site,
    isPresent,
    stop: async () => {
      clearInterval(poll);
      offLifecycle();
      offOutbound();
      await site.stop();
      await wsServer.stop();
      await httpServer.stop();
    }
  };
}
