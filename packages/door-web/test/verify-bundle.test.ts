import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";

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
      expect(text).not.toContain("eval(");
      expect(zodParsesWithoutFunction(text)).toBe("failed");
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
      expect(text).not.toContain("eval(");
      expect(await shrineParsesWithoutFunction(text)).toBe(0);
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

/**
 * Load the shrine bundle where `Function` throws, then make it parse a record.
 * Schema init or `verifyRecords` calls `new Function` unless `jitless` ran first.
 */
async function shrineParsesWithoutFunction(source: string): Promise<number> {
  let invoked = 0;
  function throwingFunction(): never {
    invoked += 1;
    throw new Error("Function invoked");
  }
  let parsed = false;
  const response = {
    ok: true,
    status: 200,
    headers: { get: (): string | null => null },
    json: (): Promise<unknown> => {
      parsed = true;
      return Promise.resolve({ records: [{}], doorPublicKeys: {}, blobs: {} });
    }
  };
  const element = (): {
    textContent: string;
    children: unknown[];
    setAttribute(): void;
    appendChild(child: unknown): void;
    attachShadow(): ReturnType<typeof element>;
  } => {
    const node = {
      textContent: "",
      children: [] as unknown[],
      setAttribute(): void {
        return;
      },
      appendChild(child: unknown): void {
        node.children.push(child);
      },
      attachShadow(): ReturnType<typeof element> {
        return node;
      }
    };
    return node;
  };
  const sandbox = {
    console,
    TextEncoder,
    TextDecoder,
    URL,
    URLSearchParams,
    crypto: globalThis.crypto,
    fetch: (): Promise<typeof response> => Promise.resolve(response),
    AbortSignal,
    queueMicrotask,
    setTimeout,
    clearTimeout,
    performance,
    atob: (value: string): string => Buffer.from(value, "base64").toString("binary"),
    btoa: (value: string): string => Buffer.from(value, "binary").toString("base64"),
    Function: throwingFunction,
    document: {
      visibilityState: "visible",
      currentScript: {
        dataset: { atlasUrl: "http://127.0.0.1:9", mount: "#wanderer-shrine" }
      },
      querySelector: (): ReturnType<typeof element> => element(),
      createElement: (): ReturnType<typeof element> => element(),
      addEventListener(): void {
        return;
      }
    },
    setInterval: (): number => 1
  };
  const context = createContext(sandbox);
  runInContext(source, context, { timeout: 5_000 });
  const deadline = Date.now() + 1_000;
  while (!parsed && Date.now() < deadline) {
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  if (!parsed) {
    throw new Error("shrine bundle did not read an export");
  }
  await new Promise((resolve) => {
    setTimeout(resolve, 50);
  });
  if (invoked !== 0) {
    throw new Error("zod called Function");
  }
  return invoked;
}
