import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  chooseTier,
  estimateCostMicros,
  formatDecimalMicros,
  loadBudgetConfig,
  monthlyPeriodStart,
  nextMonthlyPeriodStart,
  parseDecimalMicros,
  tierToOpenAICompatConfig,
  type BudgetState,
  type CallKind,
  type PricedTier
} from "../src/brain/budget-policy.js";
import { BudgetedBrain, BudgetError } from "../src/brain/budgeted-brain.js";
import { BrainError } from "../src/brain/errors.js";
import { FakeBrain } from "../src/brain/fake-brain.js";
import { openBudgetedBrain } from "../src/brain/open-budgeted-brain.js";
import { SpendLedger } from "../src/brain/spend-ledger.js";
import type { Brain } from "../src/brain/types.js";

const NOW = "2026-11-16T12:00:00.000Z";
const SECRET = "test-key-DO-NOT-LEAK";

function sampleTiers(): PricedTier[] {
  return [
    { name: "free", model: "tier-free", inPricePerMTokMicros: 0n, outPricePerMTokMicros: 0n },
    {
      name: "cheap",
      model: "tier-cheap",
      inPricePerMTokMicros: 0n,
      outPricePerMTokMicros: 10_000_000n
    },
    {
      name: "quality",
      model: "tier-quality",
      inPricePerMTokMicros: 0n,
      outPricePerMTokMicros: 60_000_000n
    }
  ];
}

function state(
  overrides: {
    remainingMicros?: bigint;
    budgetMicros?: bigint;
    thresholdMicros?: bigint;
    known?: boolean;
    providerExhausted?: boolean;
    defaultTierName?: string;
    tiers?: readonly PricedTier[];
  } = {}
): BudgetState {
  return {
    known: overrides.known ?? true,
    budgetMicros: overrides.budgetMicros ?? 100n,
    remainingMicros: overrides.remainingMicros ?? 100n,
    thresholdMicros: overrides.thresholdMicros ?? 0n,
    providerExhausted: overrides.providerExhausted ?? false,
    tiers: overrides.tiers ?? sampleTiers(),
    defaultTierName: overrides.defaultTierName ?? "cheap"
  };
}

function tierName(choice: ReturnType<typeof chooseTier>): string {
  if (choice.action === "sleep") {
    return `sleep:${choice.reason}`;
  }
  return choice.tier.name;
}

describe("decimal micros", () => {
  it("round-trips decimals and rounds cost up", () => {
    expect(parseDecimalMicros("0.14")).toBe(140_000n);
    expect(parseDecimalMicros("10")).toBe(10_000_000n);
    expect(formatDecimalMicros(140_000n)).toBe("0.14");
    expect(formatDecimalMicros(1n)).toBe("0.000001");
    expect(formatDecimalMicros(-1n)).toBe("-0.000001");
    expect(estimateCostMicros(1, 0, 1n, 0n)).toBe(1n);
    expect(estimateCostMicros(1_000_000, 0, 140_000n, 0n)).toBe(140_000n);
  });

  it("rejects bad decimals and token counts", () => {
    expect(() => parseDecimalMicros("0.0000001")).toThrow(BrainError);
    expect(() => parseDecimalMicros("-1")).toThrow(BrainError);
    expect(() => estimateCostMicros(-1, 0, 1n, 0n)).toThrow(BrainError);
    expect(() => estimateCostMicros(1, 1.5, 1n, 1n)).toThrow(/safe integers/);
  });
});

describe("month boundaries", () => {
  it("uses UTC month starts and rolls the year", () => {
    expect(monthlyPeriodStart(NOW)).toBe("2026-11-01T00:00:00.000Z");
    expect(nextMonthlyPeriodStart("2026-12-16T00:00:00.000Z")).toBe("2027-01-01T00:00:00.000Z");
  });

  it("rejects timestamps that are not canonical millisecond UTC", () => {
    expect(() => monthlyPeriodStart("2026-11-16T12:00:00Z")).toThrow(BrainError);
    expect(() => monthlyPeriodStart("2026-13-01T00:00:00.000Z")).toThrow(BrainError);
  });
});

