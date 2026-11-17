/**
 * Browser entry: vector outcomes, a real wrong-key signature, and the
 * child process that proves the import graph has no Node built-ins.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { generateKeypair, sign } from "../src/crypto/ed25519.js";
import { canonicalize, verify } from "../src/browser.js";
import { decodePublicKey, verifyRecords } from "../src/index.js";
import { exactFailureRules } from "./exact-failure-rules.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const vectorsDir = path.resolve(here, "../../../spec/osp/vectors");

type FailurePair = { rule: string; seq: number };

type BrowserCase = { file: string; pairs: FailurePair[] };

/** True when `value` is one reported failure pair. */
function isFailurePair(value: unknown): value is FailurePair {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const rule: unknown = Reflect.get(value, "rule");
  const seq: unknown = Reflect.get(value, "seq");
  return typeof rule === "string" && typeof seq === "number" && Number.isInteger(seq);
}

/** Parse the runner's `BROWSER_CASES` line. */
function parseBrowserCases(stdout: string): BrowserCase[] {
  const line = stdout.split("\n").find((item) => item.startsWith("BROWSER_CASES "));
  if (line === undefined) {
    throw new Error("runner did not report BROWSER_CASES");
  }
  const parsed: unknown = JSON.parse(line.slice("BROWSER_CASES ".length));
  if (!Array.isArray(parsed)) {
    throw new Error("BROWSER_CASES must be an array");
  }
  return parsed.map((item) => {
    if (typeof item !== "object" || item === null) {
      throw new Error("BROWSER_CASES entry must be an object");
    }
    const file: unknown = Reflect.get(item, "file");
    const pairsRaw: unknown = Reflect.get(item, "pairs");
    if (typeof file !== "string" || !Array.isArray(pairsRaw) || !pairsRaw.every(isFailurePair)) {
      throw new Error(`BROWSER_CASES entry ${String(file)} is malformed`);
    }
    return { file, pairs: pairsRaw };
  });
}

/** Node-path failure pairs for every committed vector, in filename order. */
async function nodeFailureCases(): Promise<BrowserCase[]> {
  const files = readdirSync(vectorsDir)
    .filter((name) => name.endsWith(".json"))
    .sort();
  const cases: BrowserCase[] = [];
  for (const filename of files) {
    const parsed: unknown = JSON.parse(readFileSync(path.join(vectorsDir, filename), "utf8"));
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error(`${filename}: vector root must be an object`);
    }
    const expected: unknown = Reflect.get(parsed, "expected");
    const records: unknown = Reflect.get(parsed, "records");
    const doorRaw: unknown = Reflect.get(parsed, "doorPublicKeys");
    if (typeof expected !== "string" || !Array.isArray(records)) {
      throw new Error(`${filename}: expected and records are required`);
    }
    if (typeof doorRaw !== "object" || doorRaw === null || Array.isArray(doorRaw)) {
      throw new Error(`${filename}: doorPublicKeys must be an object`);
    }
    const doorPublicKeys: Record<string, Uint8Array> = {};
    for (const [doorId, encoded] of Object.entries(doorRaw)) {
      if (typeof encoded !== "string") {
        throw new Error(`${filename}: door key ${doorId} must be a string`);
      }
      doorPublicKeys[doorId] = decodePublicKey(encoded);
    }
    const result = await verifyRecords(records, { doorPublicKeys });
    const pairs = result.valid
      ? []
      : result.failures.map((failure) => ({ rule: failure.rule, seq: failure.seq }));
    if (expected !== "valid") {
      const pinned = exactFailureRules(filename);
      expect(pairs[0]?.rule, filename).toBe(expected);
      expect(
        pairs.map((pair) => pair.rule),
        filename
      ).toEqual([...pinned]);
    } else {
      expect(pairs, filename).toEqual([]);
    }
    cases.push({ file: filename, pairs });
  }
  return cases;
}

describe("@npc/osp-core/browser", () => {
  it("verifies every osp vector with no Node built-in reachable", async () => {
    const runner = path.join(here, "browser-entry-runner.ts");
    const result = spawnSync(
      process.execPath,
      ["--conditions=browser", "--import", "tsx", runner],
      {
        cwd: path.resolve(here, ".."),
        encoding: "utf8"
      }
    );
    const detail = `${result.stdout}\n${result.stderr}`;
    expect(result.status, detail).toBe(0);
    const match = /BROWSER_OK files=(\d+) positive=(\d+) negative=(\d+)/.exec(result.stdout);
    if (match === null) {
      throw new Error(`runner did not report BROWSER_OK\n${detail}`);
    }
    const files = Number(match[1]);
    const positive = Number(match[2]);
    const negative = Number(match[3]);
    expect(files).toBeGreaterThan(10);
    expect(positive).toBeGreaterThan(0);
    expect(negative).toBeGreaterThan(0);

    const browserCases = parseBrowserCases(result.stdout);
    const nodeCases = await nodeFailureCases();
    expect(browserCases).toEqual(nodeCases);
  }, 60_000);

  it("rejects a real Ed25519 signature from a different session key", () => {
    const session = generateKeypair();
    const other = generateKeypair();
    const sameKey = session.publicKey.every((byte, index) => byte === other.publicKey[index]);
    expect(sameKey).toBe(false);
    const bytes = canonicalize({
      type: "outbound",
      door_id: "web:home",
      epoch: 1,
      body: { text: "a line the other key signed" }
    });
    const signature = sign(bytes, other.privateKey);
    expect(verify(bytes, signature, other.publicKey)).toBe(true);
    expect(verify(bytes, signature, session.publicKey)).toBe(false);
  });
});
