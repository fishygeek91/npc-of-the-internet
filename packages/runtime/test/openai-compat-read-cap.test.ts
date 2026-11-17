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
  NPC_BRAIN_MODEL: "deepseek-v4-flash",
  NPC_BRAIN_TIMEOUT_MS: "2000"
};

function configFor(baseUrl: string): OpenAICompatBrainConfig {
  const loaded = loadBrainConfig({ ...ENV, NPC_BRAIN_BASE_URL: baseUrl });
  if (loaded.provider !== "openai-compat") {
    throw new Error("expected openai-compat config");
  }
  return loaded;
}

function brain(baseUrl: string): OpenAICompatBrain {
  return new OpenAICompatBrain({
    config: configFor(baseUrl),
    sleep: async () => undefined,
    random: () => 0
  });
}

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
    await run(`http://127.0.0.1:${String(address.port)}/v1`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
}

/** Chat-completion JSON whose UTF-8 form is exactly `target` bytes. */
function completionAtCap(target: number): Buffer {
  const prefix = Buffer.from('{"choices":[{"message":{"content":"', "utf8");
  const suffix = Buffer.from('"}}],"usage":{"prompt_tokens":1,"completion_tokens":2}}', "utf8");
  const pad = target - prefix.length - suffix.length;
  if (pad < 1) {
    throw new Error("completion skeleton exceeds the response cap");
  }
  return Buffer.concat([prefix, Buffer.alloc(pad, 0x61), suffix]);
}

describe("OpenAICompatBrain response cap", () => {
  it("maps an oversized body to BrainError provider and does not retry", async () => {
    let hits = 0;
    await withServer(
      (_req, res) => {
        hits += 1;
        res.writeHead(200, { "Content-Length": String(MAX_PROVIDER_RESPONSE_BYTES + 1) });
        res.flushHeaders();
      },
      async (baseUrl) => {
        const error = await brain(baseUrl)
          .complete([{ role: "user", content: "hi" }])
          .then(
            () => {
              throw new Error("expected a cap failure");
            },
            (caught: unknown) => caught
          );
        expect(error).toBeInstanceOf(BrainError);
        if (!(error instanceof BrainError)) {
          throw new Error("expected BrainError");
        }
        expect(error.reason).toBe("provider");
        expect(error.message).toContain(String(MAX_PROVIDER_RESPONSE_BYTES));
        expect(error.message).not.toContain("sk-test");
        const cause = error.cause;
        expect(cause).toBeInstanceOf(Error);
        if (!(cause instanceof Error)) {
          throw new Error("expected Error cause");
        }
        expect(cause.message).toBe("response body exceeds cap");
        expect(Object.keys(cause)).toEqual([]);
        expect(cause.message).not.toContain("sk-test");
        expect(cause.message).not.toContain("Authorization");
        expect(hits).toBe(1);
      }
    );
  });

  it("accepts a completion body of exactly the cap", async () => {
    const body = completionAtCap(MAX_PROVIDER_RESPONSE_BYTES);
    await withServer(
      (_req, res) => {
        res.writeHead(200, { "Content-Length": String(body.byteLength) });
        res.end(body);
      },
      async (baseUrl) => {
        const result = await brain(baseUrl).complete([{ role: "user", content: "hi" }]);
        expect(result.text.charCodeAt(0)).toBe(97);
        expect(result.usage).toEqual({ promptTokens: 1, completionTokens: 2 });
      }
    );
  });
});
