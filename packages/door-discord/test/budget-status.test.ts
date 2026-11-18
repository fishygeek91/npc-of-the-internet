import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadDoorBudgetStatus } from "../src/budget-status.js";
import { formatStatusReply } from "../src/status.js";
import { startDiscordDoor } from "../src/start.js";
import { FakeGateway } from "./helpers/fake-gateway.js";
import {
  OPERATOR_ID,
  cleanupTempDirs as cleanupHarnessDirs,
  testConfig
} from "./helpers/harness.js";
import { MutableClock } from "./helpers/mutable-clock.js";

const presence = {
  present: false,
  doorId: "discord:10001",
  epoch: null,
  sessionLive: false,
  witnessesMemories: false
};

describe("loadDoorBudgetStatus", () => {
  let dir = "";

  afterEach(async () => {
    await cleanupHarnessDirs();
    if (dir !== "") {
      await rm(dir, { recursive: true, force: true });
      dir = "";
    }
  });

  async function filePath(): Promise<string> {
    dir = await mkdtemp(join(tmpdir(), "door-budget-"));
    return join(dir, "status.json");
  }

  it("shows fraction, tier, and sleeping, and refuses a balance or a dollar string", async () => {
    const path = await filePath();
    const secret = "sk-ant-status-secret";
    await writeFile(
      path,
      `${JSON.stringify({
        configured: true,
        sleeping: true,
        tier: null,
        remainingFraction: null
      })}\n`
    );
    const unknown = loadDoorBudgetStatus(path);
    const unknownReply = formatStatusReply({ ...presence, budget: unknown });
    expect(unknownReply).toContain("sleeping: yes");
    expect(unknownReply).toContain("tier: none");
    expect(unknownReply).toContain("remaining_fraction: unknown");
    expect(unknownReply).not.toContain("balance");
    expect(unknownReply).not.toContain("$");

    await writeFile(
      path,
      `${JSON.stringify({
        configured: true,
        sleeping: false,
        tier: "cheap",
        remainingFraction: "0.5"
      })}\n`
    );
    const awake = formatStatusReply({ ...presence, budget: loadDoorBudgetStatus(path) });
    expect(awake).toContain("sleeping: no");
    expect(awake).toContain("tier: cheap");
    expect(awake).toContain("remaining_fraction: 0.5");

    await writeFile(
      path,
      `${JSON.stringify({
        configured: true,
        sleeping: false,
        tier: "cheap",
        remainingFraction: "0.5",
        balance: secret
      })}\n`
    );
    const poisoned = loadDoorBudgetStatus(path);
    expect(poisoned).toEqual({ state: "unavailable", reason: "invalid" });
    const poisonedReply = formatStatusReply({ ...presence, budget: poisoned });
    expect(poisonedReply).toContain("budget: unavailable");
    expect(poisonedReply).not.toContain(secret);
    expect(poisonedReply).not.toContain("0.5");

    await writeFile(
      path,
      `${JSON.stringify({
        configured: true,
        sleeping: false,
        tier: "cheap",
        remainingFraction: "9.99"
      })}\n`
    );
    const dollars = formatStatusReply({ ...presence, budget: loadDoorBudgetStatus(path) });
    expect(dollars).toContain("budget: unavailable");
    expect(dollars).not.toContain("9.99");

    expect(loadDoorBudgetStatus(undefined)).toEqual({ state: "not_configured" });
    expect(formatStatusReply({ ...presence, budget: { state: "not_configured" } })).toContain(
      "budget: not configured"
    );
  });

  it("replies from the snapshot file on /wanderer status", async () => {
    const path = await filePath();
    await writeFile(
      path,
      `${JSON.stringify({
        configured: true,
        sleeping: true,
        tier: null,
        remainingFraction: null
      })}\n`
    );
    const gateway = new FakeGateway();
    const handle = await startDiscordDoor({
      config: await testConfig({ budgetStatusPath: path }),
      gateway,
      clock: new MutableClock(0),
      disableServers: true
    });
    try {
      await gateway.emitCommand({
        kind: "status",
        interactionId: "ix-budget",
        userId: OPERATOR_ID,
        ephemeral: true
      });
      const reply = gateway.ephemerals[0]?.content ?? "";
      expect(reply).toContain("presence: absent");
      expect(reply).toContain("sleeping: yes");
      expect(reply).toContain("tier: none");
      expect(reply).toContain("remaining_fraction: unknown");
      expect(reply).not.toContain("balance");
    } finally {
      await handle.stop();
    }
  });
});
