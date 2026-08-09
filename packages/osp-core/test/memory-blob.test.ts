import { describe, expect, it } from "vitest";

import {
  assertCidMatchesHash,
  cidMatchesHash,
  contentAddressSideBlob,
  decodeJournalBlob,
  decodeMemoryTextBlob,
  decodeShardTextBlob,
  encodeJournalBlob,
  encodeMemoryTextBlob,
  encodeShardTextBlob,
  hashBlobBytes
} from "../src/memory-blob.js";
import { SchemaError } from "../src/errors.js";

describe("memory side blobs", () => {
  it("round-trips shard text through canonical JSON string bytes", async () => {
    const text = "I learned a word for leaving gently.";
    const bytes = encodeShardTextBlob(text);
    expect(decodeShardTextBlob(bytes)).toBe(text);
    const { cid, hash } = await contentAddressSideBlob(bytes);
    expect(cid.startsWith("bagu")).toBe(true);
    expect(cidMatchesHash(cid, hash)).toBe(true);
    expect(await hashBlobBytes(bytes)).toBe(hash);
  });

  it("round-trips journal markdown without a 500-code-point cap", () => {
    const markdown = "# Stay\n\n" + "a".repeat(600);
    const bytes = encodeJournalBlob(markdown);
    expect(decodeJournalBlob(bytes)).toBe(markdown);
  });

  it("rejects shard text over 500 Unicode code points", () => {
    const tooLong = "a".repeat(501);
    expect(() => encodeShardTextBlob(tooLong)).toThrow(SchemaError);
  });

  it("rejects non-string JSON blob payloads", () => {
    const bytes = new TextEncoder().encode('{"not":"a string"}');
    expect(() => decodeMemoryTextBlob(bytes)).toThrow(/JSON string/);
  });

  it("assertCidMatchesHash throws on mismatch", async () => {
    const bytes = encodeMemoryTextBlob("hello");
    const { cid } = await contentAddressSideBlob(bytes);
    expect(() =>
      assertCidMatchesHash(cid, "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "text")
    ).toThrow(SchemaError);
  });
});
