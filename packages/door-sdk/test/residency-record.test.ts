import { describe, expect, it } from "vitest";

import {
  DEFAULT_RESIDENCY_RECORD_CHARS,
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

  it("drops the oldest lines once text exceeds maxChars", () => {
    const record = new ResidencyRecord({ maxChars: 10 });
    record.record(line("aaaa"));
    record.record(line("bbbb"));
    expect(record.lines().map((entry) => entry.text)).toEqual(["aaaa", "bbbb"]);
    record.record(line("cc")); // 10 chars: still fits
    expect(record.size()).toBe(3);
    record.record(line("d")); // 11 → drop "aaaa"
    expect(record.lines().map((entry) => entry.text)).toEqual(["bbbb", "cc", "d"]);
  });

  it("never holds more than maxChars of text, except a single over-long latest line", () => {
    const record = new ResidencyRecord({ maxChars: 5 });
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

  it("clear empties the record and resets the budget", () => {
    const record = new ResidencyRecord({ maxChars: 4 });
    record.record(line("abcd"));
    record.clear();
    expect(record.size()).toBe(0);
    record.record(line("wxyz"));
    expect(record.lines().map((entry) => entry.text)).toEqual(["wxyz"]);
  });

  it("defaults to 120 000 chars and rejects invalid bounds", () => {
    expect(DEFAULT_RESIDENCY_RECORD_CHARS).toBe(120_000);
    const record = new ResidencyRecord();
    record.record(line("x".repeat(DEFAULT_RESIDENCY_RECORD_CHARS)));
    record.record(line("y"));
    expect(record.lines().map((entry) => entry.text)).toEqual(["y"]);
    for (const maxChars of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new ResidencyRecord({ maxChars })).toThrow(RangeError);
    }
  });
});
