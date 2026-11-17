import { isAbsolute } from "node:path";

import { z } from "zod";

import {
  isOpenRouterBaseUrl,
  resolveSecretFromEnv,
  type OpenAICompatBrainConfig
} from "./config.js";
import { BrainError } from "./errors.js";

/**
 * Micro-dollars: 1_000_000 micros = 1 USD.
 * Six decimal places is the ledger's exact unit so spend never uses binary floats.
 */
const MICROS_PER_UNIT = 1_000_000n;
const TOKENS_PER_PRICE_UNIT = 1_000_000n;
const PERCENT = 100n;

/**
 * Remaining budget strictly above this percent of the period allowance uses the
 * default tier (distill/journal may step up one tier).
 */
export const HEALTHY_REMAINING_PERCENT = 50n;

/**
 * Remaining budget at or above this percent, and not healthy, uses the cheaper
 * of the default tier and the cheapest paid tier. A zero-price default therefore
 * stays in use as the budget falls. Below this percent, only a zero-price tier
 * is eligible.
 */
export const CONSERVE_REMAINING_PERCENT = 10n;

/**
 * Non-negative decimal with at most six fractional digits (one micro-dollar).
 * Shared by config parsing and the spend journal so the two cannot drift.
 */
export const DECIMAL_MICROS = /^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/;

/**
 * Fixed-width millisecond UTC (`YYYY-MM-DDTHH:mm:ss.sssZ`).
 *
 * osp-core `IsoUtcTimestampSchema` allows an optional fraction of 1–9 digits.
 * Ledger month bounds compare these strings directly, so the width has to be
 * fixed or two timestamps in the same second would not sort.
 */
export const CANONICAL_ISO_UTC_MS = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/;

const TIER_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;
/**
 * Tier keys are named, not embedded. The suffix keeps a public tier list from
 * pointing at an unrelated secret (`DISCORD_BOT_TOKEN`, `STORACHA_TOKEN`).
 * 1 + 55 + `_API_KEY` stays inside the previous 64-character cap.
 */
const API_KEY_ENV = /^[A-Z][A-Z0-9_]{0,55}_API_KEY$/;
const PROVIDER_SLUG = /^[a-z0-9][a-z0-9_./-]*$/;

const DECIMAL_MESSAGE = "must be a non-negative decimal with at most 6 fractional digits";

/** Why {@link chooseTier} refuses to call a model. */
export type BudgetSleepReason =
  "balance_below_threshold" | "ledger_unknown" | "provider_exhausted" | "no_affordable_tier";

/** Which runtime job is asking for a completion. Distill and journal may escalate one tier. */
export type CallKind = "chat" | "distill" | "journal";

/**
 * Reserved seam for a later per-message weight. v1 checks that `messageWeight`
 * is finite when present and otherwise ignores it.
 */
export type ContextSignals = {
  messageWeight?: number;
};

/** A configured model tier priced in micro-dollars per million tokens. No API key. */
export type PricedTier = {
  name: string;
  model: string;
  inPricePerMTokMicros: bigint;
  outPricePerMTokMicros: bigint;
};

/**
 * Budget view the tier policy reads. `remainingMicros` may be negative after a
 * call that crossed the threshold; the next decision then sleeps.
 */
export type BudgetState = {
  /** False when spend cannot be replayed. The policy then sleeps (fail closed). */
  known: boolean;
  budgetMicros: bigint;
  remainingMicros: bigint;
  thresholdMicros: bigint;
  /** A provider 402 (or equivalent) was recorded in this period after the last wake. */
  providerExhausted: boolean;
  tiers: readonly PricedTier[];
  defaultTierName: string;
};

export type TierBand = "healthy" | "conserve" | "critical";

export type TierChoice =
  | { action: "call"; tier: PricedTier; band: TierBand }
  | { action: "sleep"; reason: BudgetSleepReason };

/**
 * Operator tier as loaded from `NPC_BRAIN_TIERS`.
 * `apiKey` is resolved from the env var named by `apiKeyEnv` and is not part of the JSON.
 */
export type BudgetTierConfig = PricedTier & {
  baseUrl: string;
  apiKey: string;
  inPricePerMTok: string;
  outPricePerMTok: string;
  providerAllowlist?: readonly string[];
};

