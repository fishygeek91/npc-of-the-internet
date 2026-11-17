import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { describe, expect, it } from "vitest";

import { loadBrainConfig, type OpenAICompatBrainConfig } from "../src/brain/config.js";
import { BrainError } from "../src/brain/errors.js";
import {
  MAX_PROVIDER_RESPONSE_BYTES,
  OpenAICompatBrain
} from "../src/brain/openai-compat-brain.js";

const ENV: NodeJS.ProcessEnv = {
  NPC_BRAIN_PROVIDER: "openai-compat",
  NPC_BRAIN_API_KEY: "sk-test",
  NPC_BRAIN_BASE_URL: "https://example.test/v1",
  NPC_BRAIN_MODEL: "deepseek-v4-flash"
};

function configFor(baseUrl: string): OpenAICompatBrainConfig {
  const loaded = loadBrainConfig({ ...ENV, NPC_BRAIN_BASE_URL: baseUrl });
  if (loaded.provider !== "openai-compat") {
    throw new Error("expected openai-compat config");
  }
  return loaded;
}

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
    await run(`http://127.0.0.1:${String(address.port)}/v1`);
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
  const chunk = Buffer.alloc(Math.min(256 * 1024, total), 0x78);
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

/** Chat-completion JSON whose UTF-8 form is exactly `target` bytes. */
function completionAtCap(target: number): { body: Buffer; contentLength: number } {
  const prefix = Buffer.from('{"choices":[{"message":{"content":"', "utf8");
  const suffix = Buffer.from('"}}],"usage":{"prompt_tokens":1,"completion_tokens":2}}', "utf8");
  const contentLength = target - prefix.length - suffix.length;
  if (contentLength < 1) {
    throw new Error("completion skeleton exceeds the response cap");
  }
  return {
    body: Buffer.concat([prefix, Buffer.alloc(contentLength, 0x61), suffix]),
    contentLength
  };
}

function assertCapError(error: unknown): void {
  expect(error).toBeInstanceOf(BrainError);
  if (!(error instanceof BrainError)) {
    throw new Error("expected BrainError");
  }
  expect(error.reason).toBe("provider");
  expect(error.message).toContain(String(MAX_PROVIDER_RESPONSE_BYTES));
  expect(error.message).not.toContain("sk-test");
  expect(error.message).not.toContain("Authorization");
  const cause = error.cause;
  expect(cause).toBeInstanceOf(Error);
  if (!(cause instanceof Error)) {
    throw new Error("expected Error cause");
  }
  expect(cause.message).toBe("response body exceeds cap");
  expect(Object.keys(cause)).toEqual([]);
  expect("status" in cause).toBe(false);
  expect("headers" in cause).toBe(false);
  expect("body" in cause).toBe(false);
  expect(cause.message).not.toContain("sk-test");
  expect(cause.message).not.toContain("Authorization");
}

describe("OpenAICompatBrain response cap", () => {
  it("rejects a chunked body over the cap before JSON.parse and does not retry", async () => {
    let hits = 0;
    await withHttpServer(
      (_req, res) => {
        hits += 1;
        writeChunked(res, MAX_PROVIDER_RESPONSE_BYTES + 1);
      },
      async (baseUrl) => {
        const brain = new OpenAICompatBrain({
          config: configFor(baseUrl),
          sleep: async () => undefined,
          random: () => 0
        });
        const error = await brain.complete([{ role: "user", content: "hi" }]).then(
          () => {
            throw new Error("expected a cap failure");
          },
          (caught: unknown) => caught
        );
        assertCapError(error);
        expect(hits).toBe(1);
      }
    );
  });

  it("rejects an oversized Content-Length before reading the body", async () => {
    let hits = 0;
    let markClosed = (): void => {};
    const closed = new Promise<void>((resolve) => {
      markClosed = resolve;
    });
    await withHttpServer(
      (req, res) => {
        hits += 1;
        req.on("close", () => markClosed());
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Content-Length": String(MAX_PROVIDER_RESPONSE_BYTES + 1)
        });
        res.flushHeaders();
      },
      async (baseUrl) => {
        const brain = new OpenAICompatBrain({
          config: configFor(baseUrl),
          sleep: async () => undefined,
          random: () => 0
        });
        const error = await brain.complete([{ role: "user", content: "hi" }]).then(
          () => {
            throw new Error("expected a cap failure");
          },
          (caught: unknown) => caught
        );
        assertCapError(error);
        expect(hits).toBe(1);
        await closed;
      }
    );
  });

  it("accepts a completion body of exactly the cap", async () => {
    const fixture = completionAtCap(MAX_PROVIDER_RESPONSE_BYTES);
    await withHttpServer(
      (_req, res) => {
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Content-Length": String(fixture.body.byteLength)
        });
        res.end(fixture.body);
      },
      async (baseUrl) => {
        const brain = new OpenAICompatBrain({
          config: configFor(baseUrl),
          sleep: async () => undefined,
          random: () => 0
        });
        const result = await brain.complete([{ role: "user", content: "hi" }]);
        expect(result.text.length).toBe(fixture.contentLength);
        expect(result.text.charCodeAt(0)).toBe(97);
        expect(result.text.charCodeAt(result.text.length - 1)).toBe(97);
        expect(result.usage).toEqual({ promptTokens: 1, completionTokens: 2 });
      }
    );
  });
});
