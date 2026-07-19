import { describe, expect, it } from "vitest";
import { packageName } from "../src/index.js";

describe("@npc/door-discord", () => {
  it("exports its package name", () => {
    expect(packageName).toBe("@npc/door-discord");
  });
});