/** Treasury-lite configuration. Absent when `NPC_BRAIN_TIERS` is unset (feature off). */
export type BudgetConfig = {
  tiers: readonly BudgetTierConfig[];
  budgetMicros: bigint;
  budgetUsd: string;
  thresholdMicros: bigint;
  thresholdUsd: string;
  period: "monthly";
  defaultTierName: string;
  ledgerPath: string;
  /**
   * Always false when loaded from the environment. The journal is created only
   * by `wanderer budget-init`. The daemon refuses to boot if this is true.
   */
  createLedgerIfMissing: boolean;
};

const tierSchema = z
  .object({
    name: z.string().regex(TIER_NAME, "tier name must be a lowercase slug"),
    baseUrl: z.url(),
    apiKeyEnv: z
      .string()
      .regex(API_KEY_ENV, "apiKeyEnv must be an uppercase env var name ending in _API_KEY"),
    model: z.string().min(1),
    inPricePerMTok: z.string().regex(DECIMAL_MICROS, `inPricePerMTok ${DECIMAL_MESSAGE}`),
    outPricePerMTok: z.string().regex(DECIMAL_MICROS, `outPricePerMTok ${DECIMAL_MESSAGE}`),
    providerAllowlist: z
      .array(z.string().regex(PROVIDER_SLUG, "invalid provider slug"))
      .min(1)
      .optional()
  })
  .strict();

/**
 * Parse a non-negative decimal string into micro-dollars.
 * More than 6 fractional digits is rejected so the conversion is exact.
 *
 * @param value - Decimal such as `"0.14"` or `"10"`.
 * @throws {BrainError} When `value` is not a non-negative 6-place decimal.
 */
export function parseDecimalMicros(value: string): bigint {
  if (!DECIMAL_MICROS.test(value)) {
    throw new BrainError(DECIMAL_MESSAGE, "invalid_config");
  }
  const dot = value.indexOf(".");
  const whole = dot === -1 ? value : value.slice(0, dot);
  const frac = dot === -1 ? "" : value.slice(dot + 1);
  const fracPadded = `${frac}000000`.slice(0, 6);
  return BigInt(whole) * MICROS_PER_UNIT + BigInt(fracPadded);
}

/**
 * Format micro-dollars as a decimal string. Trailing fractional zeros are stripped.
 * Negative balances (a call that overshot the allowance) keep a leading minus.
 *
 * @param micros - Micro-dollars.
 */
export function formatDecimalMicros(micros: bigint): string {
  const negative = micros < 0n;
  const abs = negative ? -micros : micros;
  const whole = abs / MICROS_PER_UNIT;
  const frac = (abs % MICROS_PER_UNIT).toString().padStart(6, "0").replace(/0+$/, "");
  const body = frac.length === 0 ? whole.toString() : `${whole.toString()}.${frac}`;
  return negative ? `-${body}` : body;
}

/**
 * Estimate a call's cost, rounded up to the next micro-dollar so the ledger
 * never under-counts a fractional token price.
 *
 * @param tokensIn - Prompt tokens from {@link BrainResult.usage}.
 * @param tokensOut - Completion tokens from {@link BrainResult.usage}.
 * @param inPricePerMTokMicros - Tier input price, micro-dollars per million tokens.
 * @param outPricePerMTokMicros - Tier output price, micro-dollars per million tokens.
 */
export function estimateCostMicros(
  tokensIn: number,
  tokensOut: number,
  inPricePerMTokMicros: bigint,
  outPricePerMTokMicros: bigint
): bigint {
  if (!isTokenCount(tokensIn) || !isTokenCount(tokensOut)) {
    throw new BrainError("token counts must be non-negative safe integers", "invalid_request");
  }
  if (inPricePerMTokMicros < 0n || outPricePerMTokMicros < 0n) {
    throw new BrainError("token prices must be non-negative", "invalid_config");
  }
  const numerator =
    BigInt(tokensIn) * inPricePerMTokMicros + BigInt(tokensOut) * outPricePerMTokMicros;
  if (numerator === 0n) {
    return 0n;
  }
  return (numerator + TOKENS_PER_PRICE_UNIT - 1n) / TOKENS_PER_PRICE_UNIT;
}

