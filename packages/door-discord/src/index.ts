export const packageName = "@npc/door-discord";

export { loadDiscordDoorConfig, doorIdForGuild } from "./config.js";
export type { DiscordDoorConfig } from "./config.js";
export { DiscordDoorError, operatorNotice } from "./errors.js";
export { loadDoorKeypairFromPath } from "./load-door-key.js";
export { DualRateLimiter, TokenBucket } from "./rate-limit.js";
export type { DualRateLimiterOptions, RateClock } from "./rate-limit.js";
export { formatStatusReply } from "./status.js";
export type { DoorStatusSnapshot } from "./status.js";
export { startDiscordDoor, ARRIVED_NOTICE, MOVED_ON_NOTICE } from "./start.js";
export type { DiscordDoorHandle, SessionBridge, StartDiscordDoorOptions } from "./start.js";
export type { DiscordGateway, GatewayCommand, GatewayMessage } from "./discord/gateway.js";
export { DiscordJsGateway } from "./discord/discord-js-gateway.js";
export { MessageRelay } from "./discord/relay.js";
