import { BrainError } from "./errors.js";
import {
  chooseTier,
  estimateCostMicros,
  formatDecimalMicros,
  monthlyPeriodStart,
  type BudgetSleepReason,
  type BudgetState,
  type CallKind,
  type PricedTier,
  type TierChoice
} from "./budget-policy.js";
import { SpendLedger, type LedgerEvent, type SpendView } from "./spend-ledger.js";
import type { Brain, BrainMessage, BrainResult, CompleteOptions } from "./types.js";

/** Clock injected by the caller. Canonical `YYYY-MM-DDTHH:mm:ss.sssZ`. No `Date.now` inside. */
export type IsoClock = () => string;

/** Operator acknowledgement that clears a provider-exhausted or unknown-spend latch. */
export type WakeReason = "operator" | "budget_raised" | "period_reset";

/**
 * Fraction of the period allowance still unused, for Door status.
 * Dollar amounts are intentionally absent.
 */
export type BudgetPublicStatus = {
  sleeping: boolean;
  /** Tier `chat` would use, or null while sleeping. */
  tier: string | null;
  /** Remaining / budget in `[0, 1]`, or null when the ledger is unknown or the budget is 0. */
  remainingFraction: string | null;
  periodStart: string;
  sleepReason: BudgetSleepReason | null;
};

/**
 * Body for a future `sleep` record (`spec/osp/records.md`). Returned only when
 * the balance is known. A missing or corrupt ledger yields null so a caller
 * does not publish a fabricated balance.
 */
export type SleepRecordDraft = {
  reason: string;
  balance: string;
  threshold: string;
  as_of: string;
};

export type BudgetedBrainOptions = {
  tiers: readonly PricedTier[];
  /** Inner brains keyed by tier name. Tests pass {@link FakeBrain}; production passes one brain per tier. */
  brains: ReadonlyMap<string, Brain>;
  ledger: SpendLedger;
  budgetMicros: bigint;
  thresholdMicros: bigint;
  defaultTierName: string;
  clock: IsoClock;
  /** Kind used by {@link BudgetedBrain.complete}. Default `chat`. */
  callKind?: CallKind;
};

/**
 * Thrown when a completion is refused because the budget policy said sleep.
 * `reason` is `credit_exhausted` so existing Brain callers treat it as out of funds.
 */
export class BudgetError extends BrainError {
  readonly budgetReason: BudgetSleepReason;

  /**
   * @param budgetReason - Policy reason. Not a dollar amount.
   */
  constructor(budgetReason: BudgetSleepReason) {
    super(`budget exhausted (${budgetReason})`, "credit_exhausted", {
      envVar: "NPC_BUDGET_USD"
    });
    this.name = "BudgetError";
    this.budgetReason = budgetReason;
  }
}

/**
 * `Brain` that chooses a configured tier from remaining budget and records spend.
 *
 * Completions are serialized so two callers cannot both pass the budget check.
 * The inner call runs while the lock is held. When the journal cannot record a
 * successful call, the text is still returned (finish the exchange) and later
 * calls sleep. Not wired into the daemon in this change.
 */
export class BudgetedBrain implements Brain {
  private readonly tiers: readonly PricedTier[];
  private readonly brains: ReadonlyMap<string, Brain>;
  private readonly ledger: SpendLedger;
  private readonly budgetMicros: bigint;
  private readonly thresholdMicros: bigint;
  private readonly defaultTierName: string;
  private readonly clock: IsoClock;
  private readonly callKind: CallKind;
  /** Set when a ledger write failed and the miss could not be persisted. */
  private degraded = false;
  private gate: Promise<void> = Promise.resolve();

