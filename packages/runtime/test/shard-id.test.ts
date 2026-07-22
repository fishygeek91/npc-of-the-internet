import { describe, expect, it } from "vitest";

import { QuarantineError } from "../src/quarantine/errors.js";
import { assignShardIds, shardIdFromText } from "../src/quarantine/shard-id.js";

describe("shardIdFromText", () => {
  it("prefixes shard_ and uses the first 32 hex chars of sha256(utf8(text))", () => {
    const id = shardIdFromText("I remember the quiet guild hall.");
    expect(id).toMatch(/^shard_[0-9a-f]{32}$/);
    expect(id).toBe(shardIdFromText("I remember the quiet guild hall."));
    expect(id).not.toBe(shardIdFromText("Different text."));
  });
});

describe("assignShardIds", () => {
  it("returns stable ids in input order when texts are unique", () => {
    const texts = ["alpha", "beta", "gamma"];
    const ids = assignShardIds(texts);
    expect(ids).toEqual(texts.map((text) => shardIdFromText(text)));
  });

  it("throws QuarantineError when texts collide within the batch", () => {
    const collisionText = "collision probe";
    expect(() => assignShardIds([collisionText, "other", collisionText])).toThrow(QuarantineError);
  });
});
