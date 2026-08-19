import { createServer, type IncomingMessage, type Server } from "node:http";

import { describe, expect, it } from "vitest";

import { loadBrainConfig } from "../src/brain/config.js";
import { createBrain } from "../src/brain/create-brain.js";
import { BrainError } from "../src/brain/errors.js";
import { OpenAICompatBrain } from "../src/brain/openai-compat-brain.js";
import type { OpenAICompatBrainConfig } from "../src/brain/config.js";

const OPENAI_COMPAT_ENV: NodeJS.ProcessEnv = {
  NPC_BRAIN_PROVIDER: "openai-compat",
  NPC_BRAIN_API_KEY: "sk-test",
  NPC_BRAIN_BASE_URL: "https://example.test/v1",
  NPC_BRAIN_MODEL: "deepseek-v4-flash"
};

const OPENROUTER_ENV: NodeJS.ProcessEnv = {
  NPC_BRAIN_PROVIDER: "openai-compat",
  NPC_BRAIN_API_KEY: "sk-test",
  NPC_BRAIN_BASE_URL: "https://openrouter.ai/api/v1",
  NPC_BRAIN_MODEL: "deepseek/deepseek-v4-flash",
  NPC_BRAIN_PROVIDER_ALLOWLIST: "fireworks,together,deepinfra"
};

type StubHandler = (
  req: IncomingMessage,
  body: unknown
) => {
  status: number;
  json?: unknown;
  hang?: boolean;
};

async function readRequestBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function startStub(handler: StubHandler): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const server: Server = createServer((req, res) => {
    void (async () => {
      const raw = await readRequestBody(req);
      let parsed: unknown = undefined;
      if (raw !== "") {
        parsed = JSON.parse(raw);
      }
      const result = handler(req, parsed);
      if (result.hang === true) {
        return;
      }
      res.writeHead(result.status, { "Content-Type": "application/json" });
      res.end(result.json === undefined ? "" : JSON.stringify(result.json));
    })();
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected TCP listen address");
  }

  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => {
          if (error !== undefined && error !== null) {
            reject(error);
            return;
          }
          resolve();
        });
      })
  };
}

function completionPayload(
  text: string,
  usage?: { prompt_tokens: number; completion_tokens: number }
): unknown {
  return {
    choices: [{ message: { content: text } }],
    ...(usage === undefined ? {} : { usage })
  };
}

function openaiCompatConfig(
  baseUrl: string,
  extra?: Partial<OpenAICompatBrainConfig>
): OpenAICompatBrainConfig {
  const loaded = loadBrainConfig({
    ...OPENAI_COMPAT_ENV,
    NPC_BRAIN_BASE_URL: baseUrl
  });
  if (loaded.provider !== "openai-compat") {
    throw new Error("expected openai-compat config");
  }
  return extra === undefined ? loaded : { ...loaded, ...extra };
}

