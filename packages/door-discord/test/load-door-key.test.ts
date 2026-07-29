import { accessSync, chmodSync, constants, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { DiscordDoorError } from "../src/errors.js";
import { loadDoorKeypairFromPath } from "../src/load-door-key.js";
import { DOOR } from "./helpers/fixed-keys.js";

function isReadableByCurrentUser(filePath: string): boolean {
  try {
    accessSync(filePath, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

describe("loadDoorKeypairFromPath", () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir !== undefined) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it("loads a 32-byte raw key file with mode 0600", () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "load-door-key-"));
    const keyPath = path.join(tempDir, "door.key");
    writeFileSync(keyPath, Buffer.from(DOOR.privateKey), { mode: 0o600 });

    const loaded = loadDoorKeypairFromPath(keyPath);
    expect(loaded.privateKey).toEqual(DOOR.privateKey);
    expect(loaded.publicKey).toEqual(DOOR.publicKey);
  });

  it("reports permission errors for unreadable key files", (ctx) => {
    tempDir = mkdtempSync(path.join(tmpdir(), "load-door-key-"));
    const keyPath = path.join(tempDir, "blocked.key");
    writeFileSync(keyPath, Buffer.from(DOOR.privateKey), { mode: 0o600 });
    chmodSync(keyPath, 0o000);

    // Root (and some sandboxes) can still read mode 000.
    if (isReadableByCurrentUser(keyPath)) {
      ctx.skip();
      return;
    }

    try {
      loadDoorKeypairFromPath(keyPath);
      expect.fail("expected DiscordDoorError");
    } catch (error) {
      expect(error).toBeInstanceOf(DiscordDoorError);
      if (error instanceof DiscordDoorError) {
        expect(error.code).toBe("invalid_config");
        expect(error.message).toContain("permissions");
        expect(error.message).toContain("10001");
        expect(error.message).toContain(keyPath);
      }
    }
  });

  it("reports a generic read failure for a missing key file", () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "load-door-key-"));
    const missingPath = path.join(tempDir, "missing.key");

    try {
      loadDoorKeypairFromPath(missingPath);
      expect.fail("expected DiscordDoorError");
    } catch (error) {
      expect(error).toBeInstanceOf(DiscordDoorError);
      if (error instanceof DiscordDoorError) {
        expect(error.code).toBe("invalid_config");
        expect(error.message).toMatch(/failed to read door key file/);
        expect(error.message).toContain(missingPath);
        expect(error.message).not.toContain("permissions");
      }
    }
  });
});
