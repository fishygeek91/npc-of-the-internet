import { describe, expect, it } from "vitest";

import { DaemonError } from "../src/daemon-errors.js";
import { loadResidencyConfig } from "../src/residency/config.js";

function envVarOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(DaemonError);
    return (error as DaemonError).envVar;
  }
  throw new Error("expected DaemonError");
}

describe("loadResidencyConfig", () => {
  it("defaults: daily travel timer on, 10-line memory threshold, operator trigger on", () => {
    const defaults = {
      operatorTrigger: true,
      controlDir: "/tmp/npc-control",
      maxResidencyMs: 86_400_000,
      minMemoryLines: 10,
      journalDir: "/data/published/journals"
    };
    expect(loadResidencyConfig({})).toEqual(defaults);
    // Empty strings (compose `${VAR:-}` passthrough) are "unset".
    expect(
      loadResidencyConfig({
        NPC_RESIDENCY_OPERATOR_TRIGGER: "",
        NPC_RESIDENCY_MAX_MS: "",
        NPC_RESIDENCY_MIN_LINES: "",
        NPC_CONTROL_DIR: "",
        NPC_JOURNAL_DIR: ""
      })
    ).toEqual(defaults);
  });

  it("0 disables the timer and the operator trigger", () => {
    expect(
      loadResidencyConfig({ NPC_RESIDENCY_OPERATOR_TRIGGER: "0", NPC_RESIDENCY_MAX_MS: "0" })
    ).toMatchObject({ operatorTrigger: false, maxResidencyMs: 0 });
    expect(loadResidencyConfig({ NPC_RESIDENCY_OPERATOR_TRIGGER: "false" }).operatorTrigger).toBe(
      false
    );
  });

  it("parses explicit values and paths", () => {
    expect(
      loadResidencyConfig({
        NPC_RESIDENCY_OPERATOR_TRIGGER: "true",
        NPC_RESIDENCY_MAX_MS: "3600000",
        NPC_RESIDENCY_MIN_LINES: "20",
        NPC_CONTROL_DIR: "/run/ctl",
        NPC_JOURNAL_DIR: "/data/j"
      })
    ).toEqual({
      operatorTrigger: true,
      controlDir: "/run/ctl",
      maxResidencyMs: 3_600_000,
      minMemoryLines: 20,
      journalDir: "/data/j"
    });
  });

  it("rejects malformed and too-small values", () => {
    expect(envVarOf(() => loadResidencyConfig({ NPC_RESIDENCY_OPERATOR_TRIGGER: "yes" }))).toBe(
      "NPC_RESIDENCY_OPERATOR_TRIGGER"
    );
    expect(envVarOf(() => loadResidencyConfig({ NPC_RESIDENCY_MAX_MS: "-1" }))).toBe(
      "NPC_RESIDENCY_MAX_MS"
    );
    expect(envVarOf(() => loadResidencyConfig({ NPC_RESIDENCY_MAX_MS: "1h" }))).toBe(
      "NPC_RESIDENCY_MAX_MS"
    );
    expect(envVarOf(() => loadResidencyConfig({ NPC_RESIDENCY_MAX_MS: "60000" }))).toBe(
      "NPC_RESIDENCY_MAX_MS"
    );
    expect(envVarOf(() => loadResidencyConfig({ NPC_RESIDENCY_MIN_LINES: "0" }))).toBe(
      "NPC_RESIDENCY_MIN_LINES"
    );
  });
});
