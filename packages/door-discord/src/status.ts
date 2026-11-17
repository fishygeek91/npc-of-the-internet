/**
 * Snapshot returned by `/wanderer status` (ephemeral).
 */
export type DoorStatusSnapshot = {
  present: boolean;
  doorId: string;
  epoch: number | null;
  sessionLive: boolean;
  /** True when this Door's AI witness co-signs memories (`attest.memory`). */
  witnessesMemories: boolean;
};

/**
 * Format an ephemeral status reply for Discord operators.
 */
export function formatStatusReply(status: DoorStatusSnapshot): string {
  const presence = status.present ? "present" : "absent";
  const epoch = status.epoch === null ? "none" : String(status.epoch);
  const live = status.sessionLive ? "live" : "not live";
  const memories = status.witnessesMemories
    ? "witnessed by this Door's AI witness"
    : "not witnessed (no witness configured — the Wanderer forms no memories here)";
  return [
    `**Wanderer status**`,
    `• presence: ${presence}`,
    `• door_id: \`${status.doorId}\``,
    `• epoch: ${epoch}`,
    `• session: ${live}`,
    `• memories: ${memories}`
  ].join("\n");
}
