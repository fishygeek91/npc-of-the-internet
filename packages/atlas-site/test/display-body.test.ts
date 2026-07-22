import { describe, expect, it } from "vitest";

import { prettyPrintBody, toDisplayBody } from "../src/lib/display-body.js";

describe("display-body", () => {
  it("redacts rejected memory payloads to category metadata only", () => {
    const record = {
      type: "memory" as const,
      spec: "osp/0.1" as const,
      seq: 4,
      prev: "baguqeeraaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      residency: "door:discord:g/epoch:1",
      body: {
        kind: "rejected" as const,
        category: "injection.role_marker",
        rejected_at: "2026-01-02T01:15:00.000Z",
        candidate_cid: "baguqeerabbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      },
      cosigners: [] as string[],
      sig: "MDlU9fr0Ls41C-e6aKxjXVzqAPuamewNoh090WNbzYAtDjRF6b5KSIPXOjGoovm8zrFbffwCSrWTHjHXogeJDw"
    };

    const display = toDisplayBody(record);
    expect(display).toEqual({
      kind: "rejected",
      category: "injection.role_marker",
      rejected_at: "2026-01-02T01:15:00.000Z",
      candidate_cid: "baguqeerabbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    });
    expect(display).not.toHaveProperty("text");

    const printed = prettyPrintBody(record);
    expect(printed).toContain("injection.role_marker");
    expect(printed).not.toContain("text");
  });

  it("keeps candidate memory text in the display body", () => {
    const record = {
      type: "memory" as const,
      spec: "osp/0.1" as const,
      seq: 3,
      prev: "baguqeeraaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      residency: "door:discord:g/epoch:1",
      body: {
        kind: "candidate" as const,
        text: "a proposed shard awaiting host review",
        proposed_at: "2026-01-02T01:10:00.000Z"
      },
      cosigners: [] as string[],
      sig: "MDlU9fr0Ls41C-e6aKxjXVzqAPuamewNoh090WNbzYAtDjRF6b5KSIPXOjGoovm8zrFbffwCSrWTHjHXogeJDw"
    };

    const display = toDisplayBody(record);
    expect(display).toMatchObject({
      kind: "candidate",
      text: "a proposed shard awaiting host review"
    });
  });
});
