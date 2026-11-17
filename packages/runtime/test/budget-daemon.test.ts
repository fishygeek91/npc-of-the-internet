/**
 * Treasury-lite through the residency daemon: a spent journal seals `sleep` and
 * holds heartbeats; a new month lets the next heartbeat land. Unknown spend
 * stays off the chain until `wanderer wake` clears the latch.
 */
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { OSP_SPEC_V02, type OspRecord } from "@npc/osp-core";
import { afterEach, describe, expect, it } from "vitest";

import type { BudgetConfig } from "../src/brain/budget-policy.js";
import { FakeBrain } from "../src/brain/fake-brain.js";
import { startResidencyDaemon, type ResidencyDaemonHandle } from "../src/daemon.js";
import { writeWakeRequest } from "../src/residency/control-dir.js";
import { DOOR } from "./helpers/fixed-keys.js";
import { FakeTimer } from "./helpers/fake-timer.js";
import {
  capturingLogger,
  chainShape,
  createSoulDirs,
  multiDoorConfig,
  OffsetClock,
  readVerifiedChain,
  startTestDoor,
  waitFor,
  type TestDoor
} from "./helpers/test-doors.js";

const DOOR_ID = "discord:budget";
const KEYS = { [DOOR_ID]: DOOR.publicKey };
const MONTH_MS = 40 * 24 * 60 * 60 * 1000;

function budgetConfig(budgetMicros: bigint, budgetUsd: string): Omit<BudgetConfig, "ledgerPath"> {
  return {
    tiers: [
      {
        name: "cheap",
        model: "tier-cheap",
        baseUrl: "https://example.com/v1",
        apiKey: "test-key",
        inPricePerMTok: "0",
        outPricePerMTok: "1",
        inPricePerMTokMicros: 0n,
        outPricePerMTokMicros: 1_000_000n
      }
    ],
    budgetMicros,
    budgetUsd,
    thresholdMicros: 0n,
    thresholdUsd: "0",
    period: "monthly",
    defaultTierName: "cheap",
    createLedgerIfMissing: false
  };
}

/**
 * Poll until the chain verifies as `expected`. A live append updates the chain
 * file before `head.json`, so one read can report `forked_head`.
 */
async function awaitChainShape(chainDir: string, expected: readonly string[]): Promise<void> {
  let last = "unread";
  const started = Date.now();
  while (Date.now() - started < 8_000) {
    try {
      const records: OspRecord[] = await readVerifiedChain(chainDir, KEYS);
      const shape = chainShape(records);
      if (shape.join("|") === expected.join("|")) {
        return;
      }
      last = shape.join("|");
    } catch (error) {
      last = error instanceof Error ? error.message : "verify failed";
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 15));
  }
  throw new Error(`chain did not become ${expected.join("|")}; last ${last}`);
}

describe("treasury-lite daemon wiring", () => {
  const doors: TestDoor[] = [];
  const roots: string[] = [];
  let handle: ResidencyDaemonHandle | null = null;

  afterEach(async () => {
    await handle?.shutdown();
    handle = null;
    for (const door of doors.splice(0)) {
      await door.stop();
    }
    for (const root of roots.splice(0)) {
      await rm(root, { recursive: true, force: true });
    }
  });

  async function boot(ledgerLine: string, budget: Omit<BudgetConfig, "ledgerPath">) {
    const clock = new OffsetClock();
    const timer = new FakeTimer();
    const { logger, lines } = capturingLogger();
    const dirs = await createSoulDirs("npc-budget-daemon-");
    roots.push(dirs.root);
    const door = await startTestDoor({
      doorId: DOOR_ID,
      keypair: DOOR,
      clock,
      witness: null
    });
    doors.push(door);
    const ledgerPath = join(dirs.root, "spend.jsonl");
    const stamped = ledgerLine.replaceAll("__TS__", clock.now());
    await writeFile(ledgerPath, `${stamped}\n`, "utf8");
    const inner = new FakeBrain(["should-not-be-called"]);
    handle = await startResidencyDaemon(
      {
        ...multiDoorConfig({
          dirs,
          doors: [door],
          doorPublicKeys: KEYS,
          preferredDoorId: DOOR_ID,
          residency: { maxResidencyMs: 0 }
        }),
        budget: { ...budget, ledgerPath }
      },
      {
        createTierBrain: () => inner,
        timer,
        clock,
        logger,
        skipSignals: true,
        heartbeatIntervalMs: 60_000
      }
    );
    return { clock, timer, lines, dirs, inner };
  }

  it("seals sleep when the balance is spent and withholds heartbeats until the next month", async () => {
    const spent = JSON.stringify({
      kind: "spend",
      ts: "__TS__",
      tier: "cheap",
      model: "tier-cheap",
      tokens_in: 0,
      tokens_out: 1,
      est_cost: "0.00001"
    });
    const { clock, timer, lines, dirs, inner } = await boot(spent, budgetConfig(10n, "0.00001"));
    const slept = await readVerifiedChain(dirs.chainDir, KEYS);
    expect(chainShape(slept)).toEqual([`arrival:${DOOR_ID}:1`, "sleep"]);
    const sleep = slept[2];
    expect(sleep?.spec).toBe(OSP_SPEC_V02);
    if (sleep?.type === "sleep") {
      expect(sleep.body).toMatchObject({
        reason: "balance_below_threshold",
        balance: "0",
        threshold: "0"
      });
      expect(sleep.residency).toBe(`door:${DOOR_ID}/epoch:1`);
      expect(sleep.cosigners).toEqual([]);
    }
    expect(lines.some((line) => line.msg === "budget_sleep_recorded")).toBe(true);

    timer.tick();
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(chainShape(await readVerifiedChain(dirs.chainDir, KEYS))).toEqual([
      `arrival:${DOOR_ID}:1`,
      "sleep"
    ]);
    expect(inner.calls).toHaveLength(0);

    clock.offsetMs += MONTH_MS;
    timer.tick();
    await awaitChainShape(dirs.chainDir, [`arrival:${DOOR_ID}:1`, "sleep", "heartbeat"]);
    expect(inner.calls).toHaveLength(0);
  });

  it("does not publish a balance for unknown spend, and wake lets the next heartbeat land", async () => {
    const unknown = JSON.stringify({
      kind: "unknown_spend",
      ts: "__TS__",
      tier: "cheap",
      model: "tier-cheap"
    });
    const { clock, timer, lines, dirs, inner } = await boot(
      unknown,
      budgetConfig(10_000_000n, "10")
    );
    expect(chainShape(await readVerifiedChain(dirs.chainDir, KEYS))).toEqual([
      `arrival:${DOOR_ID}:1`
    ]);

    timer.tick();
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(chainShape(await readVerifiedChain(dirs.chainDir, KEYS))).toEqual([
      `arrival:${DOOR_ID}:1`
    ]);

    await writeWakeRequest(dirs.controlDir, clock.now());
    timer.tick();
    await waitFor(() => lines.some((line) => line.msg === "budget_wake"), "journal wake");
    timer.tick();
    await awaitChainShape(dirs.chainDir, [`arrival:${DOOR_ID}:1`, "heartbeat"]);
    expect(inner.calls).toHaveLength(0);
  });
});
