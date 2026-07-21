import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { screenText } from "../src/index.js";
import type { ScreenCategory } from "../src/types.js";

const CATEGORY_ORDER: readonly ScreenCategory[] = [
  "pii.email",
  "pii.phone",
  "pii.handle",
  "injection.instruction",
  "injection.role_marker",
  "injection.url_payload"
];

const CATEGORY_SET = new Set<string>(CATEGORY_ORDER);

type CorpusCase = {
  text: string;
  expect: "ok" | ScreenCategory[];
};

function sortCategories(categories: readonly ScreenCategory[]): ScreenCategory[] {
  const foundSet = new Set(categories);
  return CATEGORY_ORDER.filter((category) => foundSet.has(category));
}

function isScreenCategory(value: string): value is ScreenCategory {
  return CATEGORY_SET.has(value);
}

function parseCorpusCase(raw: unknown, fileName: string): CorpusCase {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`${fileName}: expected a JSON object`);
  }

  const record = raw as Record<string, unknown>;

  if (typeof record.text !== "string") {
    throw new Error(`${fileName}: "text" must be a string`);
  }

  if (record.expect === "ok") {
    return { text: record.text, expect: "ok" };
  }

  if (!Array.isArray(record.expect)) {
    throw new Error(`${fileName}: "expect" must be "ok" or an array of categories`);
  }

  const categories: ScreenCategory[] = [];
  for (const entry of record.expect) {
    if (typeof entry !== "string" || !isScreenCategory(entry)) {
      throw new Error(`${fileName}: unknown category ${String(entry)}`);
    }
    categories.push(entry);
  }

  return { text: record.text, expect: categories };
}

const corpusDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "corpus");
const corpusFiles = readdirSync(corpusDir)
  .filter((name) => name.endsWith(".json"))
  .sort();

describe("corpus", () => {
  expect(corpusFiles.length).toBeGreaterThanOrEqual(30);

  for (const fileName of corpusFiles) {
    it(fileName, () => {
      const filePath = path.join(corpusDir, fileName);
      const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
      const corpusCase = parseCorpusCase(parsed, fileName);
      const result = screenText(corpusCase.text);

      if (corpusCase.expect === "ok") {
        expect(result).toEqual({ ok: true });
        return;
      }

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(sortCategories(result.categories)).toEqual(sortCategories(corpusCase.expect));
      }
    });
  }
});
