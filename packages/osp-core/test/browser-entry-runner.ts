/**
 * Proves `@npc/osp-core/browser` under `--conditions=browser`.
 *
 * Static import graph (type-only imports erased) must not reach a Node
 * built-in, SoulStore, CAR, manifests, or replication. The package root is
 * the negative control: it must reach `node:fs`, or the walker is blind.
 * Then `verifyRecords` runs every `spec/osp/vectors/` file while a resolve
 * hook rejects Node built-ins. sha2-256 is `multiformats` `sha2-browser.js`.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import * as nodeModule from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

import type { ChainRule, VerifyChainResult } from "../src/browser.js";
import { exactFailureRules, sameChainRules } from "./exact-failure-rules.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(here, "../src");
const vectorsDir = path.resolve(here, "../../../spec/osp/vectors");

const CHAIN_RULES: readonly ChainRule[] = [
  "bad_soul_sig",
  "broken_prev_link",
  "seq_gap",
  "schema_violation",
  "missing_cosigner",
  "forked_head",
  "bad_genesis",
  "bad_drift_evidence",
  "bad_tombstone",
  "bad_session_continuity",
  "presence_conflict"
];

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

/** `registerHooks` is Node 22.15+. The static walk is the proof on older 22. */
function installBuiltinGuard(): void {
  const registerHooks: unknown = Reflect.get(nodeModule, "registerHooks");
  if (typeof registerHooks !== "function") {
    return;
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
}

installBuiltinGuard();

function specifierText(node: ts.ImportDeclaration | ts.ExportDeclaration): string | null {
  const specifier = node.moduleSpecifier;
  if (specifier === undefined || !ts.isStringLiteral(specifier)) {
    return null;
  }
  return specifier.text;
}

/** True for `import type` / `export type` and named lists that are all `type`. */
function isTypeOnly(node: ts.ImportDeclaration | ts.ExportDeclaration): boolean {
  if (ts.isImportDeclaration(node)) {
    const clause = node.importClause;
    if (clause === undefined) {
      return false;
    }
    if (clause.isTypeOnly || clause.name !== undefined) {
      return clause.isTypeOnly;
    }
    const bindings = clause.namedBindings;
    if (bindings === undefined) {
      return true;
    }
    if (ts.isNamespaceImport(bindings)) {
      return false;
    }
    return bindings.elements.every((element) => element.isTypeOnly);
  }
  if (node.isTypeOnly) {
    return true;
  }
  if (node.exportClause !== undefined && ts.isNamedExports(node.exportClause)) {
    return node.exportClause.elements.every((element) => element.isTypeOnly);
  }
  return false;
}

function pushLiteral(specifiers: string[], node: ts.Node): void {
  if (!ts.isCallExpression(node)) {
    return;
  }
  const first = node.arguments[0];
  const dynamic = node.expression.kind === ts.SyntaxKind.ImportKeyword;
  const required = ts.isIdentifier(node.expression) && node.expression.text === "require";
  if ((dynamic || required) && first !== undefined && ts.isStringLiteral(first)) {
    specifiers.push(first.text);
  }
}

/** Runtime specifiers. Type-only imports are not reachable in the bundle. */
function runtimeSpecifiers(fileName: string, source: string): string[] {
  const scriptKind = fileName.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind
  );
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && !isTypeOnly(node)) {
      const specifier = specifierText(node);
      if (specifier !== null) {
        specifiers.push(specifier);
      }
    }
    pushLiteral(specifiers, node);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

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

function foundNodeFs(graph: Graph): boolean {
  return graph.builtins.some(
    (hit) =>
      hit.specifier === "node:fs" || hit.specifier === "fs" || hit.specifier.startsWith("node:fs/")
  );
}

type VectorFile = {
  expected: "valid" | ChainRule;
  doorPublicKeys: Record<string, string>;
  records: unknown[];
  blobs?: Record<string, string>;
};

function isChainRule(value: string): value is ChainRule {
  return CHAIN_RULES.some((rule) => rule === value);
}

function stringMap(value: unknown, filename: string, label: string): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${filename}: ${label} must be an object`);
  }
  const map: Record<string, string> = {};
  for (const [key, encoded] of Object.entries(value)) {
    if (typeof encoded !== "string") {
      throw new Error(`${filename}: ${label}.${key} must be a string`);
    }
    map[key] = encoded;
  }
  return map;
}

function parseVector(raw: string, filename: string): VectorFile {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`${filename}: vector root must be an object`);
  }
  const expectedRaw: unknown = Reflect.get(parsed, "expected");
  const recordsRaw: unknown = Reflect.get(parsed, "records");
  if (!Array.isArray(recordsRaw)) {
    throw new Error(`${filename}: records must be an array`);
  }
  const doorPublicKeys = stringMap(
    Reflect.get(parsed, "doorPublicKeys"),
    filename,
    "doorPublicKeys"
  );
  const blobsRaw: unknown = Reflect.get(parsed, "blobs");
  const blobs = blobsRaw === undefined ? undefined : stringMap(blobsRaw, filename, "blobs");
  if (expectedRaw === "valid") {
    return { expected: "valid", doorPublicKeys, records: recordsRaw, blobs };
  }
  if (typeof expectedRaw !== "string" || !isChainRule(expectedRaw)) {
    throw new Error(`${filename}: expected must be "valid" or a ChainRule`);
  }
  return { expected: expectedRaw, doorPublicKeys, records: recordsRaw, blobs };
}

function bodyHashes(records: readonly unknown[]): Set<string> {
  const hashes = new Set<string>();
  for (const record of records) {
    if (typeof record !== "object" || record === null || Reflect.get(record, "type") !== "memory") {
      continue;
    }
    const body: unknown = Reflect.get(record, "body");
    if (typeof body !== "object" || body === null) {
      continue;
    }
    for (const key of ["text_hash", "journal_hash"]) {
      const hash: unknown = Reflect.get(body, key);
      if (typeof hash === "string") {
        hashes.add(hash);
      }
    }
  }
  return hashes;
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
    const vector = parseVector(readFileSync(path.join(vectorsDir, filename), "utf8"), filename);
    seen.set(filename, vector.expected);
    const doorPublicKeys: Record<string, Uint8Array> = {};
    for (const [doorId, encoded] of Object.entries(vector.doorPublicKeys)) {
      doorPublicKeys[doorId] = browser.decodePublicKey(encoded);
    }
    if (vector.blobs !== undefined) {
      const hashes = bodyHashes(vector.records);
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
  process.stdout.write(
    `BROWSER_OK files=${String(browserGraph.files.length)} positive=${String(counts.positive)} negative=${String(counts.negative)} rootBuiltins=${String(rootGraph.builtins.length)}\n`
  );
  process.stdout.write(`BROWSER_CASES ${JSON.stringify(counts.cases)}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
