import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { describe, expect, it } from "vitest";

import { ATLAS_STATE_MAX_BYTES, AtlasWhereabouts } from "../src/atlas.js";
import { WebDoorError } from "../src/errors.js";

async function withServer(
  respond: (req: IncomingMessage, res: ServerResponse) => void,
  run: (baseUrl: string) => Promise<void>
): Promise<void> {
  const server = createServer((req, res) => {
    req.on("error", () => {});
    res.on("error", () => {});
    req.resume();
    respond(req, res);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected TCP listen address");
  }
  try {
    await run(`http://127.0.0.1:${String(address.port)}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
}

/** Valid `/state` JSON padded to exactly `target` bytes. Zod strips `pad`. */
function stateAtCap(target: number): Buffer {
  const prefix = Buffer.from(
    '{"status":"present","door_id":"discord:1","since":"2026-11-16T00:00:00.000Z","last_record_at":"2026-11-16T00:00:00.000Z","pad":"',
    "utf8"
  );
  const suffix = Buffer.from('"}', "utf8");
  const padLen = target - prefix.length - suffix.length;
  if (padLen < 1) {
    throw new Error("state skeleton exceeds ATLAS_STATE_MAX_BYTES");
  }
  return Buffer.concat([prefix, Buffer.alloc(padLen, 0x61), suffix]);
}

describe("AtlasWhereabouts response cap", () => {
  it("maps an oversized Content-Length to payload_too_large", async () => {
    let closed = Promise.resolve();
    await withServer(
      (req, res) => {
        closed = new Promise((resolve) => {
          req.on("close", () => resolve());
        });
        res.writeHead(200, { "Content-Length": String(ATLAS_STATE_MAX_BYTES + 1) });
        res.flushHeaders();
      },
      async (baseUrl) => {
        const error = await new AtlasWhereabouts(baseUrl).get().then(
          () => {
            throw new Error("expected payload_too_large");
          },
          (caught: unknown) => caught
        );
        expect(error).toBeInstanceOf(WebDoorError);
        if (!(error instanceof WebDoorError)) {
          throw new Error("expected WebDoorError");
        }
        expect(error.code).toBe("payload_too_large");
        expect(error.message).toContain(String(ATLAS_STATE_MAX_BYTES));
        await closed;
      }
    );
  });

  it("caches an oversized response for 30s and fetches again when that window ends", async () => {
    let hits = 0;
    let now = 0;
    await withServer(
      (_req, res) => {
        hits += 1;
        res.writeHead(200, { "Content-Length": String(ATLAS_STATE_MAX_BYTES + 1) });
        res.flushHeaders();
      },
      async (baseUrl) => {
        const atlas = new AtlasWhereabouts(baseUrl, () => now);
        const overflow = async (): Promise<unknown> =>
          atlas.get().then(
            () => {
              throw new Error("expected payload_too_large");
            },
            (caught: unknown) => caught
          );
        const first = await overflow();
        const second = await overflow();
        expect(first).toBeInstanceOf(WebDoorError);
        expect(second).toBe(first);
        if (!(second instanceof WebDoorError)) {
          throw new Error("expected WebDoorError");
        }
        expect(second.code).toBe("payload_too_large");
        expect(hits).toBe(1);

        now = 29_999;
        await overflow();
        expect(hits).toBe(1);

        now = 30_000;
        const third = await overflow();
        expect(third).toBeInstanceOf(WebDoorError);
        expect(third).not.toBe(first);
        expect(hits).toBe(2);
      }
    );
  });

  it("accepts a state body of exactly ATLAS_STATE_MAX_BYTES", async () => {
    const body = stateAtCap(ATLAS_STATE_MAX_BYTES);
    await withServer(
      (_req, res) => {
        res.writeHead(200, { "Content-Length": String(body.byteLength) });
        res.end(body);
      },
      async (baseUrl) => {
        expect(await new AtlasWhereabouts(baseUrl).get()).toEqual({
          status: "present",
          door_id: "discord:1",
          since: "2026-11-16T00:00:00.000Z"
        });
      }
    );
  });
});
