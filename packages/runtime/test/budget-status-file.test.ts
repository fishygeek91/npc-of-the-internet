import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  budgetStatusBody,
  createBudgetStatusPublisher,
  writeBudgetStatusFile,
  type BudgetStatusFile
} from "../src/brain/budget-status-file.js";
import { BrainError } from "../src/brain/errors.js";

describe("budget status file", () => {
  let dir = "";

  afterEach(async () => {
    if (dir !== "") {
      await rm(dir, { recursive: true, force: true });
      dir = "";
    }
  });

  async function statusPath(): Promise<string> {
    dir = await mkdtemp(join(tmpdir(), "npc-budget-status-"));
    return join(dir, "status.json");
  }

  it("writes sleeping, tier, and fraction, and drops everything else", async () => {
    const filePath = await statusPath();
    const body = budgetStatusBody({
      sleeping: true,
      tier: null,
      remainingFraction: null,
      periodStart: "2026-11-01T00:00:00.000Z",
      sleepReason: "ledger_unknown"
    });
    expect(body).toEqual({
      configured: true,
      sleeping: true,
      tier: null,
      remainingFraction: null
    });
    await writeBudgetStatusFile(filePath, body);
    const raw = await readFile(filePath, "utf8");
    expect(JSON.parse(raw)).toEqual(body);
    expect(raw).not.toContain("balance");
    expect(raw).not.toContain("ledger_unknown");
    expect(raw).not.toContain("periodStart");
    expect(budgetStatusBody(undefined)).toEqual({ configured: false });
  });

  it("refuses a dollar-like fraction or an extra balance key and does not echo them", async () => {
    const filePath = await statusPath();
    const secret = "sk-ant-status-secret";
    const badFraction: BudgetStatusFile = {
      configured: true,
      sleeping: false,
      tier: "cheap",
      remainingFraction: "9.99"
    };
    const errors: string[] = [];
    const publisher = createBudgetStatusPublisher(filePath, (message) => {
      errors.push(message);
    });
    publisher.publish(badFraction);
    const sneaky = {
      configured: true,
      sleeping: true,
      tier: null,
      remainingFraction: null,
      balance: secret
    };
    publisher.publish(sneaky);
    await vi.waitFor(() => {
      expect(errors).toHaveLength(2);
    });
    expect(errors.join("\n")).not.toContain("9.99");
    expect(errors.join("\n")).not.toContain(secret);
    await expect(readFile(filePath, "utf8")).rejects.toThrow(/ENOENT/);
  });

  it("rejects a relative path without echoing a planted secret", async () => {
    const secret = "sk-ant-path-secret";
    try {
      await writeBudgetStatusFile(`${secret}/status.json`, { configured: false });
      expect.unreachable();
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(BrainError);
      if (error instanceof BrainError) {
        expect(error.message).not.toContain(secret);
        expect(error.envVar).toBe("NPC_BUDGET_STATUS_PATH");
      }
    }
  });
});