describe("chooseTier", () => {
  it.each<[bigint, CallKind, string]>([
    [51n, "chat", "cheap"],
    [51n, "distill", "quality"],
    [51n, "journal", "quality"],
    [50n, "chat", "cheap"],
    [50n, "distill", "cheap"],
    [10n, "journal", "cheap"],
    [9n, "chat", "free"],
    [9n, "distill", "free"],
    [0n, "chat", "sleep:balance_below_threshold"]
  ])("remaining %s %s -> %s", (remaining, kind, expected) => {
    expect(tierName(chooseTier(state({ remainingMicros: remaining }), kind))).toBe(expected);
  });

  it("lets the survival threshold win over a healthy fraction", () => {
    const choice = chooseTier(state({ remainingMicros: 80n, thresholdMicros: 90n }), "chat");
    expect(choice).toEqual({ action: "sleep", reason: "balance_below_threshold" });
  });

  it("sleeps when the ledger is unknown, the provider is exhausted, or no free tier exists", () => {
    expect(chooseTier(state({ known: false, remainingMicros: 100n }), "chat").action).toBe("sleep");
    expect(
      chooseTier(state({ providerExhausted: true, remainingMicros: 100n }), "chat")
    ).toMatchObject({ action: "sleep", reason: "provider_exhausted" });
    const paidOnly = sampleTiers().filter((tier) => tier.name !== "free");
    expect(chooseTier(state({ remainingMicros: 9n, tiers: paidOnly }), "chat")).toMatchObject({
      action: "sleep",
      reason: "no_affordable_tier"
    });
  });

  it("ignores a finite message weight and rejects a non-finite one", () => {
    const base = chooseTier(state({ remainingMicros: 51n }), "distill");
    const weighted = chooseTier(state({ remainingMicros: 51n }), "distill", { messageWeight: 100 });
    expect(weighted).toEqual(base);
    expect(() => chooseTier(state(), "chat", { messageWeight: Number.NaN })).toThrow(BrainError);
  });

  it("throws when the default tier is missing", () => {
    expect(() => chooseTier(state({ defaultTierName: "missing" }), "chat")).toThrow(
      /default tier missing/
    );
  });

  it("does not move chat onto a paid tier when the default tier is free", () => {
    expect(
      tierName(chooseTier(state({ remainingMicros: 51n, defaultTierName: "free" }), "chat"))
    ).toBe("free");
    expect(
      tierName(chooseTier(state({ remainingMicros: 40n, defaultTierName: "free" }), "chat"))
    ).toBe("free");
    expect(
      tierName(chooseTier(state({ remainingMicros: 10n, defaultTierName: "free" }), "chat"))
    ).toBe("free");
    expect(
      tierName(chooseTier(state({ remainingMicros: 51n, defaultTierName: "free" }), "distill"))
    ).toBe("cheap");
    expect(
      tierName(chooseTier(state({ remainingMicros: 40n, defaultTierName: "free" }), "distill"))
    ).toBe("free");
  });
});

