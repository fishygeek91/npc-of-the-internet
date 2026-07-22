import { encodePublicKey } from "@npc/osp-core";
import { describe, expect, it } from "vitest";

import { loadDaemonConfig } from "../src/daemon-config.js";
import { DaemonError } from "../src/daemon-errors.js";
import { DOOR } from "./helpers/fixed-keys.js";

const VALID_ENV: NodeJS.ProcessEnv = {
  SOUL_KEY_PATH: "/tmp/soul.key",
  SOULCHAIN_DIR: "/tmp/chain",
  DOOR_HTTP_HOST: "127.0.0.1",
  DOOR_HTTP_PORT: "3000",
  CURRENT_DOOR_ID: "discord:test-guild",
  ATLAS_DOOR_PUBKEYS: encodePublicKey(DOOR.publicKey),
  ANTHROPIC_API_KEY: "test-api-key"
};

describe("loadDaemonConfig", () => {
  it("loads a valid configuration", () => {
    const config = loadDaemonConfig(VALID_ENV);
    expect(config.soulKeyPath).toBe("/tmp/soul.key");
    expect(config.soulchainDir).toBe("/tmp/chain");
    expect(config.doorHttpHost).toBe("127.0.0.1");
    expect(config.doorHttpPort).toBe(3000);
    expect(config.doorId).toBe("discord:test-guild");
    expect(config.doorPublicKeys).toHaveLength(1);
    expect(config.brain.apiKey).toBe("test-api-key");
    expect(config.readyFilePath).toBe("/tmp/npc-runtime.ready");
  });

  it("uses NPC_RUNTIME_READY_FILE when set", () => {
    const config = loadDaemonConfig({
      ...VALID_ENV,
      NPC_RUNTIME_READY_FILE: "/tmp/custom.ready"
    });
    expect(config.readyFilePath).toBe("/tmp/custom.ready");
  });

  it("names the missing env var for SOUL_KEY_PATH", () => {
    const env = { ...VALID_ENV };
    delete env.SOUL_KEY_PATH;
    try {
      loadDaemonConfig(env);
      expect.fail("expected DaemonError");
    } catch (error) {
      expect(error).toBeInstanceOf(DaemonError);
      if (error instanceof DaemonError) {
        expect(error.envVar).toBe("SOUL_KEY_PATH");
        expect(error.message).toContain("SOUL_KEY_PATH");
      }
    }
  });

  it("names the missing env var for ATLAS_DOOR_PUBKEYS", () => {
    const env = { ...VALID_ENV };
    delete env.ATLAS_DOOR_PUBKEYS;
    try {
      loadDaemonConfig(env);
      expect.fail("expected DaemonError");
    } catch (error) {
      expect(error).toBeInstanceOf(DaemonError);
      if (error instanceof DaemonError) {
        expect(error.envVar).toBe("ATLAS_DOOR_PUBKEYS");
      }
    }
  });

  it("rejects invalid DOOR_HTTP_PORT", () => {
    expect(() =>
      loadDaemonConfig({
        ...VALID_ENV,
        DOOR_HTTP_PORT: "not-a-port"
      })
    ).toThrow(DaemonError);
    expect(() =>
      loadDaemonConfig({
        ...VALID_ENV,
        DOOR_HTTP_PORT: "0"
      })
    ).toThrow(DaemonError);
  });

  it("rejects invalid ATLAS_DOOR_PUBKEYS", () => {
    try {
      loadDaemonConfig({
        ...VALID_ENV,
        ATLAS_DOOR_PUBKEYS: "not-a-key"
      });
      expect.fail("expected DaemonError");
    } catch (error) {
      expect(error).toBeInstanceOf(DaemonError);
      if (error instanceof DaemonError) {
        expect(error.envVar).toBe("ATLAS_DOOR_PUBKEYS");
      }
    }
  });
});
