import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { encodePublicKey } from "@npc/osp-core";
import { describe, expect, it } from "vitest";

import { loadDiscordDoorConfig } from "../src/config.js";
import { DiscordDoorError } from "../src/errors.js";
import { SOUL } from "./helpers/fixed-keys.js";

function baseEnv(): NodeJS.ProcessEnv {
  return {
    DISCORD_BOT_TOKEN: "token",
    DISCORD_GUILD_ID: "10001",
    DISCORD_CHANNEL_ID: "10002",
    DISCORD_OPERATOR_IDS: "10004",
    DOOR_KEY_PATH: "/tmp/door.key",
    SOUL_PUBLIC_KEY: encodePublicKey(SOUL.publicKey)
  };
}

describe("loadDiscordDoorConfig", () => {
  it("loads a valid env map", () => {
    const config = loadDiscordDoorConfig(baseEnv());
    expect(config.guildId).toBe("10001");
    expect(config.operatorIds).toEqual(["10004"]);
    expect(config.witness).toBeNull();
    expect(config.presenceNotices).toBe(true);
  });

  it("DISCORD_PRESENCE_NOTICES=0 disables presence notices; junk is a config error", () => {
    expect(
      loadDiscordDoorConfig({ ...baseEnv(), DISCORD_PRESENCE_NOTICES: "0" }).presenceNotices
    ).toBe(false);
    expect(
      loadDiscordDoorConfig({ ...baseEnv(), DISCORD_PRESENCE_NOTICES: "1" }).presenceNotices
    ).toBe(true);
    expect(() =>
      loadDiscordDoorConfig({ ...baseEnv(), DISCORD_PRESENCE_NOTICES: "maybe" })
    ).toThrow(/DISCORD_PRESENCE_NOTICES/);
  });

  it("loads the memory witness from DOOR_WITNESS_*, falling back to NPC_BRAIN_*", () => {
    const own = loadDiscordDoorConfig({
      ...baseEnv(),
      DOOR_WITNESS_BASE_URL: "https://witness.test/v1",
      DOOR_WITNESS_API_KEY: "witness-key",
      DOOR_WITNESS_MODEL: "witness-model"
    });
    expect(own.witness).toMatchObject({
      baseUrl: "https://witness.test/v1",
      apiKey: "witness-key",
      model: "witness-model"
    });

    const brain = loadDiscordDoorConfig({
      ...baseEnv(),
      NPC_BRAIN_BASE_URL: "https://brain.test/v1",
      NPC_BRAIN_API_KEY: "brain-key",
      NPC_BRAIN_MODEL: "brain-model"
    });
    expect(brain.witness?.model).toBe("brain-model");

    const off = loadDiscordDoorConfig({
      ...baseEnv(),
      DOOR_WITNESS: "off",
      NPC_BRAIN_BASE_URL: "https://brain.test/v1",
      NPC_BRAIN_API_KEY: "brain-key",
      NPC_BRAIN_MODEL: "brain-model"
    });
    expect(off.witness).toBeNull();
  });

  it("a partial witness config is an invalid_config boot error naming the var, not the key", () => {
    const env = {
      ...baseEnv(),
      DOOR_WITNESS_BASE_URL: "https://witness.test/v1",
      DOOR_WITNESS_API_KEY: "witness-secret-key"
    };
    let caught: unknown;
    try {
      loadDiscordDoorConfig(env);
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DiscordDoorError);
    expect((caught as DiscordDoorError).code).toBe("invalid_config");
    expect((caught as DiscordDoorError).message).toMatch(/DOOR_WITNESS_MODEL/);
    expect((caught as DiscordDoorError).message).not.toContain("witness-secret-key");
  });

  it("fails fast naming DISCORD_BOT_TOKEN when missing", () => {
    const env = baseEnv();
    delete env.DISCORD_BOT_TOKEN;
    expect(() => loadDiscordDoorConfig(env)).toThrow(DiscordDoorError);
    expect(() => loadDiscordDoorConfig(env)).toThrow(/DISCORD_BOT_TOKEN/);
  });

  it("loads bot token from DISCORD_BOT_TOKEN_FILE", () => {
    const dir = mkdtempSync(join(tmpdir(), "npc-discord-token-"));
    const tokenPath = join(dir, "bot-token");
    writeFileSync(tokenPath, "  token-from-file  \n");

    const env = baseEnv();
    delete env.DISCORD_BOT_TOKEN;
    env.DISCORD_BOT_TOKEN_FILE = tokenPath;

    const config = loadDiscordDoorConfig(env);
    expect(config.botToken).toBe("token-from-file");
  });

  it("fails when both DISCORD_BOT_TOKEN and DISCORD_BOT_TOKEN_FILE are set", () => {
    const env = { ...baseEnv(), DISCORD_BOT_TOKEN_FILE: "/tmp/token" };
    expect(() => loadDiscordDoorConfig(env)).toThrow(DiscordDoorError);
    expect(() => loadDiscordDoorConfig(env)).toThrow(
      /set only one of DISCORD_BOT_TOKEN or DISCORD_BOT_TOKEN_FILE/
    );
  });

  it("fails when DISCORD_BOT_TOKEN_FILE points to an empty file", () => {
    const dir = mkdtempSync(join(tmpdir(), "npc-discord-token-"));
    const tokenPath = join(dir, "empty-token");
    writeFileSync(tokenPath, "  \n");

    const env = baseEnv();
    delete env.DISCORD_BOT_TOKEN;
    env.DISCORD_BOT_TOKEN_FILE = tokenPath;

    expect(() => loadDiscordDoorConfig(env)).toThrow(DiscordDoorError);
    expect(() => loadDiscordDoorConfig(env)).toThrow(/DISCORD_BOT_TOKEN_FILE at .+ is empty/);
  });

  it("fails fast naming DOOR_HTTP_PORT when invalid", () => {
    const env = { ...baseEnv(), DOOR_HTTP_PORT: "nope" };
    expect(() => loadDiscordDoorConfig(env)).toThrow(/DOOR_HTTP_PORT/);
  });

  it("fails fast naming SOUL_PUBLIC_KEY when invalid", () => {
    const env = { ...baseEnv(), SOUL_PUBLIC_KEY: "!!!not-a-key!!!" };
    expect(() => loadDiscordDoorConfig(env)).toThrow(/SOUL_PUBLIC_KEY/);
  });
});
