import type { Brain } from "./types.js";
import { BudgetedBrain, type IsoClock } from "./budgeted-brain.js";
import {
  tierToOpenAICompatConfig,
  type BudgetConfig,
  type BudgetTierConfig
} from "./budget-policy.js";
import { createBrain } from "./create-brain.js";
import { BrainError } from "./errors.js";
import { SpendLedger } from "./spend-ledger.js";

/** Options for {@link openBudgetedBrain}. */
export type OpenBudgetedBrainOptions = {
  budget: BudgetConfig;
  maxTokens: number;
  timeoutMs: number;
  clock: IsoClock;
  /**
   * Inner brain for one tier. Tests pass {@link FakeBrain}. The default builds
   * an OpenAI-compatible brain from the tier. The tier's key is already resolved;
   * do not log the tier object.
   */
  createTierBrain?: (tier: BudgetTierConfig) => Brain;
  /**
   * Passed to {@link BudgetedBrain}. Runs after the completion lock is released.
   * The daemon uses it to publish `publicStatus` without taking that lock.
   */
  afterExclusive?: () => void;
};

/**
 * Open the spend journal without creating it, and one inner brain per tier.
 * A missing journal is a config error: boot must not arrive and then go mute.
 * A corrupt or torn journal still opens untrusted, so calls sleep instead of
 * being priced at zero.
 *
 * @param options - Loaded budget, shared token limits, and clock.
 * @throws {BrainError} When boot was asked to create the journal, or the file is missing.
 */
export async function openBudgetedBrain(options: OpenBudgetedBrainOptions): Promise<BudgetedBrain> {
  if (options.budget.createLedgerIfMissing) {
    throw new BrainError(
      "NPC_BUDGET_LEDGER_INIT is not applied at boot; run `wanderer budget-init` once",
      "invalid_config",
      { envVar: "NPC_BUDGET_LEDGER_INIT" }
    );
  }
  const ledger = await SpendLedger.open({
    path: options.budget.ledgerPath,
    createIfMissing: false
  });
  const opened = ledger.replay(options.clock());
  if (!opened.trusted && opened.reason === "missing") {
    throw new BrainError(
      "spend journal is missing; run `wanderer budget-init` once before starting the daemon",
      "invalid_config",
      { envVar: "NPC_BUDGET_LEDGER_PATH" }
    );
  }
  const createTierBrain =
    options.createTierBrain ??
    ((tier: BudgetTierConfig): Brain =>
      createBrain(
        tierToOpenAICompatConfig(tier, {
          maxTokens: options.maxTokens,
          timeoutMs: options.timeoutMs
        })
      ));
  const brains = new Map<string, Brain>();
  for (const tier of options.budget.tiers) {
    brains.set(tier.name, createTierBrain(tier));
  }
  return new BudgetedBrain({
    tiers: options.budget.tiers,
    brains,
    ledger,
    budgetMicros: options.budget.budgetMicros,
    thresholdMicros: options.budget.thresholdMicros,
    defaultTierName: options.budget.defaultTierName,
    clock: options.clock,
    ...(options.afterExclusive !== undefined ? { afterExclusive: options.afterExclusive } : {})
  });
}
