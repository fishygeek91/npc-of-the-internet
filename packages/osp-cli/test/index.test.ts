import { describe, expect, it } from "vitest";
import { packageName } from "../src/index.js";

describe("@npc/osp-cli", () => {
  it("exports its package name", () => {
    expect(packageName).toBe("@npc/osp-cli");
  });
});