  /**
   * @param options - Tiers, inner brains, journal, allowance, and clock.
   * @throws {BrainError} When the tier list, brains, or allowance is inconsistent.
   */
  constructor(options: BudgetedBrainOptions) {
    if (options.tiers.length === 0) {
      throw new BrainError("at least one tier is required", "invalid_config", {
        envVar: "NPC_BRAIN_TIERS"
      });
    }
    if (options.budgetMicros < 0n || options.thresholdMicros < 0n) {
      throw new BrainError("budget and threshold must be non-negative", "invalid_config", {
        envVar: "NPC_BUDGET_USD"
      });
    }
    if (options.thresholdMicros > options.budgetMicros) {
      throw new BrainError(
        "NPC_BUDGET_THRESHOLD_USD must be less than or equal to NPC_BUDGET_USD",
        "invalid_config",
        { envVar: "NPC_BUDGET_THRESHOLD_USD" }
      );
    }
    const names = new Set<string>();
    for (const tier of options.tiers) {
      if (names.has(tier.name)) {
        throw new BrainError(`duplicate tier name ${tier.name}`, "invalid_config", {
          envVar: "NPC_BRAIN_TIERS"
        });
      }
      names.add(tier.name);
      if (!options.brains.has(tier.name)) {
        throw new BrainError(`no Brain registered for tier ${tier.name}`, "invalid_config");
      }
    }
    if (!names.has(options.defaultTierName)) {
      throw new BrainError(
        `default tier ${options.defaultTierName} is not in the tier list`,
        "invalid_config",
        { envVar: "NPC_BUDGET_DEFAULT_TIER" }
      );
    }

    this.tiers = [...options.tiers];
    this.brains = new Map(options.brains);
    this.ledger = options.ledger;
    this.budgetMicros = options.budgetMicros;
    this.thresholdMicros = options.thresholdMicros;
    this.defaultTierName = options.defaultTierName;
    this.clock = options.clock;
    this.callKind = options.callKind ?? "chat";
  }

  /**
   * Completion for this instance's call kind (default `chat`).
   *
   * @param messages - Brain conversation.
   * @param opts - Per-request overrides forwarded to the chosen tier.
   * @throws {BudgetError} When the policy sleeps. The inner brain is not called.
   */
  complete(messages: BrainMessage[], opts?: CompleteOptions): Promise<BrainResult> {
    return this.completeKind(this.callKind, messages, opts);
  }

  /**
   * A `Brain` bound to `kind` that shares this ledger and lock.
   * Distill and journal use this so they can step up one tier when the budget allows.
   *
   * @param kind - `chat`, `distill`, or `journal`.
   */
  forKind(kind: CallKind): Brain {
    return {
      complete: (messages, opts) => this.completeKind(kind, messages, opts)
    };
  }

  /**
   * Clear a provider-exhausted or unknown-spend latch by appending a wake line.
   * Does nothing for a balance that is still at or below the threshold, and
   * throws if the journal itself is untrusted.
   *
   * @param reason - Why the operator or the period reset is waking.
   */
  async wake(reason: WakeReason): Promise<void> {
    await this.exclusive(async () => {
      const now = this.clock();
      await this.ledger.append({ kind: "wake", ts: now, reason });
    });
  }

  /**
   * Door-facing status. Fraction only — no allowance, spend, or balance.
   *
   * @param kind - Call kind used to name the tier that would run. Default `chat`.
   */
  async publicStatus(kind: CallKind = "chat"): Promise<BudgetPublicStatus> {
    return this.exclusive(async () => {
      const now = this.clock();
      const viewed = this.view(now);
      const choice = chooseTier(viewed.state, kind);
      const base = {
        remainingFraction: remainingFraction(viewed.state),
        periodStart: viewed.periodStart
      };
      if (choice.action === "sleep") {
        return {
          ...base,
          sleeping: true,
          tier: null,
          sleepReason: choice.reason
        };
      }
      return {
        ...base,
        sleeping: false,
        tier: choice.tier.name,
        sleepReason: null
      };
    });
  }

  /**
   * Sleep-record body when the policy is sleeping and the balance is known.
   * Null when the brain would still answer, or when the ledger is unknown.
   */
  async sleepDraft(): Promise<SleepRecordDraft | null> {
    return this.exclusive(async () => {
      const now = this.clock();
      const viewed = this.view(now);
      const choice = chooseTier(viewed.state, this.callKind);
      if (choice.action !== "sleep" || !viewed.state.known) {
        return null;
      }
      return {
        reason: choice.reason,
        balance: formatDecimalMicros(viewed.state.remainingMicros),
        threshold: formatDecimalMicros(this.thresholdMicros),
        as_of: now
      };
    });
  }

