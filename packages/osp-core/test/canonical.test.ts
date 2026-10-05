import { describe, expect, it } from "vitest";

import { canonicalize } from "../src/canonical.js";
import { EncodingError } from "../src/errors.js";

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

  it("sorts integer-like keys by UTF-16 order, not JS numeric property order", () => {
    const bytes = canonicalize({ "10": 1, "2": 2 });
    // UTF-16: "10" < "2"; JS object order would put "2" before "10".
    expect(new TextDecoder().decode(bytes)).toBe('{"10":1,"2":2}');
  });

  it('rejects an own "__proto__" key at any depth instead of silently dropping it', () => {
    // JSON.parse creates `__proto__` as an ordinary own property (review F5).
    const top: unknown = JSON.parse('{"__proto__":{"evil":1},"a":1}');
    const nested: unknown = JSON.parse('{"a":{"b":[{"__proto__":{}}]}}');
    expect(() => canonicalize(top)).toThrow(EncodingError);
    expect(() => canonicalize(top)).toThrow(/__proto__/);
    expect(() => canonicalize(nested)).toThrow(EncodingError);
  });

  it("still canonicalizes keys that merely resemble prototype names", () => {
    const bytes = canonicalize({ constructor: 1, prototype: 2, proto: 3 });
    expect(new TextDecoder().decode(bytes)).toBe('{"constructor":1,"proto":3,"prototype":2}');
  });
});
