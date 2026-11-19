/**
 * Proves `@npc/osp-core/browser` under `--conditions=browser`.
 *
 * Static import graph (type-only imports erased) must not reach a Node
 * built-in, SoulStore, CAR, manifests, or replication. The package root is
 * the negative control: it must reach `node:fs`, or the walker is blind.
 * Then `verifyRecords` runs every `spec/osp/vectors/` file while a resolve
 * hook rejects Node built-ins. sha2-256 is `multiformats` `sha2-browser.js`.
 * `BROWSER_OK` reports `hook=on` when `module.registerHooks` installed that
 * guard (Node 22.15+) and `hook=off` when the runtime guard is absent.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import * as nodeModule from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { ChainRule, VerifyChainResult } from "../src/browser.js";
import { exactFailureRules, sameChainRules } from "./exact-failure-rules.js";
import { runtimeSpecifiers } from "./helpers/import-specifiers.js";
import { collectBodyContentHashes, parseVectorFile } from "./helpers/vectors.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(here, "../src");
const vectorsDir = path.resolve(here, "../../../spec/osp/vectors");

const REQUIRED_VECTORS: Readonly<Record<string, "valid" | ChainRule>> = {
  "valid-mini-chain.json": "valid",
  "bad-soul-sig.json": "bad_soul_sig",
  "bad-soul-sig-small-order-key.json": "bad_soul_sig",
  "broken-prev-link.json": "broken_prev_link",
  "bad-session-continuity.json": "bad_session_continuity"
};

const FORBIDDEN_DIRS = ["store", "car", "manifest", "replication"];

type BuiltinHit = { specifier: string; from: string };
type Graph = { files: string[]; builtins: BuiltinHit[] };

/**
 * True when a resolve-hook parent URL is part of the browser verification graph.
 * Builtins loaded from this runner, or from Node itself, stay allowed.
 */
function parentInBrowserGraph(parent: string | undefined): boolean {
  if (parent === undefined || parent.length === 0) {
    return false;
  }
  return (
    parent.includes("/packages/osp-core/src/") ||
    parent.includes("/node_modules/@noble/") ||
    parent.includes("/node_modules/multiformats/") ||
    parent.includes("/node_modules/zod/")
  );
}

/**
 * Install a resolve hook that rejects Node built-ins loaded from the browser graph.
 *
 * @returns Whether `module.registerHooks` exists (Node 22.15+). Older 22.x
 *   installs nothing; the static walk is the only guard, reported as `hook=off`.
 */
function installBuiltinGuard(): boolean {
  const registerHooks: unknown = Reflect.get(nodeModule, "registerHooks");
  if (typeof registerHooks !== "function") {
    return false;
  }
  const hooks = {
    resolve(
      specifier: string,
      context: { parentURL?: string },
      nextResolve: (specifier: string, context: { parentURL?: string }) => { url: string }
    ): { url: string } {
      const parent = context.parentURL;
      if (parentInBrowserGraph(parent) && nodeModule.isBuiltin(specifier)) {
        throw new Error(`browser graph imported Node builtin "${specifier}" from ${parent ?? ""}`);
      }
      return nextResolve(specifier, context);
    }
  };
  registerHooks(hooks);
  return true;
}

const builtinGuardActive = installBuiltinGuard();

/** `.js` specifiers in `src/` are `.ts` on disk. Dependencies are real `.js`. */
function resolveRelative(specifier: string, parentFile: string): string {
  const joined = path.resolve(path.dirname(parentFile), specifier);
  const candidates = [joined];
  if (joined.endsWith(".js")) {
    candidates.push(`${joined.slice(0, -3)}.ts`);
  }
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return candidate;
    }
  }
  throw new Error(`unresolved "${specifier}" from ${parentFile}`);
}

/**
 * Resolve a non-relative specifier from `parentFile`.
 * Throws when the resolved URL is a `node:` built-in. The walk records those
 * specifiers itself and does not call this function for them.
 */
function resolveSpecifier(specifier: string, parentFile: string): string {
  if (specifier.startsWith(".")) {
    return resolveRelative(specifier, parentFile);
  }
  const resolved = import.meta.resolve(specifier, pathToFileURL(parentFile).href);
  if (resolved.startsWith("node:")) {
    throw new Error(`resolved Node builtin ${resolved} from ${parentFile}`);
  }
  return fileURLToPath(resolved);
}

/**
 * `followPackages` is false for the package-root control so nested store
 * dependencies are not required to see `node:fs` in `src/store/`.
 */
function walk(entryFile: string, followPackages: boolean): Graph {
  const files: string[] = [];
  const builtins: BuiltinHit[] = [];
  const seen = new Set<string>();
  const queue = [entryFile];
  while (queue.length > 0) {
    const next = queue.shift();
    if (next === undefined) {
      break;
    }
    const file = realpathSync(next);
    if (seen.has(file)) {
      continue;
    }
    seen.add(file);
    files.push(file);
    for (const specifier of runtimeSpecifiers(file, readFileSync(file, "utf8"))) {
      if (nodeModule.isBuiltin(specifier)) {
        builtins.push({ specifier, from: file });
        continue;
      }
      if (specifier.startsWith(".") || followPackages) {
        queue.push(resolveSpecifier(specifier, file));
      }
    }
  }
  return { files, builtins };
}

/**
 * Fail unless the browser graph is free of Node built-ins, stores, and Node sha2,
 * and it resolved `sha2-browser.js` plus `@noble/ed25519`.
 */
