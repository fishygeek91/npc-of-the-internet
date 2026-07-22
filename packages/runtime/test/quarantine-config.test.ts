import { describe, expect, it } from "vitest";

import { loadQuarantineConfig } from "../src/quarantine/config.js";
import { QuarantineError } from "../src/quarantine/errors.js";

describe("loadQuarantineConfig", () => {
  it("loads the default 24-hour window when env is omitted", () => {
    const config = loadQuarantineConfig({});
    expect(config).toEqual({ quarantineWindowMs: 86_400_000 });
  });

  it("parses NPC_QUARANTINE_WINDOW_MS override", () => {
    const config = loadQuarantineConfig({ NPC_QUARANTINE_WINDOW_MS: "3600000" });
    expect(config.quarantineWindowMs).toBe(3_600_000);
  });

  it("throws QuarantineError for non-positive values", () => {
    expect(() => loadQuarantineConfig({ NPC_QUARANTINE_WINDOW_MS: "0" })).toThrow(QuarantineError);
    expect(() => loadQuarantineConfig({ NPC_QUARANTINE_WINDOW_MS: "-1" })).toThrow(QuarantineError);
    expect(() => loadQuarantineConfig({ NPC_QUARANTINE_WINDOW_MS: "abc" })).toThrow(
      QuarantineError
    );
  });

  it("sets reason invalid_config on parse failure", () => {
    let caught: unknown;
    try {
      loadQuarantineConfig({ NPC_QUARANTINE_WINDOW_MS: "nope" });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(QuarantineError);
    if (!(caught instanceof QuarantineError)) {
      throw new Error("expected QuarantineError");
    }
    expect(caught.reason).toBe("invalid_config");
  });
});
