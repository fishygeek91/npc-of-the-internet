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
  it("defaults every automatic behavior off", () => {
    expect(loadResidencyConfig({})).toEqual({
      operatorTrigger: false,
      controlDir: "/tmp/npc-control",
      maxResidencyMs: 0,
      timerMinTranscriptLines: 10,
      journalDir: "/data/published/journals",
      commitIntervalMs: 0,
      quarantineWindowMs: 86_400_000
    });
    // Empty strings (compose `${VAR:-}` passthrough) are "unset".
    expect(
      loadResidencyConfig({
        NPC_RESIDENCY_OPERATOR_TRIGGER: "",
        NPC_RESIDENCY_MAX_MS: "",
        NPC_QUARANTINE_COMMIT_INTERVAL_MS: "",
        NPC_CONTROL_DIR: "",
        NPC_JOURNAL_DIR: ""
      })
    ).toMatchObject({ operatorTrigger: false, maxResidencyMs: 0, commitIntervalMs: 0 });
    expect(
      loadResidencyConfig({ NPC_RESIDENCY_OPERATOR_TRIGGER: "0", NPC_RESIDENCY_MAX_MS: "0" })
    ).toMatchObject({ operatorTrigger: false, maxResidencyMs: 0 });
  });

  it("parses enabled triggers and paths", () => {
    expect(
      loadResidencyConfig({
        NPC_RESIDENCY_OPERATOR_TRIGGER: "true",
        NPC_RESIDENCY_MAX_MS: "86400000",
        NPC_RESIDENCY_MIN_LINES: "20",
        NPC_CONTROL_DIR: "/run/ctl",
        NPC_JOURNAL_DIR: "/data/j",
        NPC_QUARANTINE_COMMIT_INTERVAL_MS: "60000",
        NPC_QUARANTINE_WINDOW_MS: "600000"
      })
    ).toEqual({
      operatorTrigger: true,
      controlDir: "/run/ctl",
      maxResidencyMs: 86_400_000,
      timerMinTranscriptLines: 20,
      journalDir: "/data/j",
      commitIntervalMs: 60_000,
      quarantineWindowMs: 600_000
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
    expect(envVarOf(() => loadResidencyConfig({ NPC_QUARANTINE_COMMIT_INTERVAL_MS: "500" }))).toBe(
      "NPC_QUARANTINE_COMMIT_INTERVAL_MS"
    );
    expect(envVarOf(() => loadResidencyConfig({ NPC_QUARANTINE_WINDOW_MS: "0" }))).toBe(
      "NPC_QUARANTINE_WINDOW_MS"
    );
  });

  it("accepts the default 24 h window with the commit sweep (the ≤ 1 h legacy-Door limit is checked against hello at boot)", () => {
    const config = loadResidencyConfig({ NPC_QUARANTINE_COMMIT_INTERVAL_MS: "60000" });
    expect(config.commitIntervalMs).toBe(60_000);
    expect(config.quarantineWindowMs).toBe(86_400_000);
    // Without the sweep the default 24 h window is fine too.
    expect(loadResidencyConfig({ NPC_QUARANTINE_WINDOW_MS: "86400000" }).quarantineWindowMs).toBe(
      86_400_000
    );
    // Non-positive windows are still refused.
    expect(
      envVarOf(() =>
        loadResidencyConfig({
          NPC_QUARANTINE_COMMIT_INTERVAL_MS: "60000",
          NPC_QUARANTINE_WINDOW_MS: "0"
        })
      )
    ).toBe("NPC_QUARANTINE_WINDOW_MS");
  });
});
