import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DistillError } from "../src/distill/errors.js";
import { FileTranscriptSource } from "../src/distill/file-transcript-source.js";

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
  const dir = await mkdtemp(join(tmpdir(), "file-transcript-"));
  tempDirs.push(dir);
  return dir;
}

describe("FileTranscriptSource", () => {
  it("rejects paths containing a .. segment", () => {
    expect(() => new FileTranscriptSource("../transcript.jsonl")).toThrow(DistillError);
    try {
      new FileTranscriptSource("../transcript.jsonl");
    } catch (error) {
      expect(error).toBeInstanceOf(DistillError);
      if (error instanceof DistillError) {
        expect(error.reason).toBe("invalid_transcript");
      }
    }
  });

  it("rejects unsafe basenames", () => {
    expect(() => new FileTranscriptSource("/tmp/transcript with spaces.jsonl")).toThrow(
      DistillError
    );
  });

  it("throws invalid_transcript with line number on malformed JSON", async () => {
    const dir = await makeTempDir();
    const filePath = join(dir, "transcript.jsonl");
    await writeFile(
      filePath,
      '{"role":"user","text":"ok"}\n{not-json\n{"role":"assistant","text":"later"}\n',
      "utf8"
    );
    const source = new FileTranscriptSource(filePath);

    await expect(source.read()).rejects.toSatisfy((error: unknown) => {
      return (
        error instanceof DistillError &&
        error.reason === "invalid_transcript" &&
        error.message.includes("line 2")
      );
    });
  });

  it("rejects transcript lines with extra keys under strict schema", async () => {
    const dir = await makeTempDir();
    const filePath = join(dir, "transcript.jsonl");
    await writeFile(
      filePath,
      JSON.stringify({ role: "user", text: "hello", unexpected: true }) + "\n",
      "utf8"
    );
    const source = new FileTranscriptSource(filePath);

    await expect(source.read()).rejects.toSatisfy((error: unknown) => {
      return error instanceof DistillError && error.reason === "invalid_transcript";
    });
  });

  it("destroy is idempotent when the file is already gone", async () => {
    const dir = await makeTempDir();
    const filePath = join(dir, "transcript.jsonl");
    await writeFile(filePath, '{"role":"user","text":"hi"}\n', "utf8");
    const source = new FileTranscriptSource(filePath);

    await source.destroy();
    await expect(access(filePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(source.destroy()).resolves.toBeUndefined();
  });
});
