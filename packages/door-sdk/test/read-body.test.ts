import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { encodePublicKey, generateKeypair } from "@npc/osp-core";
import { describe, expect, it } from "vitest";

import { DoorError } from "../src/errors.js";
import { readBodyCapped, ResponseTooLargeError } from "../src/read-body.js";
import { DOOR_PROTOCOL_VERSION } from "../src/schemas.js";
import { HttpDoorConnection } from "../src/transports/http-client.js";
import { MAX_HTTP_BODY_BYTES } from "../src/transports/http.js";

const CAP = 32;

/**
 * Body whose reads are exactly `chunks`, in order.
 * `Content-Length` is set only when `headers` includes it.
 */
function streamedResponse(chunks: readonly Uint8Array[], headers?: HeadersInit): Response {
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller: ReadableStreamDefaultController<Uint8Array>): void {
      const chunk = chunks[index];
      if (chunk === undefined) {
        controller.close();
        return;
      }
      index += 1;
      controller.enqueue(chunk);
    }
  });
  if (headers === undefined) {
    return new Response(body);
  }
  return new Response(body, { headers });
}

async function withServer(
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
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
}

describe("readBodyCapped", () => {
  it("cancels a chunked body once it passes the cap", async () => {
    let closed = Promise.resolve();
    await withServer(
      (req, res) => {
        closed = new Promise((resolve) => {
          req.on("close", () => resolve());
        });
        res.writeHead(200);
        res.write(Buffer.alloc(CAP + 1, 0x78));
      },
      async (baseUrl) => {
        const abort = new AbortController();
        const response = await fetch(baseUrl, { signal: abort.signal });
        const error = await readBodyCapped(response, CAP, abort).then(
          () => {
            throw new Error("expected ResponseTooLargeError");
          },
          (caught: unknown) => caught
        );
        expect(error).toBeInstanceOf(ResponseTooLargeError);
        if (!(error instanceof ResponseTooLargeError)) {
          throw new Error("expected ResponseTooLargeError");
        }
        expect(error.maxBytes).toBe(CAP);
        expect(error.message).toBe("response body exceeds cap");
        expect(error.cause).toBeUndefined();
        expect(abort.signal.aborted).toBe(true);
        await closed;
      }
    );
  });

  it("rejects Content-Length above the cap before the body is read", async () => {
    let closed = Promise.resolve();
    await withServer(
      (req, res) => {
        closed = new Promise((resolve) => {
          req.on("close", () => resolve());
        });
        res.writeHead(200, { "Content-Length": String(CAP + 1) });
        res.flushHeaders();
      },
      async (baseUrl) => {
        const abort = new AbortController();
        const response = await fetch(baseUrl, { signal: abort.signal });
        await expect(readBodyCapped(response, CAP, abort)).rejects.toBeInstanceOf(
          ResponseTooLargeError
        );
        expect(abort.signal.aborted).toBe(true);
        await closed;
      }
    );
  });

  it("returns a body of exactly the cap", async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(200, { "Content-Length": String(CAP) });
        res.end(Buffer.alloc(CAP, 0x61));
      },
      async (baseUrl) => {
        const bytes = await readBodyCapped(await fetch(baseUrl), CAP);
        expect(bytes.byteLength).toBe(CAP);
        expect(bytes[0]).toBe(0x61);
        expect(bytes[CAP - 1]).toBe(0x61);
      }
    );
  });

  it("returns a multi-chunk stream of exactly the cap with no Content-Length", async () => {
    const half = CAP / 2;
    const response = streamedResponse([Buffer.alloc(half, 0x61), Buffer.alloc(half, 0x62)]);
    expect(response.headers.get("content-length")).toBeNull();
    const bytes = await readBodyCapped(response, CAP);
    expect(bytes.byteLength).toBe(CAP);
    expect(bytes[0]).toBe(0x61);
    expect(bytes[half - 1]).toBe(0x61);
    expect(bytes[half]).toBe(0x62);
    expect(bytes[CAP - 1]).toBe(0x62);
  });

  it("rejects a multi-chunk stream one byte over the cap with no Content-Length", async () => {
    const abort = new AbortController();
    const response = streamedResponse([Buffer.alloc(CAP, 0x61), Buffer.alloc(1, 0x62)]);
    expect(response.headers.get("content-length")).toBeNull();
    const error = await readBodyCapped(response, CAP, abort).then(
      () => {
        throw new Error("expected ResponseTooLargeError");
      },
      (caught: unknown) => caught
    );
    expect(error).toBeInstanceOf(ResponseTooLargeError);
    if (!(error instanceof ResponseTooLargeError)) {
      throw new Error("expected ResponseTooLargeError");
    }
    expect(error.maxBytes).toBe(CAP);
    expect(abort.signal.aborted).toBe(true);
  });

  it("ignores a non-numeric Content-Length and streams a body of exactly the cap", async () => {
    const header = `${String(CAP + 1)}bogus`;
    const response = streamedResponse([Buffer.alloc(CAP / 2, 0x61), Buffer.alloc(CAP / 2, 0x62)], {
      "content-length": header
    });
    expect(response.headers.get("content-length")).toBe(header);
    const bytes = await readBodyCapped(response, CAP);
    expect(bytes.byteLength).toBe(CAP);
    expect(bytes[0]).toBe(0x61);
    expect(bytes[CAP / 2]).toBe(0x62);
  });
});

describe("HttpDoorConnection cap mapping", () => {
  it("maps ResponseTooLargeError to DoorError door_unavailable", async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(200, { "Content-Length": String(MAX_HTTP_BODY_BYTES + 1) });
        res.flushHeaders();
      },
      async (baseUrl) => {
        const error = await new HttpDoorConnection({ baseUrl, timeoutMs: 2_000 })
          .hello({
            protocol_version: DOOR_PROTOCOL_VERSION,
            soul_pubkey: encodePublicKey(generateKeypair().publicKey)
          })
          .then(
            () => {
              throw new Error("expected door_unavailable");
            },
            (caught: unknown) => caught
          );
        expect(error).toBeInstanceOf(DoorError);
        if (!(error instanceof DoorError)) {
          throw new Error("expected DoorError");
        }
        expect(error.code).toBe("door_unavailable");
        expect(error.httpStatus).toBe(503);
        expect(error.message).toBe(
          `door unavailable: response body exceeds ${String(MAX_HTTP_BODY_BYTES)} bytes`
        );
        expect(error.cause).toBeUndefined();
      }
    );
  });

  it("maps an unrecognized wire error code through HttpDoorConnection", async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              code: "bogus",
              message: "bad sig",
              details: { field: "sig" }
            }
          })
        );
      },
      async (baseUrl) => {
        const error = await new HttpDoorConnection({ baseUrl, timeoutMs: 2_000 })
          .hello({
            protocol_version: DOOR_PROTOCOL_VERSION,
            soul_pubkey: encodePublicKey(generateKeypair().publicKey)
          })
          .then(
            () => {
              throw new Error("expected door_unavailable");
            },
            (caught: unknown) => caught
          );
        expect(error).toBeInstanceOf(DoorError);
        if (!(error instanceof DoorError)) {
          throw new Error("expected DoorError");
        }
        expect(error.code).toBe("door_unavailable");
        expect(error.message).toBe("bad sig");
        expect(error.httpStatus).toBe(401);
        expect(error.details).toEqual({
          field: "sig",
          unrecognized_code: "bogus"
        });
      }
    );
  });
});
