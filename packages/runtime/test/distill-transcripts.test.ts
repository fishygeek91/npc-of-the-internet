import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FakeBrain } from "../src/brain/fake-brain.js";
import { distillTranscripts, DistillError, FileTranscriptSource } from "../src/index.js";
import type { PiiCategory, TranscriptLine } from "../src/index.js";

const PII_CATEGORIES: readonly PiiCategory[] = ["email", "phone", "handle"];

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir === undefined) {
      continue;
    }
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "distill-test-"));
  tempDirs.push(dir);
  return dir;
}

function nShards(count: number): string[] {
  return Array.from(
    { length: count },
    (_, index) => `I remember feeling curious about topic ${String(index + 1)}.`
  );
}

function shardsJson(texts: readonly string[]): string {
  return JSON.stringify({ shards: texts.map((text) => ({ text })) });
}

async function writeTranscript(
  dir: string,
  lines: readonly TranscriptLine[]
): Promise<FileTranscriptSource> {
  const filePath = join(dir, "transcript.jsonl");
  const content = lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
  await writeFile(filePath, content, "utf8");
  return new FileTranscriptSource(filePath);
}

async function expectFileDestroyed(filePath: string): Promise<void> {
  await expect(access(filePath)).rejects.toMatchObject({ code: "ENOENT" });
}

async function expectFileRetained(filePath: string): Promise<void> {
  await expect(access(filePath)).resolves.toBeUndefined();
}

function collectPiiRejectSpy(): {
  onPiiReject: (category: PiiCategory) => void;
  categories: PiiCategory[];
} {
  const categories: PiiCategory[] = [];
  const onPiiReject = (category: PiiCategory): void => {
    expect(typeof category).toBe("string");
    expect(PII_CATEGORIES).toContain(category);
    categories.push(category);
  };
  return { onPiiReject, categories };
}

