import { marked } from "marked";

/**
 * Render journal markdown to safe HTML for static pages.
 * @throws {Error} when marked returns a non-string result.
 */
export function renderJournalHtml(markdown: string): string {
  const rendered = marked.parse(markdown, { async: false });
  if (typeof rendered !== "string") {
    throw new Error("marked.parse returned a non-string result for a journal");
  }
  return rendered;
}
