/* global process */
/**
 * Self-test for scripts/check-extractability.mjs.
 * Run: node --test scripts/check-extractability.test.mjs
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const checker = join(dirname(fileURLToPath(import.meta.url)), "check-extractability.mjs");

/**
 * @param {string} root
 * @param {string} rel
 * @param {string} contents
 */
function write(root, rel, contents) {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, contents);
}

/**
 * @param {string} root
 */
function writeClean(root) {
  write(
    root,
    "packages/osp-core/package.json",
    `${JSON.stringify({ name: "@npc/osp-core", private: true, dependencies: {} }, null, 2)}\n`
  );
  write(
    root,
    "packages/osp-cli/package.json",
    `${JSON.stringify(
      {
        name: "@npc/osp-cli",
        private: true,
        dependencies: { "@npc/osp-core": "workspace:*" }
      },
      null,
      2
    )}\n`
  );
  write(
    root,
    "packages/osp-core/src/ok.ts",
    'export const ok = 1;\nconst note = \'from "@npc/runtime"\';\nconst tmpl = `import { x } from "@npc/runtime"`;\n'
  );
  write(
    root,
    "packages/osp-core/test/local.test.ts",
    'import { ok } from "../src/ok.js";\nexport const value = ok;\n'
  );
  write(
    root,
    "packages/osp-cli/src/ok.ts",
    'import { ok } from "@npc/osp-core";\nexport const value = ok;\n'
  );
  write(root, "spec/note.ts", "export const note = 1;\n");
}

/**
 * @param {(root: string) => void} fill
 */
function runTree(fill) {
  const root = mkdtempSync(join(tmpdir(), "extract-"));
  try {
    writeClean(root);
    fill(root);
    return spawnSync(process.execPath, [checker, root], { encoding: "utf8" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * @param {import("node:child_process").SpawnSyncReturns<string>} result
 */
function assertPass(result) {
  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.equal(result.stdout, "");
}

/**
 * @param {import("node:child_process").SpawnSyncReturns<string>} result
 * @param {RegExp} pattern
 */
function assertFail(result, pattern) {
  assert.equal(result.status, 1, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.equal(
    pattern.test(result.stdout),
    true,
    `expected ${String(pattern)}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
  );
}

describe("check-extractability", () => {
  it("passes a clean tree, including osp-cli importing @npc/osp-core", () => {
    assertPass(runTree(() => {}));
  });

  it("fails when osp-core imports @npc/runtime", () => {
    const result = runTree((root) => {
      write(root, "packages/osp-core/src/bad.ts", 'import { x } from "@npc/runtime";\n');
    });
    assertFail(result, /packages\/osp-core\/src\/bad\.ts:\d+ @npc\/runtime disallowed @npc import/);
  });

  it("fails when osp-core imports @npc/osp-cli", () => {
    const result = runTree((root) => {
      write(root, "packages/osp-core/src/bad.ts", 'import { x } from "@npc/osp-cli";\n');
    });
    assertFail(result, /packages\/osp-core\/src\/bad\.ts:\d+ @npc\/osp-cli disallowed @npc import/);
  });

  it("fails when a relative import escapes the package root", () => {
    const result = runTree((root) => {
      write(
        root,
        "packages/osp-core/src/escape.ts",
        'import { x } from "../../runtime/src/index.js";\n'
      );
    });
    assertFail(
      result,
      /packages\/osp-core\/src\/escape\.ts:\d+ \.\.\/\.\.\/runtime\/src\/index\.js relative import escapes package root/
    );
  });

  it("passes a commented-out import", () => {
    const result = runTree((root) => {
      write(
        root,
        "packages/osp-core/src/ok.ts",
        '// import { x } from "@npc/runtime";\n/* import { y } from "@npc/osp-cli"; */\nexport const ok = 1;\n'
      );
    });
    assertPass(result);
  });

  it("fails when package.json declares a disallowed workspace dependency", () => {
    const result = runTree((root) => {
      write(
        root,
        "packages/osp-core/package.json",
        `${JSON.stringify(
          { name: "@npc/osp-core", dependencies: { "@npc/runtime": "workspace:*" } },
          null,
          2
        )}\n`
      );
    });
    assertFail(
      result,
      /packages\/osp-core\/package\.json:\d+ @npc\/runtime disallowed package\.json dependency/
    );
  });

  it("fails when a test file imports a disallowed package", () => {
    const result = runTree((root) => {
      write(root, "packages/osp-core/test/bad.test.ts", 'import { x } from "@npc/runtime";\n');
    });
    assertFail(
      result,
      /packages\/osp-core\/test\/bad\.test\.ts:\d+ @npc\/runtime disallowed @npc import/
    );
  });
});
