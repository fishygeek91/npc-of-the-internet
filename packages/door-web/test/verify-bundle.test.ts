import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";

import { describe, expect, it } from "vitest";

import { buildPorchBundle } from "../scripts/bundle-browser.mjs";

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
      expect(text).not.toContain("eval(");
      expect(zodParsesWithoutFunction(text)).toBe("failed");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Load the bundle with `Function` throwing. Zod's JIT probe calls `new Function`
 * unless `jitless` was set before the schemas were built, so dropping that import fails here.
 */
function zodParsesWithoutFunction(source: string): string {
  let invoked = 0;
  function throwingFunction(): never {
    invoked += 1;
    throw new Error("Function invoked");
  }
  const sandbox = {
    console,
    TextEncoder,
    TextDecoder,
    URL,
    URLSearchParams,
    crypto: globalThis.crypto,
    fetch: (): Promise<Response> => Promise.reject(new Error("no network")),
    AbortSignal,
    queueMicrotask,
    setTimeout,
    clearTimeout,
    performance,
    atob: (value: string): string => Buffer.from(value, "base64").toString("binary"),
    btoa: (value: string): string => Buffer.from(value, "binary").toString("base64"),
    Function: throwingFunction
  };
  const context = createContext(sandbox);
  runInContext(source, context, { timeout: 5_000 });
  const verdict: unknown = runInContext(
    'globalThis.WandererVerify.verifyText({ phase: "verified", open: null }, { from: "wanderer", text: "hi", proof: { nope: true } })',
    context,
    { timeout: 5_000 }
  );
  if (invoked !== 0) {
    throw new Error("zod called Function");
  }
  if (typeof verdict !== "string") {
    throw new Error("verifyText did not return a verdict");
  }
  return verdict;
}
