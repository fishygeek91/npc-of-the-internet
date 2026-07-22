export const packageName = "@npc/door-discord";

export { loadDiscordDoorConfig, doorIdForGuild } from "./config.js";
export type { DiscordDoorConfig } from "./config.js";
export { DiscordDoorError, operatorNotice } from "./errors.js";
export { loadDoorKeypairFromPath } from "./load-door-key.js";
export { DualRateLimiter, TokenBucket } from "./rate-limit.js";
export type { RateClock } from "./rate-limit.js";
export {
  ReviewGate,
  APPROVE_EMOJI,
  REJECT_EMOJI,
  formatShardReviewMessage
} from "./review-gate.js";
export type { ReviewGateOptions, ShardDecision } from "./review-gate.js";
export { ReviewGatedDoor } from "./review-gated-door.js";
export { formatStatusReply } from "./status.js";
export type { DoorStatusSnapshot } from "./status.js";
export { startDiscordDoor } from "./start.js";
export type { DiscordDoorHandle, SessionBridge, StartDiscordDoorOptions } from "./start.js";
export type {
  DiscordGateway,
  GatewayCommand,
  GatewayMessage,
  GatewayReaction
} from "./discord/gateway.js";
export { DiscordJsGateway } from "./discord/discord-js-gateway.js";
export { MessageRelay } from "./discord/relay.js";
