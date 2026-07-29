import { accessSync, chmodSync, constants, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { KeyringError } from "../src/keyring/errors.js";
import { loadSoulPrivateKeyFromPath } from "../src/keyring/load-soul-key.js";

/** TEST-ONLY: deterministic 32-byte fill pattern (not a real secret). */
const TEST_KEY_BYTES = Buffer.alloc(32, 0x07);

function isReadableByCurrentUser(filePath: string): boolean {
  try {
    accessSync(filePath, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

describe("loadSoulPrivateKeyFromPath", () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir !== undefined) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it("loads a 32-byte raw key file with mode 0600", () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "load-soul-key-"));
    const keyPath = path.join(tempDir, "soul.key");
    writeFileSync(keyPath, TEST_KEY_BYTES, { mode: 0o600 });

    const loaded = loadSoulPrivateKeyFromPath(keyPath);
    expect(loaded).toEqual(new Uint8Array(TEST_KEY_BYTES));
  });

  it("reports permission errors for unreadable key files", (ctx) => {
    tempDir = mkdtempSync(path.join(tmpdir(), "load-soul-key-"));
    const keyPath = path.join(tempDir, "blocked.key");
    writeFileSync(keyPath, TEST_KEY_BYTES, { mode: 0o600 });
    chmodSync(keyPath, 0o000);

    // Root (and some sandboxes) can still read mode 000.
    if (isReadableByCurrentUser(keyPath)) {
      ctx.skip();
      return;
    }

    try {
      loadSoulPrivateKeyFromPath(keyPath);
      expect.fail("expected KeyringError");
    } catch (error) {
      expect(error).toBeInstanceOf(KeyringError);
      if (error instanceof KeyringError) {
        expect(error.message).toContain("permissions");
        expect(error.message).toContain("10001");
        expect(error.message).toContain(keyPath);
      }
    }
  });

  it("reports a generic read failure for a missing key file", () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "load-soul-key-"));
    const missingPath = path.join(tempDir, "missing.key");

    try {
      loadSoulPrivateKeyFromPath(missingPath);
      expect.fail("expected KeyringError");
    } catch (error) {
      expect(error).toBeInstanceOf(KeyringError);
      if (error instanceof KeyringError) {
        expect(error.message).toMatch(/failed to read soul key file/);
        expect(error.message).toContain(missingPath);
        expect(error.message).not.toContain("permissions");
      }
    }
  });
});