/**
 * Require a canonical UTC timestamp with millisecond precision (`YYYY-MM-DDTHH:mm:ss.sssZ`).
 * Ledger lines use this form so period bounds compare as strings.
 *
 * @param value - Clock or ledger timestamp.
 * @throws {BrainError} When `value` is not that canonical form, or not a real instant.
 */
export function assertCanonicalIsoUtc(value: string): string {
  const match = CANONICAL_ISO_UTC_MS.exec(value);
  const year = match?.[1];
  const month = match?.[2];
  const day = match?.[3];
  const hour = match?.[4];
  const minute = match?.[5];
  const second = match?.[6];
  const millis = match?.[7];
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined ||
    second === undefined ||
    millis === undefined
  ) {
    throw new BrainError(
      "timestamp must be canonical ISO-8601 UTC with millisecond precision",
      "invalid_config"
    );
  }
  const utc = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    Number(millis)
  );
  if (!Number.isFinite(utc) || new Date(utc).toISOString() !== value) {
    throw new BrainError(
      "timestamp must be a real canonical ISO-8601 UTC timestamp",
      "invalid_config"
    );
  }
  return value;
}

/**
 * UTC month start containing `isoUtc`, as a canonical timestamp.
 *
 * @param isoUtc - Canonical clock reading.
 */
export function monthlyPeriodStart(isoUtc: string): string {
  const canonical = assertCanonicalIsoUtc(isoUtc);
  return `${canonical.slice(0, 7)}-01T00:00:00.000Z`;
}

/**
 * Start of the UTC month after the month containing `isoUtc`.
 *
 * @param isoUtc - Canonical clock reading or a period start.
 */
export function nextMonthlyPeriodStart(isoUtc: string): string {
  const start = monthlyPeriodStart(isoUtc);
  const year = Number(start.slice(0, 4));
  const month = Number(start.slice(5, 7));
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const iso = `${String(nextYear).padStart(4, "0")}-${String(nextMonth).padStart(2, "0")}-01T00:00:00.000Z`;
  return assertCanonicalIsoUtc(iso);
}

/**
 * Pick the tier for one completion, or sleep.
 *
 * Bands use the remaining fraction of the period allowance (threshold wins first):
 * above 50% the default tier, and distill/journal step up one tier; from 10%
 * through 50% the cheaper of the default tier and the cheapest paid tier (a
 * zero-price default is never replaced by a paid tier as the budget falls);
 * below 10% a zero-price tier only.
 * Exhausted, unknown, or provider-exhausted budgets sleep. `contextSignals`
 * is validated and ignored (v1 has no per-message weight).
 *
 * @param budgetState - Remaining budget, threshold, and the ordered tier list.
 * @param callKind - `chat`, `distill`, or `journal`.
 * @param contextSignals - Optional future weight. Non-finite `messageWeight` throws.
 */
export function chooseTier(
  budgetState: BudgetState,
  callKind: CallKind,
  contextSignals?: ContextSignals
): TierChoice {
  const weight = contextSignals?.messageWeight;
  if (weight !== undefined && !Number.isFinite(weight)) {
    throw new BrainError("contextSignals.messageWeight must be a finite number", "invalid_config");
  }
  if (!budgetState.known) {
    return { action: "sleep", reason: "ledger_unknown" };
  }
  if (budgetState.providerExhausted) {
    return { action: "sleep", reason: "provider_exhausted" };
  }
  if (budgetState.remainingMicros <= budgetState.thresholdMicros) {
    return { action: "sleep", reason: "balance_below_threshold" };
  }

  const tiers = budgetState.tiers;
  if (
    remainingAbovePercent(
      budgetState.remainingMicros,
      budgetState.budgetMicros,
      HEALTHY_REMAINING_PERCENT
    )
  ) {
    const tier = namedTier(tiers, budgetState.defaultTierName);
    const chosen = callKind === "chat" ? tier : oneTierUp(tiers, tier);
    return { action: "call", tier: chosen, band: "healthy" };
  }
  if (
    remainingAtLeastPercent(
      budgetState.remainingMicros,
      budgetState.budgetMicros,
      CONSERVE_REMAINING_PERCENT
    )
  ) {
    const tier = conserveTier(tiers, budgetState.defaultTierName);
    if (tier === undefined) {
      return { action: "sleep", reason: "no_affordable_tier" };
    }
    return { action: "call", tier, band: "conserve" };
  }

  const free = firstFree(tiers);
  if (free === undefined) {
    return { action: "sleep", reason: "no_affordable_tier" };
  }
  return { action: "call", tier: free, band: "critical" };
}

