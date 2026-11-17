import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { buildPorchBundle, buildShrineBundle } from "../scripts/bundle-browser.mjs";

describe("porch verify.js bundle", () => {
  it("matches the committed file and does not reach Node or eval", async () => {
    const dir = await mkdtemp(join(tmpdir(), "verify-bundle-"));
    try {
      const outfile = join(dir, "verify.js");
      const built = await buildPorchBundle(outfile);
      const fresh = await readFile(outfile);
      const committed = await readFile(new URL("../public/verify.js", import.meta.url));
      expect(Buffer.compare(fresh, committed)).toBe(0);
      const text = fresh.toString("utf8");
      expect(built.bytes).toBeGreaterThan(1000);
      expect(built.bytes).toBeLessThan(600_000);
      expect(built.inputs.some((path: string) => path.includes("sha2-browser.js"))).toBe(true);
      expect(built.inputs.some((path: string) => path.includes("node:"))).toBe(false);
      expect(text).not.toContain("node:fs");
      expect(text).not.toContain("node:crypto");
      expect(text).not.toContain("new Function");
      expect(text).not.toContain("eval(");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("matches the committed shrine.js and does not reach Node or eval", async () => {
    const dir = await mkdtemp(join(tmpdir(), "shrine-bundle-"));
    try {
      const outfile = join(dir, "shrine.js");
      const built = await buildShrineBundle(outfile);
      const fresh = await readFile(outfile);
      const committed = await readFile(new URL("../public/shrine.js", import.meta.url));
      expect(Buffer.compare(fresh, committed)).toBe(0);
      const text = fresh.toString("utf8");
      expect(built.bytes).toBeGreaterThan(1000);
      expect(built.bytes).toBeLessThan(600_000);
      expect(built.inputs.some((path: string) => path.includes("sha2-browser.js"))).toBe(true);
      expect(built.inputs.some((path: string) => path.includes("node:"))).toBe(false);
      expect(text).not.toContain("node:fs");
      expect(text).not.toContain("new Function");
      expect(text).not.toContain("eval(");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