describe("loadBrainConfig openai-compat", () => {
  it("loads openai-compat env without an allowlist for non-OpenRouter URLs", () => {
    const config = loadBrainConfig(OPENAI_COMPAT_ENV);
    expect(config).toEqual({
      provider: "openai-compat",
      apiKey: "sk-test",
      model: "deepseek-v4-flash",
      maxTokens: 1024,
      timeoutMs: 60_000,
      baseUrl: "https://example.test/v1"
    });
  });

  it("requires NPC_BRAIN_MODEL for openai-compat", () => {
    expect(() =>
      loadBrainConfig({
        NPC_BRAIN_PROVIDER: "openai-compat",
        NPC_BRAIN_API_KEY: "sk-test",
        NPC_BRAIN_BASE_URL: "https://example.test/v1"
      })
    ).toThrow(/NPC_BRAIN_MODEL is required/);
  });

  it("requires NPC_BRAIN_API_KEY for openai-compat", () => {
    expect(() =>
      loadBrainConfig({
        NPC_BRAIN_PROVIDER: "openai-compat",
        NPC_BRAIN_BASE_URL: "https://example.test/v1",
        NPC_BRAIN_MODEL: "deepseek-v4-flash"
      })
    ).toThrow(/NPC_BRAIN_API_KEY is required/);
  });

  it("loads fake provider without secrets", () => {
    const config = loadBrainConfig({ NPC_BRAIN_PROVIDER: "fake" });
    expect(config.provider).toBe("fake");
  });

  it("rejects an unknown provider", () => {
    expect(() => loadBrainConfig({ NPC_BRAIN_PROVIDER: "groq" })).toThrow(BrainError);
    expect(() => loadBrainConfig({ NPC_BRAIN_PROVIDER: "groq" })).toThrow(
      /NPC_BRAIN_PROVIDER must be/
    );
  });

  it("requires a non-empty OpenRouter allowlist", () => {
    expect(() =>
      loadBrainConfig({
        NPC_BRAIN_PROVIDER: "openai-compat",
        NPC_BRAIN_API_KEY: "sk-test",
        NPC_BRAIN_BASE_URL: "https://openrouter.ai/api/v1",
        NPC_BRAIN_MODEL: "deepseek/deepseek-v4-flash"
      })
    ).toThrow(/NPC_BRAIN_PROVIDER_ALLOWLIST is required/);

    expect(() =>
      loadBrainConfig({
        ...OPENROUTER_ENV,
        NPC_BRAIN_PROVIDER_ALLOWLIST: "   "
      })
    ).toThrow(/NPC_BRAIN_PROVIDER_ALLOWLIST is required/);
  });

  it("stores the OpenRouter allowlist on config", () => {
    const config = loadBrainConfig(OPENROUTER_ENV);
    expect(config.provider).toBe("openai-compat");
    if (config.provider === "openai-compat") {
      expect(config.providerAllowlist).toEqual(["fireworks", "together", "deepinfra"]);
    }
  });
});

describe("createBrain", () => {
  it("throws for fake provider", () => {
    const config = loadBrainConfig({ NPC_BRAIN_PROVIDER: "fake" });
    expect(() => createBrain(config)).toThrow(/not valid for production/);
  });
});