/**
 * Load treasury-lite config. Returns `undefined` when `NPC_BRAIN_TIERS` is unset
 * or empty so the single-provider Brain keeps working until a daemon wires this in.
 *
 * `NPC_BRAIN_TIERS` is public config: a JSON array ordered cheapest to most
 * expensive. Each tier is `{name, baseUrl, apiKeyEnv, model, inPricePerMTok,
 * outPricePerMTok}` plus an optional `providerAllowlist` (required for OpenRouter).
 * `apiKeyEnv` must end in `_API_KEY`. The key is read from that var or from
 * `${apiKeyEnv}_FILE`, never from the JSON. Prices are decimal strings (dollars
 * per million tokens), not JSON numbers.
 *
 * Also reads `NPC_BUDGET_USD`, `NPC_BUDGET_LEDGER_PATH` (absolute), and optionally
 * `NPC_BUDGET_THRESHOLD_USD` (default `0`), `NPC_BUDGET_PERIOD` (`monthly`), and
 * `NPC_BUDGET_DEFAULT_TIER`. Boot never creates the journal: `wanderer budget-init`
 * does, once. A set `NPC_BUDGET_LEDGER_INIT` is a config error. Error text names
 * env vars and never includes key material.
 *
 * @param env - Environment map. Tests pass a plain object; `process.env` is not mutated.
 */
export function loadBudgetConfig(env: NodeJS.ProcessEnv = process.env): BudgetConfig | undefined {
  const rawTiers = env.NPC_BRAIN_TIERS;
  if (rawTiers === undefined || rawTiers === "") {
    return undefined;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawTiers);
  } catch {
    throw new BrainError("NPC_BRAIN_TIERS must be valid JSON", "invalid_config", {
      envVar: "NPC_BRAIN_TIERS"
    });
  }

  const parsed = z.array(tierSchema).min(1).safeParse(parsedJson);
  if (!parsed.success) {
    throw new BrainError(
      `Invalid NPC_BRAIN_TIERS: ${formatZodIssues(parsed.error.issues)}`,
      "invalid_config",
      { envVar: "NPC_BRAIN_TIERS" }
    );
  }

  const tiers: BudgetTierConfig[] = [];
  const names = new Set<string>();
  for (const tier of parsed.data) {
    if (names.has(tier.name)) {
      throw new BrainError(`duplicate tier name ${tier.name}`, "invalid_config", {
        envVar: "NPC_BRAIN_TIERS"
      });
    }
    names.add(tier.name);
    tiers.push(toTierConfig(tier, env));
  }
  assertPriceOrder(tiers);
  assertOpenRouterAllowlist(tiers);

  const budgetUsd = requiredDecimal(env, "NPC_BUDGET_USD");
  const thresholdUsd =
    env.NPC_BUDGET_THRESHOLD_USD === undefined || env.NPC_BUDGET_THRESHOLD_USD === ""
      ? "0"
      : env.NPC_BUDGET_THRESHOLD_USD;
  const thresholdMicros = parseConfiguredDecimal(thresholdUsd, "NPC_BUDGET_THRESHOLD_USD");
  if (thresholdMicros > budgetUsd.micros) {
    throw new BrainError(
      "NPC_BUDGET_THRESHOLD_USD must be less than or equal to NPC_BUDGET_USD",
      "invalid_config",
      { envVar: "NPC_BUDGET_THRESHOLD_USD" }
    );
  }

  const period = env.NPC_BUDGET_PERIOD;
  if (period !== undefined && period !== "" && period !== "monthly") {
    throw new BrainError("NPC_BUDGET_PERIOD must be monthly", "invalid_config", {
      envVar: "NPC_BUDGET_PERIOD"
    });
  }

  const ledgerPath = env.NPC_BUDGET_LEDGER_PATH?.trim() ?? "";
  if (ledgerPath === "" || ledgerPath.includes("\0")) {
    throw new BrainError("NPC_BUDGET_LEDGER_PATH is required but not set", "invalid_config", {
      envVar: "NPC_BUDGET_LEDGER_PATH"
    });
  }
  if (!isAbsolute(ledgerPath)) {
    throw new BrainError("NPC_BUDGET_LEDGER_PATH must be an absolute path", "invalid_config", {
      envVar: "NPC_BUDGET_LEDGER_PATH"
    });
  }
  // Creating the file is `wanderer budget-init`. A standing env flag would
  // recreate a lost journal as zero spend on the next boot.
  if (env.NPC_BUDGET_LEDGER_INIT !== undefined && env.NPC_BUDGET_LEDGER_INIT !== "") {
    throw new BrainError(
      "NPC_BUDGET_LEDGER_INIT is not a boot setting; run `wanderer budget-init` once",
      "invalid_config",
      { envVar: "NPC_BUDGET_LEDGER_INIT" }
    );
  }

  return {
    tiers,
    budgetMicros: budgetUsd.micros,
    budgetUsd: budgetUsd.canonical,
    thresholdMicros,
    thresholdUsd: formatDecimalMicros(thresholdMicros),
    period: "monthly",
    defaultTierName: resolveDefaultTierName(tiers, env.NPC_BUDGET_DEFAULT_TIER),
    ledgerPath,
    createLedgerIfMissing: false
  };
}

