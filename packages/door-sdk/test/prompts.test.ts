import { describe, expect, it } from "vitest";

import { buildWitnessUserPrompt, WITNESS_SYSTEM_PROMPT } from "../src/prompts/witness.js";
import type { WitnessInput } from "../src/witness.js";

// Prompts are code: these snapshots change only with a deliberate, reviewed edit
// (`vitest run -u`). The rubric decides what every reference Door witnesses.
describe("witness prompts", () => {
  it("system prompt (rubric)", async () => {
    await expect(WITNESS_SYSTEM_PROMPT).toMatchFileSnapshot(
      "./__snapshots__/witness-system.prompt.txt"
    );
  });

  it("user prompt", async () => {
    const prompt = buildWitnessUserPrompt(INPUT, "0123456789ab");
    await expect(prompt).toMatchFileSnapshot("./__snapshots__/witness-user.prompt.txt");
  });

  it("user prompt (journal, with the witnessed shards)", async () => {
    const prompt = buildWitnessUserPrompt(
      {
        ...INPUT,
        kind: "journal",
        text: "# Lantern\n\nI learned three night birds here.",
        witnessedShards: [INPUT.text]
      },
      "0123456789ab"
    );
    await expect(prompt).toMatchFileSnapshot("./__snapshots__/witness-user-journal.prompt.txt");
  });
});

const INPUT: WitnessInput = {
  doorId: "discord:lantern",
  epoch: 41,
  kind: "shard",
  text: "Someone here taught me the names of three night birds.",
  transcript: [
    {
      role: "community",
      author: "Wren",
      text: "Listen:\nthe nightjar,  the owl,\tthe whip-poor-will.",
      at: "2026-10-06T12:00:00.000Z"
    },
    { role: "community", text: "(no author)", at: "2026-10-06T12:00:01.000Z" },
    {
      role: "wanderer",
      text: "I will remember those birds.",
      at: "2026-10-06T12:00:02.000Z"
    }
  ],
  witnessedShards: []
};
