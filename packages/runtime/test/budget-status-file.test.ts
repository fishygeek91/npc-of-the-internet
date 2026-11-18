import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  budgetStatusBody,
  createBudgetStatusPublisher,
  writeBudgetStatusFile,
  type BudgetStatusFile,
  type BudgetStatusPublishFailure
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
    const errors: BudgetStatusPublishFailure[] = [];
    const publisher = createBudgetStatusPublisher(filePath, (failure) => {
      errors.push(failure);
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
    expect(errors).toEqual([
      { envVar: "NPC_BUDGET_STATUS_PATH", code: "invalid_config" },
      { envVar: "NPC_BUDGET_STATUS_PATH", code: "invalid_config" }
    ]);
    const logged = JSON.stringify(errors);
    expect(logged).not.toContain("9.99");
    expect(logged).not.toContain(secret);
    expect(logged).not.toContain(filePath);
    await expect(readFile(filePath, "utf8")).rejects.toThrow(/ENOENT/);
  });

  it("reports a filesystem failure as the env var and an error code, without the path", async () => {
    dir = await mkdtemp(join(tmpdir(), "npc-budget-status-"));
    const nested = join(dir, "nested");
    await mkdir(nested, { mode: 0o500 });
    const filePath = join(nested, "status.json");
    const failures: BudgetStatusPublishFailure[] = [];
    try {
      const publisher = createBudgetStatusPublisher(filePath, (failure) => {
        failures.push(failure);
      });
      publisher.publish({ configured: false });
      await vi.waitFor(() => {
        expect(failures).toHaveLength(1);
      });
      expect(failures).toEqual([{ envVar: "NPC_BUDGET_STATUS_PATH", code: "EACCES" }]);
      expect(JSON.stringify(failures)).not.toContain(filePath);
      expect(JSON.stringify(failures)).not.toContain(nested);
      expect(await readdir(nested)).toEqual([]);
    } finally {
      await chmod(nested, 0o700);
    }
  });

  it("unlinks the temp file when writeFile fails after creating it", async () => {
    const filePath = await statusPath();
    let temp = "";
    const error = new Error("simulated short write");
    Object.assign(error, { code: "ENOSPC" });
    await expect(
      writeBudgetStatusFile(
        filePath,
        { configured: false },
        {
          mkdir: async (directory, options) => {
            await mkdir(directory, options);
          },
          rename,
          unlink,
          writeFile: async (target) => {
            temp = target;
            await writeFile(target, "partial", { encoding: "utf8", mode: 0o600 });
            throw error;
          }
        }
      )
    ).rejects.toBe(error);
    expect(temp.endsWith(`.${String(process.pid)}.tmp`)).toBe(true);
    await expect(readFile(temp, "utf8")).rejects.toThrow(/ENOENT/);
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
