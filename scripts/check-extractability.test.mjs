/* global process */
/**
 * Self-test for scripts/check-extractability.mjs.
 * Run: node --test scripts/check-extractability.test.mjs
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const checker = join(dirname(fileURLToPath(import.meta.url)), "check-extractability.mjs");
const npc = 'import { x } from "@npc/runtime";\n';
const bad = "packages/osp-core/src/bad.ts";
const runtime = /@npc\/runtime disallowed @npc import/;

function write(root, rel, contents) {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, contents);
}

function runTree(fill) {
  const root = mkdtempSync(join(tmpdir(), "extract-"));
  const files = {
    "packages/osp-core/package.json": '{"name":"@npc/osp-core","dependencies":{}}\n',
    "packages/osp-cli/package.json":
      '{"name":"@npc/osp-cli","dependencies":{"@npc/osp-core":"workspace:*"}}\n',
    "packages/osp-core/src/ok.ts":
      'export const ok = 1;\nconst note = \'from "@npc/runtime"\';\nconst tmpl = `import { x } from "@npc/runtime"`;\n',
    "packages/osp-core/test/local.test.ts": 'import { ok } from "../src/ok.js";\n',
    "packages/osp-cli/src/ok.ts": 'import { ok } from "@npc/osp-core";\n',
    "spec/note.ts": "export const note = 1;\n"
  };
  try {
    for (const [rel, contents] of Object.entries(files)) write(root, rel, contents);
    fill(root);
    return spawnSync(process.execPath, [checker, root], { encoding: "utf8" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function pass(fill) {
  const result = runTree(fill);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(result.stdout, "");
}

function fail(rel, src, pattern) {
  const result = runTree((root) => write(root, rel, src));
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, pattern);
}

describe("check-extractability", () => {
  it("passes a clean tree, including osp-cli importing @npc/osp-core", () => {
    pass(() => {});
  });

  it("passes comments, division, in-root specifiers, and workspace:*", () => {
    pass((root) => {
      write(
        root,
        "packages/osp-core/src/ok.ts",
        '// import { x } from "@npc/runtime";\n/* import { y } from "@npc/osp-cli"; */\nconst a = b / c;\nconst d = e / f;\n'
      );
      const inside = join(root, "packages/osp-core/src/inside.js");
      write(
        root,
        "packages/osp-core/src/abs.ts",
        `import x from ${JSON.stringify(inside)};\nimport y from ${JSON.stringify(`file://${inside}`)};\nimport z from "file:./inside.js";\n`
      );
      write(
        root,
        "packages/osp-core/package.json",
        '{"name":"@npc/osp-core","dependencies":{"leftpad":"workspace:*"}}\n'
      );
    });
  });

  const cases = [
    [bad, npc, runtime],
    [bad, 'import { x } from "@npc/osp-cli";\n', /@npc\/osp-cli disallowed @npc import/],
    [
      "packages/osp-core/src/escape.ts",
      'import { x } from "../../runtime/src/index.js";\n',
      /escape\.ts:\d+ \.\.\/\.\.\/runtime\/src\/index\.js relative import escapes package root/
    ],
    ["packages/osp-core/test/bad.test.ts", npc, runtime],
    [bad, 'const re = /["]/;\n' + npc, runtime],
    [bad, "const re = /'/;\n" + npc, runtime],
    [bad, "const re = /a\\/*b/;\n" + npc, runtime],
    [bad, "const re = /https?:\\/\\//;\n" + npc, runtime],
    [bad, "const a = b / c;\nconst d = e / f;\n" + npc, runtime],
    ["packages/osp-core/src/bad.jsx", npc, /bad\.jsx:\d+ @npc\/runtime disallowed @npc import/],
    [bad, '/// <reference types="@npc/runtime" />\n', runtime],
    [bad, '/// <reference path="../../runtime/src/index.js" />\n', /escapes package root/],
    [bad, 'declare module "@npc/runtime" {}\n', runtime],
    [bad, 'import x from "/tmp/outside.js";\n', /\/tmp\/outside\.js relative import escapes/],
    [
      bad,
      'import x from "file:///tmp/outside.js";\n',
      /file:\/\/\/tmp\/outside\.js relative import escapes/
    ],
    [bad, 'const s = "unterminated;\n', /unterminated string; cannot verify imports/],
    [bad, "const s = `unterminated;\n", /unterminated template; cannot verify imports/],
    [bad, "const s = 1; /* unterminated\n", /unterminated block comment; cannot verify imports/],
    [bad, "const s = /unterminated\n", /unterminated regex; cannot verify imports/]
  ];

  for (const [rel, src, pattern] of cases) {
    it(`flags ${rel} ${src.split("\n")[0] ?? ""}`, () => {
      fail(rel, src, pattern);
    });
  }

  it("flags optionalDependencies, @npc specs, and file or link paths", () => {
    const result = runTree((root) => {
      write(
        root,
        "packages/osp-core/package.json",
        `${JSON.stringify(
          {
            name: "@npc/osp-core",
            optionalDependencies: { "@npc/runtime": "1.0.0" },
            dependencies: {
              "@npc/atlas": "file:../atlas",
              helper: "file:../runtime",
              alias: "workspace:@npc/door-sdk@*",
              linked: "link:../door-web"
            }
          },
          null,
          2
        )}\n`
      );
    });
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stdout, /@npc\/runtime disallowed package\.json dependency/);
    assert.match(result.stdout, /@npc\/atlas disallowed package\.json dependency/);
    assert.match(result.stdout, /file:\.\.\/runtime disallowed package\.json dependency/);
    assert.match(result.stdout, /@npc\/door-sdk disallowed package\.json dependency/);
    assert.match(result.stdout, /link:\.\.\/door-web disallowed package\.json dependency/);
  });
});
