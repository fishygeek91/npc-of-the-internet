import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { DaemonError } from "../src/daemon-errors.js";
import { loadReplicationConfig } from "../src/replication/config.js";

describe("loadReplicationConfig", () => {
  it("is disabled by default with empty targets", () => {
    const config = loadReplicationConfig({});
    expect(config.enabled).toBe(false);
    expect(config.targets).toEqual([]);
    expect(config.drainIntervalMs).toBe(15_000);
  });

  it("allows enabled with empty targets", () => {
    const config = loadReplicationConfig({
      NPC_REPLICATION_ENABLED: "1",
      NPC_SOULCHAIN_IPFS_DIR: "/data/soulchain-ipfs"
    });
    expect(config.enabled).toBe(true);
    expect(config.targets).toEqual([]);
  });

  it("ignores targets when disabled", () => {
    const config = loadReplicationConfig({
      NPC_REPLICATION_TARGETS: JSON.stringify([
        {
          name: "storacha",
          kind: "car-upload",
          endpoint: "https://up.storacha.network/car",
          tokenEnv: "STORACHA_TOKEN"
        }
      ])
    });
    expect(config.enabled).toBe(false);
    expect(config.targets).toEqual([]);
  });

  it("fails when enabled with targets but missing token", () => {
    expect(() =>
      loadReplicationConfig({
        NPC_REPLICATION_ENABLED: "true",
        NPC_SOULCHAIN_IPFS_DIR: "/data/ipfs",
        NPC_REPLICATION_TARGETS: JSON.stringify([
          {
            name: "storacha",
            kind: "car-upload",
            endpoint: "https://up.storacha.network/car",
            tokenEnv: "STORACHA_TOKEN"
          }
        ])
      })
    ).toThrow(DaemonError);
  });

  it("loads token from env when enabled", async () => {
    const tokenPath = await mkdtemp(join(tmpdir(), "npc-repl-token-"));
    const tokenFile = join(tokenPath, "token.txt");
    await writeFile(tokenFile, "test-token\n", "utf8");

    const config = loadReplicationConfig({
      NPC_REPLICATION_ENABLED: "1",
      NPC_SOULCHAIN_IPFS_DIR: "/data/ipfs",
      NPC_REPLICATION_TARGETS: JSON.stringify([
        {
          name: "filebase",
          kind: "car-upload",
          endpoint: "https://api.filebase.io/v1/ipfs/car",
          tokenEnv: "FILEBASE_TOKEN"
        }
      ]),
      FILEBASE_TOKEN_FILE: tokenFile
    });

    expect(config.enabled).toBe(true);
    expect(config.targets).toHaveLength(1);
    expect(config.targets[0]?.name).toBe("filebase");
  });
});
