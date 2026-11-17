/* global process */
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * esbuild is not a declared door-web dependency. Resolve the copy vitest
 * already pulls in (vitest → vite → esbuild). See DEVIATIONS.md and #222.
 * @returns {string} absolute path to esbuild's main module
 */
export function resolveEsbuildMain() {
  const require = createRequire(import.meta.url);
  let vitestPkg;
  try {
    vitestPkg = require.resolve("vitest/package.json");
  } catch {
    throw new Error("vitest is not installed; run pnpm install before bundling verify.js");
  }
  const fromVitest = createRequire(vitestPkg);
  const vitePkg = fromVitest.resolve("vite/package.json");
  const fromVite = createRequire(vitePkg);
  return fromVite.resolve("esbuild/lib/main.js");
}

/**
 * Bundle the porch verifier for the browser. Minified IIFE, browser condition
 * so multiformats uses sha2-browser.js.
 * @returns {Promise<{ outfile: string, bytes: number, inputs: string[] }>}
 */
export async function buildPorchBundle(outfile = join(packageRoot, "public", "verify.js")) {
  const require = createRequire(import.meta.url);
  const esbuild = require(resolveEsbuildMain());
  const result = await esbuild.build({
    absWorkingDir: packageRoot,
    entryPoints: [join(packageRoot, "src", "browser", "porch-entry.ts")],
    bundle: true,
    format: "iife",
    platform: "browser",
    conditions: ["browser", "import", "default"],
    target: ["es2023"],
    minify: true,
    legalComments: "none",
    outfile,
    metafile: true,
    logLevel: "silent"
  });
  const inputs = Object.keys(result.metafile.inputs);
  const source = readFileSync(outfile, "utf8").replace(/\n/g, "");
  writeFileSync(outfile, `${source}\n`);
  assertPorchBundle(inputs, source);
  return { outfile, bytes: statSync(outfile).size, inputs };
}

/**
 * Fail when the bundle can see Node. `sha2-browser.js` must be an input.
 * @param {readonly string[]} inputs
 * @param {string} source
 */
export function assertPorchBundle(inputs, source) {
  if (!inputs.some((path) => path.includes("sha2-browser.js"))) {
    throw new Error("porch bundle did not use the browser sha2-256 hasher");
  }
  for (const path of inputs) {
    const nodeSha2 =
      path.includes("multiformats") && (path.endsWith("/sha2.js") || path.endsWith("\\sha2.js"));
    if (
      path.includes("node:") ||
      path.includes("blockstore-fs") ||
      path.includes("/store/") ||
      path.includes("\\store\\") ||
      nodeSha2
    ) {
      throw new Error(`porch bundle reached a Node module: ${path}`);
    }
  }
  if (
    source.includes("node:fs") ||
    source.includes("node:crypto") ||
    source.includes("blockstore-fs")
  ) {
    throw new Error("porch bundle text contains a Node builtin");
  }
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const built = await buildPorchBundle();
  process.stdout.write(`verify.js ${String(built.bytes)} bytes\n`);
}