  private completeKind(
    kind: CallKind,
    messages: BrainMessage[],
    opts?: CompleteOptions
  ): Promise<BrainResult> {
    return this.exclusive(() => this.completeLocked(kind, messages, opts));
  }

  private async completeLocked(
    kind: CallKind,
    messages: BrainMessage[],
    opts?: CompleteOptions
  ): Promise<BrainResult> {
    const now = this.clock();
    const viewed = this.view(now);
    const choice = chooseTier(viewed.state, kind);
    if (choice.action === "sleep") {
      throw new BudgetError(choice.reason);
    }
    const brain = this.brainFor(choice);
    let result: BrainResult;
    try {
      result = await brain.complete(messages, opts);
    } catch (error: unknown) {
      if (error instanceof BrainError && error.reason === "credit_exhausted") {
        await this.recordLatch(now, choice.tier, "provider_exhausted");
      }
      throw error;
    }
    await this.recordSpend(now, choice.tier, result);
    return result;
  }

  private view(now: string): { periodStart: string; state: BudgetState } {
    const periodStart = monthlyPeriodStart(now);
    const replay = this.ledger.replay(now);
    return { periodStart, state: this.toState(replay) };
  }

  private toState(view: SpendView): BudgetState {
    const known = view.trusted && !view.unknownSpend && !this.degraded;
    const spent = view.trusted ? view.spentMicros : 0n;
    return {
      known,
      budgetMicros: this.budgetMicros,
      remainingMicros: this.budgetMicros - spent,
      thresholdMicros: this.thresholdMicros,
      providerExhausted: view.trusted ? view.providerExhausted : false,
      tiers: this.tiers,
      defaultTierName: this.defaultTierName
    };
  }

  private brainFor(choice: Extract<TierChoice, { action: "call" }>): Brain {
    const brain = this.brains.get(choice.tier.name);
    if (brain === undefined) {
      throw new BrainError(`no Brain registered for tier ${choice.tier.name}`, "invalid_config");
    }
    return brain;
  }

  private async recordSpend(ts: string, tier: PricedTier, result: BrainResult): Promise<void> {
    const promptTokens = result.usage.promptTokens;
    const completionTokens = result.usage.completionTokens;
    if (!isRecordableCount(promptTokens) || !isRecordableCount(completionTokens)) {
      await this.recordLatch(ts, tier, "unknown_spend");
      return;
    }
    let estCostMicros: bigint;
    try {
      estCostMicros = estimateCostMicros(
        promptTokens,
        completionTokens,
        tier.inPricePerMTokMicros,
        tier.outPricePerMTokMicros
      );
    } catch {
      await this.recordLatch(ts, tier, "unknown_spend");
      return;
    }
    await this.appendOrDegrade({
      kind: "spend",
      ts,
      tier: tier.name,
      model: tier.model,
      tokens_in: promptTokens,
      tokens_out: completionTokens,
      est_cost: formatDecimalMicros(estCostMicros)
    });
  }

  private async recordLatch(
    ts: string,
    tier: PricedTier,
    kind: "provider_exhausted" | "unknown_spend"
  ): Promise<void> {
    await this.appendOrDegrade({
      kind,
      ts,
      tier: tier.name,
      model: tier.model
    });
  }

  /**
   * Persist a journal line. A failed write marks this process degraded and
   * does not throw: the current exchange can still finish, and the next call sleeps.
   */
  private async appendOrDegrade(event: LedgerEvent): Promise<void> {
    try {
      await this.ledger.append(event);
    } catch (error: unknown) {
      this.degraded = true;
      if (!(error instanceof BrainError)) {
        throw error;
      }
    }
  }

  private exclusive<T>(body: () => Promise<T>): Promise<T> {
    const run = this.gate.then(body, body);
    this.gate = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }
}

function remainingFraction(state: BudgetState): string | null {
  if (!state.known || state.budgetMicros <= 0n) {
    return null;
  }
  if (state.remainingMicros <= 0n) {
    return "0";
  }
  if (state.remainingMicros >= state.budgetMicros) {
    return "1";
  }
  return formatDecimalMicros((state.remainingMicros * 1_000_000n) / state.budgetMicros);
}

function isRecordableCount(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
}
