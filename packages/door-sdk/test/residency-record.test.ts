import { describe, expect, it } from "vitest";

import {
  DEFAULT_COMMUNITY_RECORD_CHARS,
  DEFAULT_WANDERER_RECORD_CHARS,
  ResidencyRecord,
  type ResidencyLine
} from "../src/residency-record.js";

const AT = "2026-10-06T12:00:00.000Z";

function line(text: string, role: ResidencyLine["role"] = "community"): ResidencyLine {
  return role === "community" ? { role, author: "Wren", text, at: AT } : { role, text, at: AT };
}

describe("ResidencyRecord", () => {
  it("keeps lines in order and returns a defensive snapshot", () => {
    const record = new ResidencyRecord();
    record.record(line("hello"));
    record.record(line("hi there", "wanderer"));
    const snapshot = record.lines();
    expect(snapshot.map((entry) => entry.text)).toEqual(["hello", "hi there"]);
    record.record(line("later"));
    expect(snapshot).toHaveLength(2);
    expect(record.size()).toBe(3);
  });

  it("drops the oldest lines of a role once that role's text exceeds its budget", () => {
    const record = new ResidencyRecord({ communityChars: 10 });
    record.record(line("aaaa"));
    record.record(line("bbbb"));
    expect(record.lines().map((entry) => entry.text)).toEqual(["aaaa", "bbbb"]);
    record.record(line("cc")); // 10 chars: still fits
    expect(record.size()).toBe(3);
    record.record(line("d")); // 11 → drop "aaaa"
    expect(record.lines().map((entry) => entry.text)).toEqual(["bbbb", "cc", "d"]);
  });

  it("never holds more than a role's budget, except a single over-long latest line", () => {
    const record = new ResidencyRecord({ communityChars: 5 });
    for (const text of ["abc", "defg", "h", "ijklm", "no"]) {
      record.record(line(text));
      const total = record.lines().reduce((sum, entry) => sum + entry.text.length, 0);
      expect(total).toBeLessThanOrEqual(5);
    }
    record.record(line("x".repeat(12)));
    expect(record.lines().map((entry) => entry.text)).toEqual(["x".repeat(12)]);
    // The next line evicts it.
    record.record(line("y"));
    expect(record.lines().map((entry) => entry.text)).toEqual(["y"]);
  });

  it("the Wanderer cannot evict community lines (separate budgets per role)", () => {
    const record = new ResidencyRecord({ communityChars: 10, wandererChars: 6 });
    record.record(line("said here"));
    for (const text of ["flood1", "flood2", "flood3", "x".repeat(50)]) {
      record.record(line(text, "wanderer"));
    }
    expect(record.lines()).toEqual([
      { role: "community", author: "Wren", text: "said here", at: AT },
      { role: "wanderer", text: "x".repeat(50), at: AT }
    ]);
    // Community lines evict only community lines, keeping the order of what is left.
    record.record(line("w1", "wanderer"));
    record.record(line("abcdef"));
    expect(record.lines().map((entry) => entry.text)).toEqual(["w1", "abcdef"]);
  });

  it("clear empties the record and resets the budget", () => {
    const record = new ResidencyRecord({ communityChars: 4 });
    record.record(line("abcd"));
    record.clear();
    expect(record.size()).toBe(0);
    record.record(line("wxyz"));
    expect(record.lines().map((entry) => entry.text)).toEqual(["wxyz"]);
  });

  it("defaults to 90 000 community + 30 000 wanderer chars and rejects invalid bounds", () => {
    expect(DEFAULT_COMMUNITY_RECORD_CHARS).toBe(90_000);
    expect(DEFAULT_WANDERER_RECORD_CHARS).toBe(30_000);
    const record = new ResidencyRecord();
    record.record(line("c".repeat(DEFAULT_COMMUNITY_RECORD_CHARS)));
    record.record(line("w".repeat(DEFAULT_WANDERER_RECORD_CHARS), "wanderer"));
    expect(record.size()).toBe(2);
    record.record(line("y"));
    record.record(line("z", "wanderer"));
    expect(record.lines().map((entry) => entry.text)).toEqual(["y", "z"]);
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new ResidencyRecord({ communityChars: bad })).toThrow(RangeError);
      expect(() => new ResidencyRecord({ wandererChars: bad })).toThrow(RangeError);
    }
  });
});
