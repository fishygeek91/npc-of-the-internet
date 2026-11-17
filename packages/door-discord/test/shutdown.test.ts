import { describe, expect, it, vi } from "vitest";

import { exitAfterStop, stopAll } from "../src/shutdown.js";

describe("stopAll", () => {
  it("runs later stops when an earlier stop throws, then rethrows the first error", async () => {
    const ran: string[] = [];
    const first = new Error("gateway stop failed");

    await expect(
      stopAll([
        async () => {
          ran.push("gateway");
          throw first;
        },
        async () => {
          ran.push("ws");
          throw new Error("ws stop failed");
        },
        async () => {
          ran.push("http");
        }
      ])
    ).rejects.toBe(first);

    expect(ran).toEqual(["gateway", "ws", "http"]);
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

  it("exits 0 when stop resolves", async () => {
    const exits: number[] = [];
    const logged: unknown[] = [];

    exitAfterStop(
      () => Promise.resolve(),
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
    expect(logged).toEqual([]);
  });
});