function assertBrowserGraph(graph: Graph): void {
  if (graph.builtins.length > 0) {
    const lines = graph.builtins
      .slice(0, 8)
      .map((hit) => `${hit.specifier} from ${hit.from}`)
      .join("\n");
    throw new Error(`browser graph reached Node built-ins:\n${lines}`);
  }
  for (const file of graph.files) {
    for (const dir of FORBIDDEN_DIRS) {
      const marker = `${path.sep}src${path.sep}${dir}${path.sep}`;
      if (file.includes(`${path.sep}osp-core${marker}`)) {
        throw new Error(`browser graph reached ${dir}: ${file}`);
      }
    }
    if (
      file.includes(`${path.sep}multiformats${path.sep}`) &&
      file.endsWith(`${path.sep}hashes${path.sep}sha2.js`)
    ) {
      throw new Error(`browser graph resolved Node sha2: ${file}`);
    }
    if (file.includes(`${path.sep}blockstore-fs${path.sep}`)) {
      throw new Error(`browser graph reached blockstore-fs: ${file}`);
    }
  }
  if (!graph.files.some((file) => file.endsWith(`${path.sep}sha2-browser.js`))) {
    throw new Error("browser graph did not resolve sha2-browser.js");
  }
  if (
    !graph.files.some((file) => file.includes(`${path.sep}@noble${path.sep}ed25519${path.sep}`))
  ) {
    throw new Error("browser graph did not include @noble/ed25519");
  }
}

/** True when the package-root control reached `node:fs` (the walker is not blind). */
function foundNodeFs(graph: Graph): boolean {
  return graph.builtins.some(
    (hit) =>
      hit.specifier === "node:fs" || hit.specifier === "fs" || hit.specifier.startsWith("node:fs/")
  );
}

type ReportedCase = {
  file: string;
  pairs: { rule: ChainRule; seq: number }[];
};

/** Rule/seq pairs from one verifyRecords result. Valid chains report none. */
function failurePairs(result: VerifyChainResult): ReportedCase["pairs"] {
  if (result.valid) {
    return [];
  }
  return result.failures.map((failure) => ({ rule: failure.rule, seq: failure.seq }));
}

/**
 * Verify every committed vector through `@npc/osp-core/browser`.
 * `cases` is the full rule/seq list, including valid files (an empty list).
 */
async function runVectors(): Promise<{
  positive: number;
  negative: number;
  cases: ReportedCase[];
}> {
  const browser = await import("../src/browser.js");
  const files = readdirSync(vectorsDir)
    .filter((name) => name.endsWith(".json"))
    .sort();
  if (files.length === 0) {
    throw new Error(`no vectors in ${vectorsDir}`);
  }
  const seen = new Map<string, "valid" | ChainRule>();
  const cases: ReportedCase[] = [];
  let positive = 0;
  let negative = 0;
  for (const filename of files) {
    const vector = parseVectorFile(readFileSync(path.join(vectorsDir, filename), "utf8"), filename);
    seen.set(filename, vector.expected);
    const doorPublicKeys: Record<string, Uint8Array> = {};
    for (const [doorId, encoded] of Object.entries(vector.doorPublicKeys)) {
      doorPublicKeys[doorId] = browser.decodePublicKey(encoded);
    }
    if (vector.blobs !== undefined) {
      const hashes = collectBodyContentHashes(vector.records);
      for (const [cid, encoded] of Object.entries(vector.blobs)) {
        const hash = await browser.hashBlobBytes(browser.decodeBase64Url(encoded));
        if (!browser.cidMatchesHash(cid, hash) || !hashes.has(hash)) {
          throw new Error(`${filename}: blob ${cid} does not match its memory hash`);
        }
      }
    }
    const result: VerifyChainResult = await browser.verifyRecords(vector.records, {
      doorPublicKeys
    });
    const pairs = failurePairs(result);
    cases.push({ file: filename, pairs });
    if (vector.expected === "valid") {
      if (!result.valid) {
        throw new Error(
          `${filename}: expected valid, got ${pairs.map((pair) => pair.rule).join(", ")}`
        );
      }
      positive += 1;
      continue;
    }
    const pinned = exactFailureRules(filename);
    const rules = pairs.map((pair) => pair.rule);
    if (rules[0] !== vector.expected || !sameChainRules(rules, pinned)) {
      throw new Error(
        `${filename}: expected ${pinned.join(", ")}, got ${rules.join(", ") || "valid"}`
      );
    }
    negative += 1;
  }
  for (const [filename, expected] of Object.entries(REQUIRED_VECTORS)) {
    if (seen.get(filename) !== expected) {
      throw new Error(`${filename}: required outcome ${expected} was not tested`);
    }
  }
  return { positive, negative, cases };
}

async function main(): Promise<void> {
  const browserGraph = walk(path.join(srcDir, "browser.ts"), true);
  assertBrowserGraph(browserGraph);
  const rootGraph = walk(path.join(srcDir, "index.ts"), false);
  if (!foundNodeFs(rootGraph)) {
    throw new Error("negative control failed: package root did not reach node:fs");
  }
  const counts = await runVectors();
  const hook = builtinGuardActive ? "on" : "off";
  process.stdout.write(
    `BROWSER_OK files=${String(browserGraph.files.length)} positive=${String(counts.positive)} negative=${String(counts.negative)} rootBuiltins=${String(rootGraph.builtins.length)} hook=${hook}\n`
  );
  process.stdout.write(`BROWSER_CASES ${JSON.stringify(counts.cases)}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
