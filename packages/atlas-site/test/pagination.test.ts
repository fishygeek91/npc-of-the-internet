import { describe, expect, it } from "vitest";

import { soulListPath } from "../src/lib/pagination.js";

describe("soulListPath", () => {
  it("emits trailing slashes for multi-page and type-filtered routes", () => {
    expect(soulListPath(1)).toBe("/soul/");
    expect(soulListPath(2)).toBe("/soul/page/2/");
    expect(soulListPath(1, "memory")).toBe("/soul/type/memory/");
    expect(soulListPath(3, "attestation")).toBe("/soul/type/attestation/page/3/");
  });
});
