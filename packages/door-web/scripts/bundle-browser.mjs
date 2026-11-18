/* global process */
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Bundle one classic-script entry. Minified IIFE, browser condition so
 * multiformats uses sha2-browser.js. The outfile is a single line.
 * esbuild is a direct devDependency of this package.
 * @param {string} entry file name under src/browser
 * @param {string} fileName file name under public
 * @param {string} [outfile] absolute path; defaults to public/<fileName>
 * @returns {Promise<{ outfile: string, bytes: number, inputs: string[] }>}
 */
export async function buildBrowserBundle(
  entry,
  fileName,
  outfile = join(packageRoot, "public", fileName)
) {
  const result = await esbuild.build({
    absWorkingDir: packageRoot,
    entryPoints: [join(packageRoot, "src", "browser", entry)],
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

/** Bundle the porch verifier. Pass `outfile` to avoid rewriting `public/verify.js`. */
export async function buildPorchBundle(outfile) {
  return buildBrowserBundle("porch-entry.ts", "verify.js", outfile);
}

/** Bundle the replica shrine. Pass `outfile` to avoid rewriting `public/shrine.js`. */
export async function buildShrineBundle(outfile) {
  return buildBrowserBundle("shrine-entry.ts", "shrine.js", outfile);
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
  const porch = await buildPorchBundle();
  const shrine = await buildShrineBundle();
  process.stdout.write(`verify.js ${String(porch.bytes)} bytes\n`);
  process.stdout.write(`shrine.js ${String(shrine.bytes)} bytes\n`);
}
