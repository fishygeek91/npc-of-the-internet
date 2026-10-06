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
  ATLAS_DOOR_PUBKEYS: `discord:test-guild=${encodePublicKey(DOOR.publicKey)}`,
  ANTHROPIC_API_KEY: "test-api-key"
};

describe("loadDaemonConfig", () => {
  it("loads a valid configuration", () => {
    const config = loadDaemonConfig(VALID_ENV);
    expect(config.soulKeyPath).toBe("/tmp/soul.key");
    expect(config.soulchainDir).toBe("/tmp/chain");
    expect(config.doorUrls).toEqual(["http://127.0.0.1:3000"]);
    expect(config.preferredDoorId).toBe("discord:test-guild");
    expect(Object.keys(config.doorPublicKeys)).toEqual(["discord:test-guild"]);
    expect(config.brain.provider).toBe("anthropic");
    if (config.brain.provider === "anthropic") {
      expect(config.brain.apiKey).toBe("test-api-key");
    }
    expect(config.readyFilePath).toBe("/tmp/npc-runtime.ready");
    expect(config.replication.enabled).toBe(false);
    expect(config.replication.targets).toEqual([]);
    expect(config.attentionMode).toBe("selective");
    expect(config.residency).toMatchObject({
      maxResidencyMs: 86_400_000,
      minMemoryLines: 10,
      operatorTrigger: true
    });
  });

  it("NPC_DOOR_URLS lists the Doors (deduped, trailing slashes dropped) and wins over the legacy pair", () => {
    const config = loadDaemonConfig({
      ...VALID_ENV,
      NPC_DOOR_URLS:
        " http://door-discord:8787/, https://door.example.org ,http://door-discord:8787"
    });
    expect(config.doorUrls).toEqual(["http://door-discord:8787", "https://door.example.org"]);

    const withoutLegacy: NodeJS.ProcessEnv = {
      ...VALID_ENV,
      NPC_DOOR_URLS: "http://door-web:8788"
    };
    delete withoutLegacy.DOOR_HTTP_HOST;
    delete withoutLegacy.DOOR_HTTP_PORT;
    expect(loadDaemonConfig(withoutLegacy).doorUrls).toEqual(["http://door-web:8788"]);
  });

  it("rejects non-http(s) NPC_DOOR_URLS entries", () => {
    for (const bad of ["ws://door:8787", "door-discord:8787", "ftp://x"]) {
      try {
        loadDaemonConfig({ ...VALID_ENV, NPC_DOOR_URLS: bad });
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(DaemonError);
        expect((error as DaemonError).envVar).toBe("NPC_DOOR_URLS");
      }
    }
  });

  it("CURRENT_DOOR_ID is optional; without NPC_DOOR_URLS the legacy host/port are required", () => {
    const noPreference = { ...VALID_ENV };
    delete noPreference.CURRENT_DOOR_ID;
    expect(loadDaemonConfig(noPreference).preferredDoorId).toBeUndefined();

    const noDoors = { ...VALID_ENV };
    delete noDoors.DOOR_HTTP_HOST;
    try {
      loadDaemonConfig(noDoors);
      expect.unreachable();
    } catch (error) {
      expect((error as DaemonError).envVar).toBe("DOOR_HTTP_HOST");
    }
  });

  it("parses NPC_ATTENTION_MODE and rejects unknown values", () => {
    expect(loadDaemonConfig({ ...VALID_ENV, NPC_ATTENTION_MODE: "always" }).attentionMode).toBe(
      "always"
    );
    expect(
      loadDaemonConfig({ ...VALID_ENV, NPC_ATTENTION_MODE: " selective " }).attentionMode
    ).toBe("selective");
    try {
      loadDaemonConfig({ ...VALID_ENV, NPC_ATTENTION_MODE: "chatty" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DaemonError);
      expect((error as DaemonError).envVar).toBe("NPC_ATTENTION_MODE");
    }
  });

  it("loads optional NPC_SOULCHAIN_IPFS_DIR", () => {
    const config = loadDaemonConfig({
      ...VALID_ENV,
      NPC_SOULCHAIN_IPFS_DIR: "/data/soulchain-ipfs"
    });
    expect(config.soulchainIpfsDir).toBe("/data/soulchain-ipfs");
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
