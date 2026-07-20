import { describe, expect, it } from "vitest";

import { canonicalize } from "../src/canonical.js";

describe("canonicalize", () => {
  it("produces identical bytes regardless of key insertion order", () => {
    const first = { z: 1, a: 2, m: 3 };
    const second = { a: 2, m: 3, z: 1 };

    const firstBytes = canonicalize(first);
    const secondBytes = canonicalize(second);

    expect(firstBytes).toEqual(secondBytes);
    expect(new TextDecoder().decode(firstBytes)).toBe('{"a":2,"m":3,"z":1}');
  });

  it("sorts keys recursively in nested objects", () => {
    const value = {
      outer: { z: 1, a: 2 },
      beta: { y: true, b: false }
    };

    const bytes = canonicalize(value);
    expect(new TextDecoder().decode(bytes)).toBe(
      '{"beta":{"b":false,"y":true},"outer":{"a":2,"z":1}}'
    );
  });

  it("preserves array element order", () => {
    const value = { items: [3, 1, 2], meta: { tags: ["c", "a", "b"] } };

    const bytes = canonicalize(value);
    expect(new TextDecoder().decode(bytes)).toBe('{"items":[3,1,2],"meta":{"tags":["c","a","b"]}}');
  });

  it("emits compact JSON with no insignificant whitespace", () => {
    const bytes = canonicalize({ seq: 42, type: "genesis", nested: { a: 1 } });
    const text = new TextDecoder().decode(bytes);

    expect(text).not.toMatch(/\s/);
    expect(text.endsWith("\n")).toBe(false);
    expect(text).toBe('{"nested":{"a":1},"seq":42,"type":"genesis"}');
  });
});
