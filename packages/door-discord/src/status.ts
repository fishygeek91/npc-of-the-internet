import type { DoorBudgetStatus } from "./budget-status.js";

/**
 * Snapshot returned by `/wanderer status` (ephemeral).
 * `budget` is omitted by older callers; the reply then says the budget is not configured.
 */
export type DoorStatusSnapshot = {
  present: boolean;
  doorId: string;
  epoch: number | null;
  sessionLive: boolean;
  /** True when this Door's AI witness co-signs memories (`attest.memory`). */
  witnessesMemories: boolean;
  /** Fraction-only treasury snapshot. Absent means this Door was not given a file. */
  budget?: DoorBudgetStatus;
};

/**
 * Operator lines for the budget. Dollar amounts are not a field on {@link DoorBudgetStatus}.
 * Unknown spend stays `remaining_fraction: unknown` rather than a fabricated zero.
 *
 * @param budget - Loaded snapshot, or `undefined` when the caller did not load one.
 */
function budgetReplyLines(budget: DoorBudgetStatus | undefined): readonly string[] {
  if (budget === undefined || budget.state === "not_configured") {
    return ["• budget: not configured"];
  }
  if (budget.state === "unavailable") {
    return ["• budget: unavailable"];
  }
  const tier = budget.tier === null ? "none" : budget.tier;
  const remaining = budget.remainingFraction === null ? "unknown" : budget.remainingFraction;
  const sleeping = budget.sleeping ? "yes" : "no";
  return [`• sleeping: ${sleeping}`, `• tier: ${tier}`, `• remaining_fraction: ${remaining}`];
}

/**
 * Format an ephemeral status reply for Discord operators.
 * Budget lines are sleeping, tier, and remaining fraction only.
 *
 * @param status - Door presence plus an optional budget snapshot.
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
    `• memories: ${memories}`,
    ...budgetReplyLines(status.budget)
  ].join("\n");
}
