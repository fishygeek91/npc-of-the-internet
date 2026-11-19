/**
 * Tools that do not set the `import` condition read `default`.
 * `./package.json` must be exported or Node throws ERR_PACKAGE_PATH_NOT_EXPORTED.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

/** True for a plain JSON object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Condition name → target path. Rejects nested export objects. */
function exportConditions(target: unknown, label: string): Record<string, string> {
  if (!isRecord(target)) {
    throw new Error(`${label} export must be an object of string paths`);
  }
  const conditions: Record<string, string> = {};
  for (const [key, value] of Object.entries(target)) {
    if (typeof value !== "string") {
      throw new Error(`${label} condition ${key} must be a string path`);
    }
    conditions[key] = value;
  }
  return conditions;
}

describe("@npc/osp-core package exports", () => {
  it("gives the root a default condition and exports ./package.json", () => {
    const manifestPath = require.resolve("@npc/osp-core/package.json");
    const parsed: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (!isRecord(parsed) || !isRecord(parsed.exports)) {
      throw new Error("package.json exports must be an object");
    }
    expect(parsed.name).toBe("@npc/osp-core");
    expect(parsed.exports["./package.json"]).toBe("./package.json");

    const root = exportConditions(parsed.exports["."], ".");
    expect(Object.keys(root)).toEqual(["types", "import", "default"]);
    expect(root.types).toBe("./dist/index.d.ts");
    expect(root.import).toBe("./dist/index.js");
    expect(root.default).toBe("./dist/index.js");

    const browser = exportConditions(parsed.exports["./browser"], "./browser");
    expect(Object.keys(browser)).toEqual(["types", "browser", "import", "default"]);
    expect(browser.browser).toBe("./dist/browser.js");
    expect(browser.import).toBe("./dist/browser.js");
    expect(browser.default).toBe("./dist/browser.js");
  });
});
