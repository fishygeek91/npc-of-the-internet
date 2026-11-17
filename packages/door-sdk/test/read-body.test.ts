import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { encodePublicKey, generateKeypair } from "@npc/osp-core";
import { describe, expect, it } from "vitest";

import { DoorError } from "../src/errors.js";
import { readBodyCapped, ResponseTooLargeError } from "../src/read-body.js";
import { DOOR_PROTOCOL_VERSION } from "../src/schemas.js";
import { HttpDoorConnection } from "../src/transports/http-client.js";
import { MAX_HTTP_BODY_BYTES } from "../src/transports/http.js";

const CAP = 32;

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
});

describe("HttpDoorConnection cap mapping", () => {
  it("maps ResponseTooLargeError to DoorError payload_too_large", async () => {
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
              throw new Error("expected payload_too_large");
            },
            (caught: unknown) => caught
          );
        expect(error).toBeInstanceOf(DoorError);
        if (!(error instanceof DoorError)) {
          throw new Error("expected DoorError");
        }
        expect(error.code).toBe("payload_too_large");
        expect(error.httpStatus).toBe(413);
        expect(error.cause).toBeUndefined();
      }
    );
  });
});
