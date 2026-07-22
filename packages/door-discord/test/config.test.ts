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
    expect(config.reviewTimeoutMs).toBe(300_000);
  });

  it("fails fast naming DISCORD_BOT_TOKEN when missing", () => {
    const env = baseEnv();
    delete env.DISCORD_BOT_TOKEN;
    expect(() => loadDiscordDoorConfig(env)).toThrow(DiscordDoorError);
    expect(() => loadDiscordDoorConfig(env)).toThrow(/DISCORD_BOT_TOKEN/);
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
