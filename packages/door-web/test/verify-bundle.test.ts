import { describe, expect, it } from "vitest";

import { buildPorchBundle, buildShrineBundle } from "../scripts/bundle-browser.mjs";

describe("porch verify.js bundle", () => {
  it("minifies the browser entry and does not reach Node built-ins", async () => {
    const built = await buildPorchBundle();
    expect(built.bytes).toBeGreaterThan(1000);
    expect(built.bytes).toBeLessThan(600_000);
    expect(built.inputs.some((path: string) => path.includes("sha2-browser.js"))).toBe(true);
    expect(built.inputs.some((path: string) => path.includes("node:"))).toBe(false);
  });

  it("minifies shrine.js the same way and does not reach Node built-ins", async () => {
    const built = await buildShrineBundle();
    expect(built.bytes).toBeGreaterThan(1000);
    expect(built.bytes).toBeLessThan(600_000);
    expect(built.inputs.some((path: string) => path.includes("sha2-browser.js"))).toBe(true);
    expect(built.inputs.some((path: string) => path.includes("node:"))).toBe(false);
    expect(built.inputs.some((path: string) => path.includes("blockstore-fs"))).toBe(false);
  });
});
