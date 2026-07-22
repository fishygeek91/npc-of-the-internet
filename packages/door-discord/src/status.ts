/**
 * Snapshot returned by `/wanderer status` (ephemeral).
 */
export type DoorStatusSnapshot = {
  present: boolean;
  doorId: string;
  epoch: number | null;
  sessionLive: boolean;
  pendingReviewCount: number;
};

/**
 * Format an ephemeral status reply for Discord operators.
 */
export function formatStatusReply(status: DoorStatusSnapshot): string {
  const presence = status.present ? "present" : "absent";
  const epoch = status.epoch === null ? "none" : String(status.epoch);
  const live = status.sessionLive ? "live" : "not live";
  return [
    `**Wanderer status**`,
    `• presence: ${presence}`,
    `• door_id: \`${status.doorId}\``,
    `• epoch: ${epoch}`,
    `• session: ${live}`,
    `• pending review shards: ${String(status.pendingReviewCount)}`
  ].join("\n");
}
