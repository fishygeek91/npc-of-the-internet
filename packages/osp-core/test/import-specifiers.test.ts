/**
 * The static walker must see the same specifiers the bundle can execute,
 * including a template literal with no substitutions.
 */
import { describe, expect, it } from "vitest";

import { runtimeSpecifiers } from "./helpers/import-specifiers.js";

describe("runtime import walker", () => {
  it("sees string imports, re-exports, and require", () => {
    const source = [
      'import { readFileSync } from "node:fs";',
      'import "node:os";',
      'export { join } from "node:path";',
      'const crypto = require("node:crypto");',
      'export const load = () => import("node:module");'
    ].join("\n");
    expect(runtimeSpecifiers("sample.ts", source)).toEqual([
      "node:fs",
      "node:os",
      "node:path",
      "node:crypto",
      "node:module"
    ]);
  });

  it("sees import() and require() of a template literal with no substitutions", () => {
    const source = [
      "const fs = require(`node:fs`);",
      "export const load = () => import(`node:fs/promises`);"
    ].join("\n");
    expect(runtimeSpecifiers("sample.ts", source)).toEqual(["node:fs", "node:fs/promises"]);
  });

  it("ignores type-only imports and does not treat an interpolated template as static", () => {
    const source = [
      'import type { PathLike } from "node:fs";',
      'import { type PathLike as Path, readFileSync } from "node:fs";',
      'export type { PathLike } from "node:fs";',
      'const name = "fs";',
      "export const load = () => import(`node:${name}`);"
    ].join("\n");
    expect(runtimeSpecifiers("sample.ts", source)).toEqual(["node:fs"]);
  });
});
