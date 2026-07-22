import { marked } from "marked";

/**
 * Render journal markdown to HTML for static pages.
 *
 * Output is not sanitized — `marked` may pass through raw HTML. Callers inject
 * the result with `set:html`. Journal text comes from the signed soulchain;
 * chain authors are trusted. Revisit sanitization before hosting untrusted chains.
 *
 * @throws {Error} when marked returns a non-string result.
 */
export function renderJournalHtml(markdown: string): string {
  const rendered = marked.parse(markdown, { async: false });
  if (typeof rendered !== "string") {
    throw new Error("marked.parse returned a non-string result for a journal");
  }
  return rendered;
}
