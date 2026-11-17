import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { describe, expect, it } from "vitest";

import { ATLAS_STATE_MAX_BYTES, AtlasWhereabouts } from "../src/atlas.js";
import { WebDoorError } from "../src/errors.js";

async function withHttpServer(
  onRequest: (req: IncomingMessage, res: ServerResponse) => void,
  run: (baseUrl: string) => Promise<void>
): Promise<void> {
  const server = createServer((req, res) => {
    req.on("error", () => {});
    res.on("error", () => {});
    req.resume();
    onRequest(req, res);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("expected TCP listen address");
  }
  try {
    await run(`http://127.0.0.1:${String(address.port)}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.closeAllConnections();
      server.close((error) => {
        if (error !== undefined && error !== null) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}

/** Stream `total` bytes with no Content-Length. The bytes are not JSON. */
function writeChunked(res: ServerResponse, total: number): void {
  res.writeHead(200, { "Content-Type": "application/json" });
  const chunk = Buffer.alloc(Math.min(16 * 1024, total), 0x78);
  let sent = 0;
  const writeMore = (): void => {
    try {
      while (sent < total) {
        const size = Math.min(chunk.length, total - sent);
        const ok = res.write(chunk.subarray(0, size));
        sent += size;
        if (!ok) {
          res.once("drain", writeMore);
          return;
        }
      }
      res.end();
    } catch {
      res.destroy();
    }
  };
  writeMore();
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

async function capError(run: Promise<unknown>): Promise<WebDoorError> {
  const error = await run.then(
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
  expect(error.message).not.toContain("x".repeat(8));
  return error;
}

describe("AtlasWhereabouts response cap", () => {
  it("rejects a chunked body over ATLAS_STATE_MAX_BYTES before JSON.parse", async () => {
    await withHttpServer(
      (_req, res) => {
        writeChunked(res, ATLAS_STATE_MAX_BYTES + 1);
      },
      async (baseUrl) => {
        const atlas = new AtlasWhereabouts(baseUrl);
        await capError(atlas.get());
      }
    );
  });

  it("rejects an oversized Content-Length before reading the body", async () => {
    let markClosed = (): void => {};
    const closed = new Promise<void>((resolve) => {
      markClosed = resolve;
    });
    await withHttpServer(
      (req, res) => {
        req.on("close", () => markClosed());
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Content-Length": String(ATLAS_STATE_MAX_BYTES + 1)
        });
        res.flushHeaders();
      },
      async (baseUrl) => {
        const atlas = new AtlasWhereabouts(baseUrl);
        await capError(atlas.get());
        await closed;
      }
    );
  });

  it("accepts a state body of exactly ATLAS_STATE_MAX_BYTES", async () => {
    const body = stateAtCap(ATLAS_STATE_MAX_BYTES);
    await withHttpServer(
      (_req, res) => {
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Content-Length": String(body.byteLength)
        });
        res.end(body);
      },
      async (baseUrl) => {
        const atlas = new AtlasWhereabouts(baseUrl);
        expect(await atlas.get()).toEqual({
          status: "present",
          door_id: "discord:1",
          since: "2026-11-16T00:00:00.000Z"
        });
      }
    );
  });
});