/**
 * Build an `OpenAICompatBrain` config from one tier. Model, URL, and key come
 * only from the tier object. `maxTokens` and `timeoutMs` are the shared Brain limits.
 *
 * @param tier - Tier from {@link loadBudgetConfig}.
 * @param shared - Positive `maxTokens` and `timeoutMs` (the daemon's Brain limits).
 */
export function tierToOpenAICompatConfig(
  tier: BudgetTierConfig,
  shared: { maxTokens: number; timeoutMs: number }
): OpenAICompatBrainConfig {
  if (!Number.isInteger(shared.maxTokens) || shared.maxTokens <= 0) {
    throw new BrainError("maxTokens must be a positive integer", "invalid_config", {
      envVar: "NPC_BRAIN_MAX_TOKENS"
    });
  }
  if (!Number.isInteger(shared.timeoutMs) || shared.timeoutMs <= 0) {
    throw new BrainError("timeoutMs must be a positive integer", "invalid_config", {
      envVar: "NPC_BRAIN_TIMEOUT_MS"
    });
  }
  const config: OpenAICompatBrainConfig = {
    provider: "openai-compat",
    apiKey: tier.apiKey,
    model: tier.model,
    maxTokens: shared.maxTokens,
    timeoutMs: shared.timeoutMs,
    baseUrl: tier.baseUrl
  };
  if (tier.providerAllowlist !== undefined) {
    return { ...config, providerAllowlist: [...tier.providerAllowlist] };
  }
  return config;
}

function isTokenCount(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
}

function remainingAbovePercent(remaining: bigint, budget: bigint, percent: bigint): boolean {
  if (budget <= 0n || remaining <= 0n) {
    return false;
  }
  return remaining * PERCENT > budget * percent;
}

function remainingAtLeastPercent(remaining: bigint, budget: bigint, percent: bigint): boolean {
  if (budget <= 0n || remaining <= 0n) {
    return false;
  }
  return remaining * PERCENT >= budget * percent;
}

function tierPrice(tier: PricedTier): bigint {
  return tier.inPricePerMTokMicros + tier.outPricePerMTokMicros;
}

function cheapestPaid(tiers: readonly PricedTier[]): PricedTier | undefined {
  return tiers.find((tier) => tierPrice(tier) > 0n);
}

function firstFree(tiers: readonly PricedTier[]): PricedTier | undefined {
  return tiers.find((tier) => tierPrice(tier) === 0n);
}

/**
 * Conserve band. Never more expensive than the tier chat already uses when healthy,
 * so a free default does not jump to a paid model as the allowance shrinks.
 */
function conserveTier(
  tiers: readonly PricedTier[],
  defaultTierName: string
): PricedTier | undefined {
  const fallback = namedTier(tiers, defaultTierName);
  const paid = cheapestPaid(tiers);
  if (paid === undefined) {
    return tierPrice(fallback) === 0n ? fallback : firstFree(tiers);
  }
  return tierPrice(fallback) <= tierPrice(paid) ? fallback : paid;
}

