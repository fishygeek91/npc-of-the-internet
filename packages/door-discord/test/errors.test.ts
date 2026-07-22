import { describe, expect, it } from "vitest";

import { DiscordDoorError, operatorNotice } from "../src/errors.js";

describe("operatorNotice", () => {
  it("formats DiscordDoorError without stack traces", () => {
    const notice = operatorNotice(
      new DiscordDoorError("invalid_config", "DISCORD_BOT_TOKEN is required but not set")
    );

    expect(notice).toBe("Door error (invalid_config): DISCORD_BOT_TOKEN is required but not set");
    expect(notice).not.toContain("at ");
    expect(notice).not.toContain("DiscordDoorError");
  });

  it("formats DoorError-like objects with code and message", () => {
    const notice = operatorNotice({
      code: "session_not_live",
      message: "attest rejected because no active epoch"
    });

    expect(notice).toBe("Door error (session_not_live): attest rejected because no active epoch");
    expect(notice).not.toContain("at ");
  });

  it("falls back for generic errors without exposing stacks", () => {
    const notice = operatorNotice(new Error("underlying failure"));

    expect(notice).toBe("Door error: underlying failure");
    expect(notice).not.toContain("at ");
    expect(notice).not.toContain("Error:");
  });
});
