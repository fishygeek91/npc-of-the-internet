import { describe, expect, it, vi } from "vitest";

import { exitAfterStop, stopAll } from "../src/shutdown.js";

describe("stopAll", () => {
  it("runs later stops when an earlier stop throws, then rethrows the first error", async () => {
    const ran: string[] = [];
    const first = new Error("site stop failed");

    await expect(
      stopAll([
        async () => {
          ran.push("site");
          throw first;
        },
        async () => {
          ran.push("ws");
        },
        async () => {
          ran.push("http");
          throw new Error("http stop failed");
        }
      ])
    ).rejects.toBe(first);

    expect(ran).toEqual(["site", "ws", "http"]);
  });

  it("rethrows when a step rejects with undefined", async () => {
    const ran: string[] = [];

    await expect(
      stopAll([
        async () => {
          ran.push("first");
          throw undefined;
        },
        async () => {
          ran.push("second");
        }
      ])
    ).rejects.toBeUndefined();

    expect(ran).toEqual(["first", "second"]);
  });
});

describe("exitAfterStop", () => {
  it("exits 0 when stop rejects", async () => {
    const exits: number[] = [];
    const logged: unknown[] = [];
    const failure = new Error("stop failed");

    exitAfterStop(
      () => Promise.reject(failure),
      (code) => {
        exits.push(code);
      },
      (error) => {
        logged.push(error);
      }
    );

    await vi.waitFor(() => {
      expect(exits).toEqual([0]);
    });
    expect(logged).toEqual([failure]);
  });

  it("exits 0 when stop rejects and the logger throws", async () => {
    const exits: number[] = [];

    exitAfterStop(
      () => Promise.reject(new Error("stop failed")),
      (code) => {
        exits.push(code);
      },
      () => {
        throw new Error("logger failed");
      }
    );

    await vi.waitFor(() => {
      expect(exits).toEqual([0]);
    });
  });
});