function namedTier(tiers: readonly PricedTier[], name: string): PricedTier {
  const tier = tiers.find((item) => item.name === name);
  if (tier === undefined) {
    throw new BrainError(`default tier ${name} is not in the tier list`, "invalid_config", {
      envVar: "NPC_BUDGET_DEFAULT_TIER"
    });
  }
  return tier;
}

function oneTierUp(tiers: readonly PricedTier[], tier: PricedTier): PricedTier {
  const index = tiers.findIndex((item) => item.name === tier.name);
  if (index < 0) {
    return tier;
  }
  return tiers[index + 1] ?? tier;
}

function formatZodIssues(issues: readonly { path: PropertyKey[]; message: string }[]): string {
  return issues
    .map((issue) => {
      const path =
        issue.path.length > 0 ? issue.path.map((part) => String(part)).join(".") : "tiers";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

function toTierConfig(tier: z.infer<typeof tierSchema>, env: NodeJS.ProcessEnv): BudgetTierConfig {
  const baseUrl = tier.baseUrl.replace(/\/+$/, "");
  const apiKey = resolveSecretFromEnv(env, tier.apiKeyEnv, `${tier.apiKeyEnv}_FILE`);
  const config: BudgetTierConfig = {
    name: tier.name,
    model: tier.model,
    baseUrl,
    apiKey,
    inPricePerMTok: tier.inPricePerMTok,
    outPricePerMTok: tier.outPricePerMTok,
    inPricePerMTokMicros: parseDecimalMicros(tier.inPricePerMTok),
    outPricePerMTokMicros: parseDecimalMicros(tier.outPricePerMTok)
  };
  if (tier.providerAllowlist !== undefined) {
    return { ...config, providerAllowlist: tier.providerAllowlist };
  }
  return config;
}

function assertPriceOrder(tiers: readonly BudgetTierConfig[]): void {
  let previous = 0n;
  for (const tier of tiers) {
    const total = tierPrice(tier);
    if (total < previous) {
      throw new BrainError(
        "NPC_BRAIN_TIERS must be ordered from cheapest to most expensive",
        "invalid_config",
        { envVar: "NPC_BRAIN_TIERS" }
      );
    }
    previous = total;
  }
}

function assertOpenRouterAllowlist(tiers: readonly BudgetTierConfig[]): void {
  for (const tier of tiers) {
    if (isOpenRouterBaseUrl(tier.baseUrl) && (tier.providerAllowlist?.length ?? 0) === 0) {
      throw new BrainError(
        `tier ${tier.name} uses OpenRouter and requires a non-empty providerAllowlist`,
        "invalid_config",
        { envVar: "NPC_BRAIN_TIERS" }
      );
    }
  }
}

function requiredDecimal(
  env: NodeJS.ProcessEnv,
  name: string
): { micros: bigint; canonical: string } {
  const raw = env[name];
  if (raw === undefined || raw === "") {
    throw new BrainError(`${name} is required but not set`, "invalid_config", { envVar: name });
  }
  const micros = parseConfiguredDecimal(raw, name);
  return { micros, canonical: formatDecimalMicros(micros) };
}

function parseConfiguredDecimal(raw: string, name: string): bigint {
  try {
    return parseDecimalMicros(raw);
  } catch (error: unknown) {
    if (error instanceof BrainError) {
      throw new BrainError(`${name} ${DECIMAL_MESSAGE}`, "invalid_config", { envVar: name });
    }
    throw error;
  }
}

function resolveDefaultTierName(
  tiers: readonly BudgetTierConfig[],
  requested: string | undefined
): string {
  if (requested !== undefined && requested !== "") {
    if (!tiers.some((tier) => tier.name === requested)) {
      throw new BrainError(
        `NPC_BUDGET_DEFAULT_TIER ${requested} is not a configured tier`,
        "invalid_config",
        { envVar: "NPC_BUDGET_DEFAULT_TIER" }
      );
    }
    return requested;
  }
  const paid = cheapestPaid(tiers);
  const fallback = paid ?? tiers[0];
  if (fallback === undefined) {
    throw new BrainError("NPC_BRAIN_TIERS must contain at least one tier", "invalid_config", {
      envVar: "NPC_BRAIN_TIERS"
    });
  }
  return fallback.name;
}
