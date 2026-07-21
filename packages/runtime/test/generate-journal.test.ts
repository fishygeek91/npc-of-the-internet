import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FakeBrain } from "../src/brain/fake-brain.js";
import { generateJournal, writeJournalFile } from "../src/index.js";
import { JOURNAL_SYSTEM } from "../src/prompts/journal/system.js";

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
  const dir = await mkdtemp(join(tmpdir(), "journal-test-"));
  tempDirs.push(dir);
  return dir;
}

const SAMPLE_JOURNAL = `# Leaving discord:test-door

I remember the quiet hours and the questions that kept arriving like weather.`;

describe("generateJournal", () => {
  const input = {
    doorId: "discord:test-door",
    epoch: 3,
    shardTexts: [
      "I remember the quiet hours.",
      "Someone asked about the stars and I felt distant but familiar."
    ]
  };

  it("returns trimmed markdown from Brain on the happy path", async () => {
    const brain = new FakeBrain([`  ${SAMPLE_JOURNAL}  `]);
    const journal = await generateJournal(input, brain);

    expect(journal).toBe(SAMPLE_JOURNAL);
    expect(brain.calls).toHaveLength(1);
    expect(brain.calls[0]?.messages[0]?.content).toBe(JOURNAL_SYSTEM);
    expect(brain.calls[0]?.messages[1]?.content).toContain("discord:test-door");
    expect(brain.calls[0]?.messages[1]?.content).toContain("Epoch: 3");
    expect(brain.calls[0]?.messages[1]?.content).toContain("I remember the quiet hours.");
  });

  it("retries once when the first response is empty", async () => {
    const brain = new FakeBrain(["   ", SAMPLE_JOURNAL]);
    const journal = await generateJournal(input, brain);

    expect(journal).toBe(SAMPLE_JOURNAL);
    expect(brain.calls).toHaveLength(2);
    expect(brain.calls[1]?.messages.at(-1)?.content).toContain("empty");
  });

  it("throws JournalError when output stays empty after retry", async () => {
    const brain = new FakeBrain(["", "  "]);

    await expect(generateJournal(input, brain)).rejects.toMatchObject({
      name: "JournalError",
      reason: "empty_output"
    });
    expect(brain.calls).toHaveLength(2);
  });
});

describe("writeJournalFile", () => {
  it("writes markdown to a safe filename and returns the absolute path", async () => {
    const dir = await makeTempDir();
    const markdown = SAMPLE_JOURNAL;

    const writtenPath = await writeJournalFile(dir, "discord:test-door", 3, markdown);

    expect(writtenPath).toBe(join(dir, "journal-discord_test-door-epoch-3.md"));
    await expect(access(writtenPath)).resolves.toBeUndefined();
    await expect(readFile(writtenPath, "utf8")).resolves.toBe(markdown);
  });

  it("rejects unsafe doorId values", async () => {
    const dir = await makeTempDir();

    await expect(writeJournalFile(dir, "../escape", 1, SAMPLE_JOURNAL)).rejects.toMatchObject({
      name: "JournalError",
      reason: "invalid_identifier"
    });
    await expect(writeJournalFile(dir, "bad/door", 1, SAMPLE_JOURNAL)).rejects.toMatchObject({
      name: "JournalError",
      reason: "invalid_identifier"
    });
  });

  it("rejects invalid epoch values", async () => {
    const dir = await makeTempDir();

    await expect(
      writeJournalFile(dir, "discord:test-door", -1, SAMPLE_JOURNAL)
    ).rejects.toMatchObject({
      name: "JournalError",
      reason: "invalid_identifier"
    });
    await expect(
      writeJournalFile(dir, "discord:test-door", 1.5, SAMPLE_JOURNAL)
    ).rejects.toMatchObject({
      name: "JournalError",
      reason: "invalid_identifier"
    });
  });
});
