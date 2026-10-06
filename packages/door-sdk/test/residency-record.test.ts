import { describe, expect, it } from "vitest";

import { buildWitnessUserPrompt } from "../src/prompts/witness.js";
import {
  DEFAULT_COMMUNITY_RECORD_CHARS,
  DEFAULT_COMMUNITY_RECORD_LINES,
  DEFAULT_WANDERER_RECORD_CHARS,
  DEFAULT_WANDERER_RECORD_LINES,
  ResidencyRecord,
  residencyLineChars,
  type ResidencyLine
} from "../src/residency-record.js";

const AT = "2026-10-06T12:00:00.000Z";

function line(text: string, role: ResidencyLine["role"] = "community"): ResidencyLine {
  return role === "community" ? { role, author: "Wren", text, at: AT } : { role, text, at: AT };
}

/** Charged size of `line(text, role)`. */
function cost(text: string, role: ResidencyLine["role"] = "community"): number {
  return residencyLineChars(line(text, role));
}

function charged(record: ResidencyRecord): number {
  return record.lines().reduce((sum, entry) => sum + residencyLineChars(entry), 0);
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
    const record = new ResidencyRecord({
      communityChars: cost("aaaa") + cost("bbbb") + cost("cc")
    });
    record.record(line("aaaa"));
    record.record(line("bbbb"));
    expect(record.lines().map((entry) => entry.text)).toEqual(["aaaa", "bbbb"]);
    record.record(line("cc")); // exactly the budget: still fits
    expect(record.size()).toBe(3);
    record.record(line("d")); // over → drop "aaaa"
    expect(record.lines().map((entry) => entry.text)).toEqual(["bbbb", "cc", "d"]);
  });

  it("never holds more than a role's budget, except a single over-long latest line", () => {
    const budget = cost("abc") + cost("defg");
    const record = new ResidencyRecord({ communityChars: budget });
    for (const text of ["abc", "defg", "h", "ijklm", "no"]) {
      record.record(line(text));
      expect(charged(record)).toBeLessThanOrEqual(budget);
    }
    record.record(line("x".repeat(budget)));
    expect(record.lines().map((entry) => entry.text)).toEqual(["x".repeat(budget)]);
    // The next line evicts it.
    record.record(line("y"));
    expect(record.lines().map((entry) => entry.text)).toEqual(["y"]);
  });

  it("the Wanderer cannot evict community lines (separate budgets per role)", () => {
    const record = new ResidencyRecord({
      communityChars: cost("said here") + 2,
      wandererChars: cost("flood1", "wanderer")
    });
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
    const record = new ResidencyRecord({ communityChars: cost("abcd") });
    record.record(line("abcd"));
    record.clear();
    expect(record.size()).toBe(0);
    record.record(line("wxyz"));
    expect(record.lines().map((entry) => entry.text)).toEqual(["wxyz"]);
  });

  it("defaults to 90 000 / 30 000 chars and 2000 / 1000 lines, and rejects invalid bounds", () => {
    expect(DEFAULT_COMMUNITY_RECORD_CHARS).toBe(90_000);
    expect(DEFAULT_WANDERER_RECORD_CHARS).toBe(30_000);
    expect(DEFAULT_COMMUNITY_RECORD_LINES).toBe(2000);
    expect(DEFAULT_WANDERER_RECORD_LINES).toBe(1000);
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
      expect(() => new ResidencyRecord({ communityLines: bad })).toThrow(RangeError);
      expect(() => new ResidencyRecord({ wandererLines: bad })).toThrow(RangeError);
    }
  });

  it("charges each line its rendered size: escaped text, cut author and a fixed overhead", () => {
    const plain = residencyLineChars({ role: "community", author: "Wren", text: "hi", at: AT });
    const longName = residencyLineChars({
      role: "community",
      author: "n".repeat(500),
      text: "hi",
      at: AT
    });
    expect(longName - plain).toBe(64 - 4); // the prompt shows at most 64 chars of a name
    const escaped = residencyLineChars({ role: "wanderer", text: "\u0001".repeat(10), at: AT });
    expect(escaped).toBe(JSON.stringify("\u0001".repeat(10)).length + 40);
    // The charge is an upper bound on the line as the witness prompt renders it.
    for (const entry of [
      line(""),
      line('quote " and \\ backslash'),
      line("", "wanderer"),
      { role: "community", text: "no author", at: AT } as const
    ]) {
      const prompt = buildWitnessUserPrompt(
        {
          doorId: "d",
          epoch: 1,
          kind: "shard",
          text: "m",
          transcript: [entry],
          witnessedShards: []
        },
        "T"
      );
      const rendered = prompt.split("\n").find((row) => row.startsWith('{"role"'));
      expect(rendered).toBeDefined();
      expect((rendered?.length ?? 0) + 1).toBeLessThanOrEqual(residencyLineChars(entry));
    }
  });

  it("caps lines per role (oldest dropped first)", () => {
    const record = new ResidencyRecord({ communityLines: 3, wandererLines: 2 });
    for (const text of ["a", "b", "c", "d"]) {
      record.record(line(text));
    }
    for (const text of ["w1", "w2", "w3"]) {
      record.record(line(text, "wanderer"));
    }
    expect(record.lines().map((entry) => entry.text)).toEqual(["b", "c", "d", "w2", "w3"]);
  });

  it("100k one-char lines with 32-char names keep the witness prompt under ~150k chars", () => {
    const record = new ResidencyRecord();
    const author = "a".repeat(32);
    for (let index = 0; index < 100_000; index += 1) {
      record.record({ role: "community", author, text: "x", at: AT });
      record.record({ role: "wanderer", text: "y", at: AT });
    }
    expect(record.size()).toBeLessThanOrEqual(
      DEFAULT_COMMUNITY_RECORD_LINES + DEFAULT_WANDERER_RECORD_LINES
    );
    const prompt = buildWitnessUserPrompt(
      {
        doorId: "discord:test",
        epoch: 1,
        kind: "shard",
        text: "I remember the room.",
        transcript: record.lines(),
        witnessedShards: []
      },
      "TAG"
    );
    expect(prompt.length).toBeLessThan(150_000);
  });
});