describe("distillTranscripts", () => {
  const sampleLines: TranscriptLine[] = [
    { role: "user", text: "What do you think about the stars?" },
    { role: "assistant", text: "They feel distant but familiar." }
  ];

  it("returns shard-1 through shard-5 on the happy path and destroys the transcript", async () => {
    const dir = await makeTempDir();
    const source = await writeTranscript(dir, sampleLines);
    const texts = nShards(5);
    const brain = new FakeBrain([shardsJson(texts)]);

    const result = await distillTranscripts(source, brain);

    expect(result).toHaveLength(5);
    for (let index = 0; index < result.length; index += 1) {
      const shard = result[index];
      const expectedText = texts[index];
      if (shard === undefined || expectedText === undefined) {
        throw new Error("expected shard and matching text");
      }
      expect(shard.shard_id).toBe(`shard-${String(index + 1)}`);
      expect(shard.text).toBe(expectedText);
    }
    await expectFileDestroyed(source.path);
    expect(brain.calls).toHaveLength(1);
  });

  it("retains the transcript when the brain returns too few shards", async () => {
    const dir = await makeTempDir();
    const source = await writeTranscript(dir, sampleLines);
    const brain = new FakeBrain([shardsJson(nShards(2))]);

    let caught: unknown;
    try {
      await distillTranscripts(source, brain);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(DistillError);
    if (!(caught instanceof DistillError)) {
      throw new Error("expected DistillError");
    }
    expect(caught.reason).toBe("too_few_shards");
    await expectFileRetained(source.path);
  });

  it("drops shards longer than 500 code points but keeps five usable shards", async () => {
    const dir = await makeTempDir();
    const source = await writeTranscript(dir, sampleLines);
    const texts = [...nShards(5), "a".repeat(501)];
    const brain = new FakeBrain([shardsJson(texts)]);

    const result = await distillTranscripts(source, brain);

    expect(result).toHaveLength(5);
    expect(result.map((shard) => shard.text)).toEqual(texts.slice(0, 5));
    await expectFileDestroyed(source.path);
  });

  it("throws too_few_shards when length filtering leaves fewer than five shards", async () => {
    const dir = await makeTempDir();
    const source = await writeTranscript(dir, sampleLines);
    const texts = [...nShards(4), "a".repeat(501)];
    const brain = new FakeBrain([shardsJson(texts)]);

    let caught: unknown;
    try {
      await distillTranscripts(source, brain);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(DistillError);
    if (!(caught instanceof DistillError)) {
      throw new Error("expected DistillError");
    }
    expect(caught.reason).toBe("too_few_shards");
    await expectFileRetained(source.path);
  });

  it("drops PII shards but succeeds when five clean shards remain", async () => {
    const dir = await makeTempDir();
    const source = await writeTranscript(dir, sampleLines);
    const texts = [
      ...nShards(5),
      "I once wrote to user@example.com about the journey.",
      "They called me at +1 (555) 123-4567 once."
    ];
    const brain = new FakeBrain([shardsJson(texts)]);
    const { onPiiReject, categories } = collectPiiRejectSpy();

    const result = await distillTranscripts(source, brain, { onPiiReject });

    expect(result).toHaveLength(5);
    expect(result.map((shard) => shard.text)).toEqual(texts.slice(0, 5));
    expect(categories).toEqual(["email", "phone"]);
    await expectFileDestroyed(source.path);
  });

  it("throws pii_screen when PII drops leave fewer than five shards", async () => {
    const dir = await makeTempDir();
    const source = await writeTranscript(dir, sampleLines);
    const texts = [...nShards(4), "Reach me at user@example.com anytime."];
    const brain = new FakeBrain([shardsJson(texts)]);
    const { onPiiReject, categories } = collectPiiRejectSpy();

    let caught: unknown;
    try {
      await distillTranscripts(source, brain, { onPiiReject });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(DistillError);
    if (!(caught instanceof DistillError)) {
      throw new Error("expected DistillError");
    }
    expect(caught.reason).toBe("pii_screen");
    expect(caught.categories).toEqual(["email"]);
    expect(categories).toEqual(["email"]);
    await expectFileRetained(source.path);
  });

  it("retries malformed output and succeeds on the second brain response", async () => {
    const dir = await makeTempDir();
    const source = await writeTranscript(dir, sampleLines);
    const texts = nShards(5);
    const brain = new FakeBrain(["not json", shardsJson(texts)]);

    const result = await distillTranscripts(source, brain);

    expect(result).toHaveLength(5);
    expect(brain.calls).toHaveLength(2);
    expect(brain.calls[1]?.messages).toHaveLength(4);
    expect(brain.calls[1]?.messages.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "user"
    ]);
    await expectFileDestroyed(source.path);
  });

  it("retains the transcript when malformed output persists after retry", async () => {
    const dir = await makeTempDir();
    const source = await writeTranscript(dir, sampleLines);
    const brain = new FakeBrain(["nope", "still nope"]);

    let caught: unknown;
    try {
      await distillTranscripts(source, brain);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(DistillError);
    if (!(caught instanceof DistillError)) {
      throw new Error("expected DistillError");
    }
    expect(caught.reason).toBe("malformed_output");
    expect(brain.calls).toHaveLength(2);
    await expectFileRetained(source.path);
  });

  it("clamps more than twenty valid shards to shard-1 through shard-20", async () => {
    const dir = await makeTempDir();
    const source = await writeTranscript(dir, sampleLines);
    const texts = nShards(22);
    const brain = new FakeBrain([shardsJson(texts)]);

    const result = await distillTranscripts(source, brain);

    expect(result).toHaveLength(20);
    for (let index = 0; index < result.length; index += 1) {
      const shard = result[index];
      const expectedText = texts[index];
      if (shard === undefined || expectedText === undefined) {
        throw new Error("expected shard and matching text");
      }
      expect(shard.shard_id).toBe(`shard-${String(index + 1)}`);
      expect(shard.text).toBe(expectedText);
    }
    await expectFileDestroyed(source.path);
  });

  it("keeps allowlisted handles when piiAllowlist includes the handle", async () => {
    const dir = await makeTempDir();
    const source = await writeTranscript(dir, sampleLines);
    const allowedHandle = "@allowed_bot";
    const texts = [`I enjoyed talking with ${allowedHandle} about the road.`, ...nShards(4)];
    const brain = new FakeBrain([shardsJson(texts)]);

    const result = await distillTranscripts(source, brain, {
      piiAllowlist: [allowedHandle]
    });

    expect(result).toHaveLength(5);
    expect(result[0]?.text).toContain(allowedHandle);
    await expectFileDestroyed(source.path);
  });

  it("does not treat ISO dates or year ranges as phone PII", async () => {
    const dir = await makeTempDir();
    const source = await writeTranscript(dir, sampleLines);
    const texts = [
      "I arrived on 2026-07-21 and the room felt quiet.",
      "We talked about the 2020-2021 season of leaving.",
      ...nShards(3)
    ];
    const brain = new FakeBrain([shardsJson(texts)]);
    const { onPiiReject, categories } = collectPiiRejectSpy();

    const result = await distillTranscripts(source, brain, { onPiiReject });

    expect(result).toHaveLength(5);
    expect(result[0]?.text).toContain("2026-07-21");
    expect(result[1]?.text).toContain("2020-2021");
    expect(categories).toEqual([]);
    await expectFileDestroyed(source.path);
  });

  it("does not allowlist a different address via substring prefix", async () => {
    const dir = await makeTempDir();
    const source = await writeTranscript(dir, sampleLines);
    const texts = [...nShards(4), "I once wrote to user@example.com about the journey."];
    const brain = new FakeBrain([shardsJson(texts)]);
    const { onPiiReject, categories } = collectPiiRejectSpy();

    let caught: unknown;
    try {
      await distillTranscripts(source, brain, {
        piiAllowlist: ["user@example.company"],
        onPiiReject
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(DistillError);
    if (!(caught instanceof DistillError)) {
      throw new Error("expected DistillError");
    }
    expect(caught.reason).toBe("pii_screen");
    expect(categories).toEqual(["email"]);
    await expectFileRetained(source.path);
  });
});
