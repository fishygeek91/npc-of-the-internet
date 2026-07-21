import type { Brain, BrainMessage } from "../brain/types.js";
import { JOURNAL_RETRY } from "../prompts/journal/retry.js";
import { JOURNAL_SYSTEM } from "../prompts/journal/system.js";
import { JournalError } from "./errors.js";

function buildUserContent(input: {
  doorId: string;
  epoch: number;
  shardTexts: readonly string[];
}): string {
  const shardLines = input.shardTexts
    .map((text, index) => `${String(index + 1)}. ${text}`)
    .join("\n");

  return `Residency door_id: ${input.doorId}
Epoch: ${String(input.epoch)}

Memory shards from this residency:
${shardLines}

Write your residency journal in markdown.`;
}

function buildMessages(userContent: string): BrainMessage[] {
  return [
    { role: "system", content: JOURNAL_SYSTEM },
    { role: "user", content: userContent }
  ];
}

function validateMarkdown(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new JournalError("journal output is empty", "empty_output");
  }
  return trimmed;
}

async function completeWithRetry(
  brain: Brain,
  userContent: string,
  initialRaw: string
): Promise<string> {
  try {
    return validateMarkdown(initialRaw);
  } catch (error: unknown) {
    if (!(error instanceof JournalError) || error.reason !== "empty_output") {
      throw error;
    }

    const retryMessages: BrainMessage[] = [
      { role: "system", content: JOURNAL_SYSTEM },
      { role: "user", content: userContent },
      { role: "assistant", content: initialRaw },
      { role: "user", content: JOURNAL_RETRY }
    ];

    const retryRaw = await brain.complete(retryMessages);
    try {
      return validateMarkdown(retryRaw);
    } catch (retryError: unknown) {
      if (retryError instanceof JournalError && retryError.reason === "empty_output") {
        throw new JournalError("journal output is empty after retry", "empty_output");
      }
      throw retryError;
    }
  }
}

/**
 * Generate a markdown residency journal from distilled memory shards via Brain.
 */
export async function generateJournal(
  input: { doorId: string; epoch: number; shardTexts: readonly string[] },
  brain: Brain
): Promise<string> {
  const userContent = buildUserContent(input);
  const messages = buildMessages(userContent);
  const raw = await brain.complete(messages);
  return completeWithRetry(brain, userContent, raw);
}