describe("loadBudgetConfig", () => {
  function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    return {
      NPC_BRAIN_TIERS: JSON.stringify([
        {
          name: "free",
          baseUrl: "https://example.com/v1",
          apiKeyEnv: "NPC_BRAIN_API_KEY",
          model: "tier-free",
          inPricePerMTok: "0",
          outPricePerMTok: "0"
        },
        {
          name: "cheap",
          baseUrl: "https://openrouter.ai/api/v1/",
          apiKeyEnv: "NPC_BRAIN_API_KEY",
          model: "tier-cheap",
          inPricePerMTok: "0.14",
          outPricePerMTok: "0.28",
          providerAllowlist: ["deepinfra"]
        }
      ]),
      NPC_BRAIN_API_KEY: "from-env",
      NPC_BUDGET_USD: "10",
      NPC_BUDGET_LEDGER_PATH: "/data/runtime/spend.jsonl",
      ...extra
    };
  }

  it("returns undefined when tiers are unset", () => {
    expect(loadBudgetConfig({})).toBeUndefined();
    expect(loadBudgetConfig({ NPC_BRAIN_TIERS: "" })).toBeUndefined();
  });

  it("parses tiers, strips the base URL, and defaults the tier to the cheapest paid", () => {
    const config = loadBudgetConfig(env());
    expect(config?.defaultTierName).toBe("cheap");
    expect(config?.budgetUsd).toBe("10");
    expect(config?.thresholdUsd).toBe("0");
    expect(config?.createLedgerIfMissing).toBe(false);
    expect(config?.tiers[1]?.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(config?.tiers[1]?.inPricePerMTokMicros).toBe(140_000n);
  });

  it("honors an explicit default tier and never creates the journal at boot", () => {
    const config = loadBudgetConfig(env({ NPC_BUDGET_DEFAULT_TIER: "free" }));
    expect(config?.defaultTierName).toBe("free");
    expect(config?.createLedgerIfMissing).toBe(false);
  });

  it("rejects a standing ledger-init flag and an apiKeyEnv that is not an API key", () => {
    expect(() => loadBudgetConfig(env({ NPC_BUDGET_LEDGER_INIT: "1" }))).toThrow(/budget-init/);
    const planted = env();
    planted.DISCORD_BOT_TOKEN = SECRET;
    planted.NPC_BRAIN_TIERS = JSON.stringify([
      {
        name: "cheap",
        baseUrl: "https://example.com/v1",
        apiKeyEnv: "DISCORD_BOT_TOKEN",
        model: "tier-cheap",
        inPricePerMTok: "1",
        outPricePerMTok: "1"
      }
    ]);
    expect(() => loadBudgetConfig(planted)).toThrow(/_API_KEY/);
    try {
      loadBudgetConfig(planted);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "";
      expect(message).not.toContain(SECRET);
    }
  });

  it("fails open when the spend journal was never created, and still opens a corrupt one", async () => {
    const loaded = loadBudgetConfig(env());
    expect(loaded).toBeDefined();
    if (loaded === undefined) {
      return;
    }
    const dir = await mkdtemp(join(tmpdir(), "npc-budget-missing-"));
    try {
      const missing = join(dir, "spend.jsonl");
      const options = {
        budget: { ...loaded, ledgerPath: missing },
        maxTokens: 16,
        timeoutMs: 1_000,
        clock: (): string => NOW,
        createTierBrain: (): FakeBrain => new FakeBrain(["unused"])
      };
      await expect(openBudgetedBrain(options)).rejects.toThrow(/wanderer budget-init/);
      try {
        await openBudgetedBrain(options);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : "";
        expect(message).not.toContain(SECRET);
        expect(message).not.toContain("from-env");
      }
      await writeFile(missing, "not-json\n", "utf8");
      const corrupt = await openBudgetedBrain({
        ...options,
        budget: { ...loaded, ledgerPath: missing }
      });
      expect(corrupt.publicStatus().sleepReason).toBe("ledger_unknown");
      expect(corrupt.sleepDraft()).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("resolves a tier key from the named env var and from its _FILE companion", async () => {
    const direct = loadBudgetConfig(env());
    expect(direct?.tiers[0]?.apiKey).toBe("from-env");
    expect(direct?.tiers[1]?.apiKey).toBe("from-env");

    const keyDir = await mkdtemp(join(tmpdir(), "npc-budget-key-"));
    try {
      const file = join(keyDir, "key");
      await writeFile(file, "from-file\n", "utf8");
      const fromFile = env();
      delete fromFile.NPC_BRAIN_API_KEY;
      fromFile.NPC_BRAIN_API_KEY_FILE = file;
      expect(loadBudgetConfig(fromFile)?.tiers[0]?.apiKey).toBe("from-file");
    } finally {
      await rm(keyDir, { recursive: true, force: true });
    }

    const both = env();
    both.NPC_BRAIN_API_KEY_FILE = "/tmp/unused-tier-key";
    expect(() => loadBudgetConfig(both)).toThrow(
      /set only one of NPC_BRAIN_API_KEY or NPC_BRAIN_API_KEY_FILE/
    );
  });

  it("names a missing or invalid key var and does not echo a secret value", () => {
    const missing = env();
    delete missing.NPC_BRAIN_API_KEY;
    missing.NPC_DECOY = SECRET;
    expect(() => loadBudgetConfig(missing)).toThrow(BrainError);
    try {
      loadBudgetConfig(missing);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "";
      expect(message).toContain("NPC_BRAIN_API_KEY");
      expect(message).not.toContain(SECRET);
    }

    const invalid = env();
    invalid.NPC_DECOY = SECRET;
    invalid.NPC_BRAIN_TIERS = JSON.stringify([
      {
        name: "cheap",
        baseUrl: "https://example.com/v1",
        apiKeyEnv: "not-a-name",
        model: "tier-cheap",
        inPricePerMTok: "1",
        outPricePerMTok: "1"
      }
    ]);
    expect(() => loadBudgetConfig(invalid)).toThrow(BrainError);
    try {
      loadBudgetConfig(invalid);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "";
      expect(message).toMatch(/apiKeyEnv/);
      expect(message).not.toContain(SECRET);
    }

    const unordered = env({ NPC_BRAIN_API_KEY: SECRET });
    unordered.NPC_BRAIN_TIERS = JSON.stringify([
      {
        name: "cheap",
        baseUrl: "https://example.com/v1",
        apiKeyEnv: "NPC_BRAIN_API_KEY",
        model: "tier-cheap",
        inPricePerMTok: "1",
        outPricePerMTok: "1"
      },
      {
        name: "free",
        baseUrl: "https://example.com/v1",
        apiKeyEnv: "NPC_BRAIN_API_KEY",
        model: "tier-free",
        inPricePerMTok: "0",
        outPricePerMTok: "0"
      }
    ]);
    expect(() => loadBudgetConfig(unordered)).toThrow(BrainError);
    try {
      loadBudgetConfig(unordered);
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(BrainError);
      expect(error instanceof Error ? error.message : "").not.toContain(SECRET);
    }
  });

  it("rejects OpenRouter without an allowlist, a bad period, and a threshold above the budget", () => {
    const noList = env();
    noList.NPC_BRAIN_TIERS = JSON.stringify([
      {
        name: "cheap",
        baseUrl: "https://openrouter.ai/api/v1",
        apiKeyEnv: "NPC_BRAIN_API_KEY",
        model: "tier-cheap",
        inPricePerMTok: "0.1",
        outPricePerMTok: "0.1"
      }
    ]);
    expect(() => loadBudgetConfig(noList)).toThrow(/providerAllowlist/);
    expect(() => loadBudgetConfig(env({ NPC_BUDGET_PERIOD: "weekly" }))).toThrow(/monthly/);
    expect(() => loadBudgetConfig(env({ NPC_BUDGET_THRESHOLD_USD: "11" }))).toThrow(/THRESHOLD/);
    expect(() => loadBudgetConfig(env({ NPC_BUDGET_LEDGER_PATH: "spend.jsonl" }))).toThrow(
      /absolute/
    );
    expect(() =>
      loadBudgetConfig(env({ NPC_BUDGET_LEDGER_PATH: "spend.jsonl", NPC_BUDGET_LEDGER_INIT: "1" }))
    ).toThrow(/absolute/);
    expect(() => loadBudgetConfig({ NPC_BRAIN_TIERS: "[]" })).toThrow(BrainError);
  });

  it("maps a tier onto an OpenAI-compat config", () => {
    const loaded = loadBudgetConfig(env());
    const cheap = loaded?.tiers[1];
    if (cheap === undefined) {
      throw new Error("expected cheap tier");
    }
    const config = tierToOpenAICompatConfig(cheap, { maxTokens: 128, timeoutMs: 1000 });
    expect(config).toMatchObject({
      provider: "openai-compat",
      apiKey: "from-env",
      model: "tier-cheap",
      baseUrl: "https://openrouter.ai/api/v1",
      maxTokens: 128,
      providerAllowlist: ["deepinfra"]
    });
    const free = loaded?.tiers[0];
    if (free === undefined) {
      throw new Error("expected free tier");
    }
    const freeConfig = tierToOpenAICompatConfig(free, { maxTokens: 128, timeoutMs: 1000 });
    expect("providerAllowlist" in freeConfig).toBe(false);
    expect(() => tierToOpenAICompatConfig(cheap, { maxTokens: 0, timeoutMs: 1000 })).toThrow(
      BrainError
    );
  });
});

describe("SpendLedger", () => {
  let dir = "";

  afterEach(async () => {
    if (dir !== "") {
      await rm(dir, { recursive: true, force: true });
      dir = "";
    }
  });

  async function ledgerPath(name = "spend.jsonl"): Promise<string> {
    dir = await mkdtemp(join(tmpdir(), "npc-budget-"));
    return join(dir, name);
  }

  it("creates an empty journal only when asked, then replays spend inside the month", async () => {
    const path = await ledgerPath();
    const missing = await SpendLedger.open({ path, createIfMissing: false });
    expect(missing.replay(NOW)).toEqual({ trusted: false, reason: "missing" });

    const ledger = await SpendLedger.open({ path, createIfMissing: true });
    expect(ledger.replay(NOW)).toMatchObject({ trusted: true, spentMicros: 0n });
    await ledger.append({
      kind: "spend",
      ts: NOW,
      tier: "cheap",
      model: "tier-cheap",
      tokens_in: 1_000_000,
      tokens_out: 0,
      est_cost: "0.14"
    });
    await ledger.append({
      kind: "spend",
      ts: "2026-12-01T00:00:00.000Z",
      tier: "cheap",
      model: "tier-cheap",
      tokens_in: 1,
      tokens_out: 0,
      est_cost: "1"
    });
    expect(ledger.replay(NOW)).toMatchObject({ trusted: true, spentMicros: 140_000n });
    expect(ledger.replay("2026-12-02T00:00:00.000Z")).toMatchObject({
      trusted: true,
      spentMicros: 1_000_000n
    });
  });

  it("leaves a torn or corrupt journal untouched and untrusted", async () => {
    const path = await ledgerPath();
    const torn = `${JSON.stringify({
      kind: "spend",
      ts: NOW,
      tier: "cheap",
      model: "tier-cheap",
      tokens_in: 1,
      tokens_out: 0,
      est_cost: "0.1"
    })}\n{"kind":"sp`;
    await writeFile(path, torn);
    const tornLedger = await SpendLedger.open({ path, createIfMissing: true });
    expect(tornLedger.replay(NOW)).toEqual({ trusted: false, reason: "torn" });
    expect(await readFile(path, "utf8")).toBe(torn);
    await expect(tornLedger.append({ kind: "wake", ts: NOW, reason: "operator" })).rejects.toThrow(
      /untrusted/
    );

    const corrupt = '{"kind":"nope"}\n';
    await writeFile(path, corrupt);
    const corruptLedger = await SpendLedger.open({ path, createIfMissing: true });
    expect(corruptLedger.replay(NOW)).toEqual({ trusted: false, reason: "corrupt" });
    expect(await readFile(path, "utf8")).toBe(corrupt);
  });

  it("clears provider exhaustion on wake and drops it in the next month", async () => {
    const path = await ledgerPath();
    const ledger = await SpendLedger.open({ path, createIfMissing: true });
    await ledger.append({
      kind: "provider_exhausted",
      ts: NOW,
      tier: "cheap",
      model: "tier-cheap"
    });
    expect(ledger.replay(NOW)).toMatchObject({ providerExhausted: true });
    await ledger.append({ kind: "wake", ts: NOW, reason: "operator" });
    expect(ledger.replay(NOW)).toMatchObject({ providerExhausted: false, unknownSpend: false });
    const later = await SpendLedger.open({ path, createIfMissing: false });
    expect(later.replay("2026-12-01T00:00:00.000Z")).toMatchObject({
      trusted: true,
      providerExhausted: false,
      spentMicros: 0n
    });
  });
});

describe("BudgetedBrain", () => {
  let dir = "";

  afterEach(async () => {
    if (dir !== "") {
      await rm(dir, { recursive: true, force: true });
      dir = "";
    }
  });

  async function build(options?: {
    budgetMicros?: bigint;
    thresholdMicros?: bigint;
    createIfMissing?: boolean;
    path?: string;
    now?: string;
  }): Promise<{
    brain: BudgetedBrain;
    brains: Map<string, FakeBrain>;
    clock: { now: string };
    path: string;
  }> {
    dir = await mkdtemp(join(tmpdir(), "npc-budget-"));
    const path = options?.path ?? join(dir, "spend.jsonl");
    const ledger = await SpendLedger.open({
      path,
      createIfMissing: options?.createIfMissing ?? true
    });
    const usage = { promptTokens: 0, completionTokens: 1 };
    const brains = new Map<string, FakeBrain>([
      ["free", new FakeBrain([{ text: "free", usage }])],
      ["cheap", new FakeBrain([{ text: "cheap", usage }])],
      ["quality", new FakeBrain([{ text: "quality", usage }])]
    ]);
    const clock = { now: options?.now ?? NOW };
    const brain = new BudgetedBrain({
      tiers: sampleTiers(),
      brains,
      ledger,
      budgetMicros: options?.budgetMicros ?? 100n,
      thresholdMicros: options?.thresholdMicros ?? 0n,
      defaultTierName: "cheap",
      clock: () => clock.now
    });
    return { brain, brains, clock, path };
  }

  it("calls only the chosen tier and records ceiled usage", async () => {
    const { brain, brains, path } = await build();
    await expect(brain.complete([{ role: "user", content: "hi" }])).resolves.toMatchObject({
      text: "cheap"
    });
    expect(brains.get("cheap")?.calls).toHaveLength(1);
    expect(brains.get("free")?.calls).toHaveLength(0);
    expect(brains.get("quality")?.calls).toHaveLength(0);
    const distill = brain.forKind("distill");
    await expect(distill.complete([{ role: "user", content: "remember" }])).resolves.toMatchObject({
      text: "quality"
    });
    const lines = (await readFile(path, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('"tier":"cheap"');
    expect(lines[0]).toContain('"est_cost":"0.00001"');
  });

  it("sleeps after the call that spends the allowance, without another model call", async () => {
    dir = await mkdtemp(join(tmpdir(), "npc-budget-"));
    const ledger = await SpendLedger.open({
      path: join(dir, "priced.jsonl"),
      createIfMissing: true
    });
    const cheap = new FakeBrain([
      { text: "once", usage: { promptTokens: 0, completionTokens: 1 } },
      "should-not-run"
    ]);
    const free = new FakeBrain(["free"]);
    const brain = new BudgetedBrain({
      tiers: sampleTiers(),
      brains: new Map<string, Brain>([
        ["free", free],
        ["cheap", cheap],
        ["quality", new FakeBrain(["quality"])]
      ]),
      ledger,
      budgetMicros: 10n,
      thresholdMicros: 0n,
      defaultTierName: "cheap",
      clock: () => NOW
    });
    await brain.complete([{ role: "user", content: "hi" }]);
    await expect(brain.complete([{ role: "user", content: "again" }])).rejects.toBeInstanceOf(
      BudgetError
    );
    expect(cheap.calls).toHaveLength(1);
    expect(free.calls).toHaveLength(0);
  });

  it("latches when a paid tier returns zero usage and does not call again", async () => {
    dir = await mkdtemp(join(tmpdir(), "npc-budget-"));
    const ledger = await SpendLedger.open({
      path: join(dir, "zero.jsonl"),
      createIfMissing: true
    });
    const cheap = new FakeBrain(["ok", "should-not-run"]);
    const brain = new BudgetedBrain({
      tiers: sampleTiers().filter((tier) => tier.name === "cheap"),
      brains: new Map<string, Brain>([["cheap", cheap]]),
      ledger,
      budgetMicros: 1n,
      thresholdMicros: 0n,
      defaultTierName: "cheap",
      clock: () => NOW
    });
    await expect(brain.complete([{ role: "user", content: "hi" }])).resolves.toMatchObject({
      text: "ok"
    });
    await expect(brain.complete([{ role: "user", content: "again" }])).rejects.toMatchObject({
      budgetReason: "ledger_unknown"
    });
    expect(cheap.calls).toHaveLength(1);
    const text = await readFile(join(dir, "zero.jsonl"), "utf8");
    expect(text).toContain('"kind":"unknown_spend"');
    expect(text).not.toContain('"est_cost"');
  });

  it("records a zero cost when a free tier reports zero usage", async () => {
    dir = await mkdtemp(join(tmpdir(), "npc-budget-"));
    const path = join(dir, "free.jsonl");
    const ledger = await SpendLedger.open({ path, createIfMissing: true });
    const free = new FakeBrain(["a", "b"]);
    const freeTier = sampleTiers().find((tier) => tier.name === "free");
    if (freeTier === undefined) {
      throw new Error("expected free tier");
    }
    const brain = new BudgetedBrain({
      tiers: [freeTier],
      brains: new Map<string, Brain>([["free", free]]),
      ledger,
      budgetMicros: 1n,
      thresholdMicros: 0n,
      defaultTierName: "free",
      clock: () => NOW
    });
    await brain.complete([{ role: "user", content: "hi" }]);
    await brain.complete([{ role: "user", content: "again" }]);
    expect(free.calls).toHaveLength(2);
    const text = await readFile(path, "utf8");
    expect(text).toContain('"est_cost":"0"');
    expect(text).not.toContain("unknown_spend");
  });

  it("records a provider 402 and resumes after an operator wake", async () => {
    dir = await mkdtemp(join(tmpdir(), "npc-budget-"));
    const failing = new FakeBrain(() => {
      throw new BrainError("provider credits", "credit_exhausted");
    });
    const recovering = new FakeBrain(["back"]);
    let calls = 0;
    const switching = new FakeBrain(() => {
      calls += 1;
      if (calls === 1) {
        return failing.complete([]);
      }
      return recovering.complete([]);
    });
    const path = join(dir, "wake.jsonl");
    const ledger = await SpendLedger.open({ path, createIfMissing: true });
    const brains = new Map<string, Brain>([
      ["free", new FakeBrain(["free"])],
      ["cheap", switching],
      ["quality", new FakeBrain(["quality"])]
    ]);
    const budgeted = new BudgetedBrain({
      tiers: sampleTiers(),
      brains,
      ledger,
      budgetMicros: 100n,
      thresholdMicros: 0n,
      defaultTierName: "cheap",
      clock: () => NOW
    });
    await expect(budgeted.complete([{ role: "user", content: "hi" }])).rejects.toMatchObject({
      reason: "credit_exhausted"
    });
    await expect(budgeted.complete([{ role: "user", content: "hi" }])).rejects.toMatchObject({
      budgetReason: "provider_exhausted"
    });
    expect(calls).toBe(1);
    await budgeted.wake("operator");
    await expect(budgeted.complete([{ role: "user", content: "hi" }])).resolves.toMatchObject({
      text: "back"
    });
  });

  it("wakes on the next UTC month without an operator wake", async () => {
    const clock = { now: NOW };
    const path = join(await ledgerPathOnly(), "month.jsonl");
    const ledger = await SpendLedger.open({ path, createIfMissing: true });
    let calls = 0;
    const cheap = new FakeBrain(() => {
      calls += 1;
      if (calls === 1) {
        throw new BrainError("provider credits", "credit_exhausted");
      }
      return "later";
    });
    const budgeted = new BudgetedBrain({
      tiers: sampleTiers(),
      brains: new Map<string, Brain>([
        ["free", new FakeBrain(["free"])],
        ["cheap", cheap],
        ["quality", new FakeBrain(["quality"])]
      ]),
      ledger,
      budgetMicros: 100n,
      thresholdMicros: 0n,
      defaultTierName: "cheap",
      clock: () => clock.now
    });
    await expect(budgeted.complete([{ role: "user", content: "hi" }])).rejects.toBeInstanceOf(
      BrainError
    );
    clock.now = "2026-12-01T00:00:00.000Z";
    await expect(budgeted.complete([{ role: "user", content: "hi" }])).resolves.toMatchObject({
      text: "later"
    });
    expect(calls).toBe(2);
  });

  async function ledgerPathOnly(): Promise<string> {
    dir = await mkdtemp(join(tmpdir(), "npc-budget-"));
    return dir;
  }

  it("does not call a model when the ledger is missing", async () => {
    dir = await mkdtemp(join(tmpdir(), "npc-budget-"));
    const path = join(dir, "missing.jsonl");
    const ledger = await SpendLedger.open({ path, createIfMissing: false });
    const brains = new Map<string, FakeBrain>([
      ["free", new FakeBrain(["free"])],
      ["cheap", new FakeBrain(["cheap"])],
      ["quality", new FakeBrain(["quality"])]
    ]);
    const brain = new BudgetedBrain({
      tiers: sampleTiers(),
      brains,
      ledger,
      budgetMicros: 100n,
      thresholdMicros: 0n,
      defaultTierName: "cheap",
      clock: () => NOW
    });
    await expect(brain.complete([{ role: "user", content: "hi" }])).rejects.toMatchObject({
      budgetReason: "ledger_unknown"
    });
    expect(brains.get("cheap")?.calls).toHaveLength(0);
    expect(brain.sleepDraft()).toBeNull();
    expect(brain.publicStatus()).toMatchObject({
      sleeping: true,
      tier: null,
      remainingFraction: null,
      sleepReason: "ledger_unknown"
    });
  });

  it("serializes calls so the second sees the first call's spend", async () => {
    dir = await mkdtemp(join(tmpdir(), "npc-budget-"));
    const ledger = await SpendLedger.open({
      path: join(dir, "serial.jsonl"),
      createIfMissing: true
    });
    let release: () => void = () => undefined;
    const block = new Promise<void>((resolve) => {
      release = resolve;
    });
    let qualityEntered = 0;
    let cheapEntered = 0;
    const quality = new FakeBrain(async () => {
      qualityEntered += 1;
      await block;
      return { text: "q", usage: { promptTokens: 0, completionTokens: 1 } };
    });
    const cheap = new FakeBrain(async () => {
      cheapEntered += 1;
      return { text: "c", usage: { promptTokens: 0, completionTokens: 1 } };
    });
    const brain = new BudgetedBrain({
      tiers: sampleTiers(),
      brains: new Map<string, Brain>([
        ["free", new FakeBrain(["free"])],
        ["cheap", cheap],
        ["quality", quality]
      ]),
      ledger,
      budgetMicros: 100n,
      thresholdMicros: 0n,
      defaultTierName: "cheap",
      clock: () => NOW
    });
    const distill = brain.forKind("distill");
    const first = distill.complete([{ role: "user", content: "a" }]);
    await vi.waitFor(() => {
      expect(qualityEntered).toBe(1);
    });
    const second = distill.complete([{ role: "user", content: "b" }]);
    await Promise.resolve();
    expect(cheapEntered).toBe(0);
    expect(qualityEntered).toBe(1);
    release();
    await expect(first).resolves.toMatchObject({ text: "q" });
    await expect(second).resolves.toMatchObject({ text: "c" });
    expect(qualityEntered).toBe(1);
    expect(cheapEntered).toBe(1);
  });

  it("persists an unpriced completion and stops until wake", async () => {
    dir = await mkdtemp(join(tmpdir(), "npc-budget-"));
    const odd = new FakeBrain([
      { text: "odd", usage: { promptTokens: 1.5, completionTokens: 0 } },
      "again"
    ]);
    const path = join(dir, "odd.jsonl");
    const ledger = await SpendLedger.open({ path, createIfMissing: true });
    const budgeted = new BudgetedBrain({
      tiers: sampleTiers(),
      brains: new Map<string, Brain>([
        ["free", new FakeBrain(["free"])],
        ["cheap", odd],
        ["quality", new FakeBrain(["quality"])]
      ]),
      ledger,
      budgetMicros: 100n,
      thresholdMicros: 0n,
      defaultTierName: "cheap",
      clock: () => NOW
    });
    await expect(budgeted.complete([{ role: "user", content: "hi" }])).resolves.toMatchObject({
      text: "odd"
    });
    await expect(budgeted.complete([{ role: "user", content: "hi" }])).rejects.toMatchObject({
      budgetReason: "ledger_unknown"
    });
    expect(budgeted.sleepDraft()).toBeNull();
    expect(odd.calls).toHaveLength(1);
    await budgeted.wake("operator");
    await expect(budgeted.complete([{ role: "user", content: "hi" }])).resolves.toMatchObject({
      text: "again"
    });
    expect(odd.calls).toHaveLength(2);
  });

  it("rejects a tier with no brain", async () => {
    dir = await mkdtemp(join(tmpdir(), "npc-budget-"));
    const ledger = await SpendLedger.open({
      path: join(dir, "empty.jsonl"),
      createIfMissing: true
    });
    expect(
      () =>
        new BudgetedBrain({
          tiers: sampleTiers(),
          brains: new Map(),
          ledger,
          budgetMicros: 1n,
          thresholdMicros: 0n,
          defaultTierName: "cheap",
          clock: () => NOW
        })
    ).toThrow(/no Brain registered/);
  });

  it("sleepDraft is the known balance, and publicStatus does not wait on an in-flight call", async () => {
    dir = await mkdtemp(join(tmpdir(), "npc-budget-"));
    const ledger = await SpendLedger.open({
      path: join(dir, "status.jsonl"),
      createIfMissing: true
    });
    let release: () => void = () => undefined;
    const block = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = 0;
    const cheap = new FakeBrain(async () => {
      entered += 1;
      await block;
      return { text: "ok", usage: { promptTokens: 0, completionTokens: 1 } };
    });
    const brain = new BudgetedBrain({
      tiers: sampleTiers(),
      brains: new Map<string, Brain>([
        ["free", new FakeBrain(["free"])],
        ["cheap", cheap],
        ["quality", new FakeBrain(["quality"])]
      ]),
      ledger,
      budgetMicros: 10n,
      thresholdMicros: 0n,
      defaultTierName: "cheap",
      clock: () => NOW
    });
    const pending = brain.complete([{ role: "user", content: "hi" }]);
    await vi.waitFor(() => {
      expect(entered).toBe(1);
    });
    expect(brain.publicStatus()).toMatchObject({
      sleeping: false,
      tier: "cheap",
      remainingFraction: "1"
    });
    expect(brain.sleepDraft()).toBeNull();
    release();
    await pending;
    expect(brain.publicStatus()).toMatchObject({
      sleeping: true,
      remainingFraction: "0",
      sleepReason: "balance_below_threshold"
    });
    expect(brain.sleepDraft()).toEqual({
      reason: "balance_below_threshold",
      balance: "0",
      threshold: "0",
      as_of: NOW
    });
    await expect(brain.complete([{ role: "user", content: "again" }])).rejects.toMatchObject({
      budgetReason: "balance_below_threshold"
    });
    expect(cheap.calls).toHaveLength(1);
  });
});
