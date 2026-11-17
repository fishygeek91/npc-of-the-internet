/**
 * Browser entry: vector outcomes, a real wrong-key signature, and the
 * child process that proves the import graph has no Node built-ins.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { generateKeypair, sign } from "../src/crypto/ed25519.js";
import { canonicalize, verify } from "../src/browser.js";

const here = path.dirname(fileURLToPath(import.meta.url));

describe("@npc/osp-core/browser", () => {
  it("verifies every osp vector with no Node built-in reachable", () => {
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