describe("OpenAICompatBrain", () => {
  it("posts chat completions and returns text plus usage", async () => {
    const stub = await startStub((_req, body) => {
      expect(body).toMatchObject({
        model: "deepseek-v4-flash",
        messages: [
          { role: "system", content: "Be brief." },
          { role: "user", content: "hi" }
        ],
        max_tokens: 1024
      });
      expect(body).not.toHaveProperty("temperature");
      expect(body).not.toHaveProperty("provider");
      return {
        status: 200,
        json: completionPayload("hello back", { prompt_tokens: 10, completion_tokens: 4 })
      };
    });

    try {
      const config = openaiCompatConfig(stub.baseUrl);
      const brain = new OpenAICompatBrain({
        config,
        sleep: async () => undefined,
        random: () => 0
      });
      const result = await brain.complete([
        { role: "system", content: "Be brief." },
        { role: "user", content: "hi" }
      ]);
      expect(result).toEqual({
        text: "hello back",
        usage: { promptTokens: 10, completionTokens: 4 }
      });
    } finally {
      await stub.close();
    }
  });

  it("sends provider.only matching the OpenRouter allowlist on every request", async () => {
    const loaded = loadBrainConfig(OPENROUTER_ENV);
    if (loaded.provider !== "openai-compat") {
      throw new Error("expected openai-compat");
    }

    let seen = 0;
    const stub = await startStub((_req, body) => {
      seen += 1;
      expect(body).toMatchObject({
        provider: { only: ["fireworks", "together", "deepinfra"] }
      });
      return { status: 200, json: completionPayload("ok") };
    });

    try {
      const config = { ...loaded, baseUrl: stub.baseUrl };
      const brain = new OpenAICompatBrain({
        config,
        sleep: async () => undefined,
        random: () => 0
      });
      await brain.complete([{ role: "user", content: "one" }]);
      await brain.complete([{ role: "user", content: "two" }]);
      expect(seen).toBe(2);
    } finally {
      await stub.close();
    }
  });

  it("maps 401 to auth and does not retry", async () => {
    let hits = 0;
    const stub = await startStub(() => {
      hits += 1;
      return { status: 401, json: { error: { message: "nope" } } };
    });
    try {
      const brain = new OpenAICompatBrain({
        config: openaiCompatConfig(stub.baseUrl),
        sleep: async () => undefined,
        random: () => 0
      });
      await expect(brain.complete([{ role: "user", content: "hi" }])).rejects.toMatchObject({
        reason: "auth",
        cause: { status: 401, body: '{"error":{"message":"nope"}}' }
      });
      expect(hits).toBe(1);
    } finally {
      await stub.close();
    }
  });

  it("maps 402 to credit_exhausted and does not retry", async () => {
    let hits = 0;
    const stub = await startStub(() => {
      hits += 1;
      return { status: 402, json: { error: { message: "credits" } } };
    });
    try {
      const brain = new OpenAICompatBrain({
        config: openaiCompatConfig(stub.baseUrl),
        sleep: async () => undefined,
        random: () => 0
      });
      await expect(brain.complete([{ role: "user", content: "hi" }])).rejects.toMatchObject({
        reason: "credit_exhausted"
      });
      expect(hits).toBe(1);
    } finally {
      await stub.close();
    }
  });

  it("maps 429 insufficient_quota to credit_exhausted and does not retry", async () => {
    let hits = 0;
    const stub = await startStub(() => {
      hits += 1;
      return {
        status: 429,
        json: { error: { code: "insufficient_quota" } }
      };
    });
    try {
      const brain = new OpenAICompatBrain({
        config: openaiCompatConfig(stub.baseUrl),
        sleep: async () => undefined,
        random: () => 0
      });
      await expect(brain.complete([{ role: "user", content: "hi" }])).rejects.toMatchObject({
        reason: "credit_exhausted"
      });
      expect(hits).toBe(1);
    } finally {
      await stub.close();
    }
  });

  it("retries 429 twice then succeeds", async () => {
    let hits = 0;
    const stub = await startStub(() => {
      hits += 1;
      if (hits < 3) {
        return { status: 429, json: { error: { message: "slow down" } } };
      }
      return { status: 200, json: completionPayload("recovered") };
    });
    try {
      const brain = new OpenAICompatBrain({
        config: openaiCompatConfig(stub.baseUrl),
        sleep: async () => undefined,
        random: () => 0
      });
      const result = await brain.complete([{ role: "user", content: "hi" }]);
      expect(result.text).toBe("recovered");
      expect(hits).toBe(3);
    } finally {
      await stub.close();
    }
  });

  it("retries 5xx then maps a persistent failure to unavailable", async () => {
    let hits = 0;
    const stub = await startStub(() => {
      hits += 1;
      return { status: 503, json: { error: { message: "down" } } };
    });
    try {
      const brain = new OpenAICompatBrain({
        config: openaiCompatConfig(stub.baseUrl),
        sleep: async () => undefined,
        random: () => 0
      });
      await expect(brain.complete([{ role: "user", content: "hi" }])).rejects.toMatchObject({
        reason: "unavailable"
      });
      expect(hits).toBe(3);
    } finally {
      await stub.close();
    }
  });

  it("times out when the server does not respond", async () => {
    const stub = await startStub(() => ({ status: 200, hang: true }));
    try {
      const loaded = loadBrainConfig({
        ...OPENAI_COMPAT_ENV,
        NPC_BRAIN_BASE_URL: stub.baseUrl,
        NPC_BRAIN_TIMEOUT_MS: "50"
      });
      if (loaded.provider !== "openai-compat") {
        throw new Error("expected openai-compat");
      }
      const brain = new OpenAICompatBrain({
        config: loaded,
        sleep: async () => undefined,
        random: () => 0
      });
      await expect(brain.complete([{ role: "user", content: "hi" }])).rejects.toMatchObject({
        reason: "timeout"
      });
    } finally {
      await stub.close();
    }
  });

  it("rejects construction when config is not openai-compat", () => {
    const config = loadBrainConfig({ ANTHROPIC_API_KEY: "sk-test" });
    expect(() => new OpenAICompatBrain({ config })).toThrow(BrainError);
  });
});
