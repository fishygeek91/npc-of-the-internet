export const packageName = "@npc/door-web";

export { loadWebDoorConfig } from "./config.js";
export type { WebDoorConfig } from "./config.js";
export { WebDoorError } from "./errors.js";
export { loadDoorKeypairFromPath } from "./load-door-key.js";
export { DailyBudget, VisitorRateLimiter, VISITOR_RULES } from "./rate-limit.js";
export type { MsClock, RateDecision, RateRule } from "./rate-limit.js";
export { Room, ROOM_CAPACITY } from "./room.js";
export type { RoomEvent, RoomMessage, RoomAuthorKind } from "./room.js";
export { AtlasWhereabouts } from "./atlas.js";
export type { WandererWhereabouts } from "./atlas.js";
export {
  VisitorSite,
  SAY_BODY_MAX_BYTES,
  SAY_BODY_TIMEOUT_MS,
  STATE_MESSAGES,
  SSE_HEARTBEAT_MS,
  SSE_MAX_BUFFERED_BYTES,
  SSE_MAX_PER_IP
} from "./site.js";
export type { DoorInfo, RelayRequest, VisitorSiteOptions } from "./site.js";
export {
  clientIp,
  clientKey,
  foldName,
  isAddressed,
  isReservedName,
  parseSay,
  relayText,
  VisitorIds,
  NAME_MAX,
  TEXT_MAX
} from "./visitor.js";
export type { SayParseResult, VisitorSay } from "./visitor.js";
export { startWebDoor, PRESENCE_POLL_MS } from "./start.js";
export type { StartWebDoorOptions, WebDoorHandle } from "./start.js";
