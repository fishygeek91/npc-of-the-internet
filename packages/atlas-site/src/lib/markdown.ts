import { marked, Renderer, type Tokens } from "marked";

/**
 * Escape text so it is safe to embed in an HTML text node / attribute context.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * True when a URL scheme is unsafe for journal-rendered links/images.
 * Journals are LLM-distilled prose — a signature proves authorship, not safety.
 */
function isDangerousUrl(href: string): boolean {
  const trimmed = href.trim();
  if (trimmed.length === 0) {
    return true;
  }
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(trimmed);
  if (schemeMatch === null) {
    return false;
  }
  const scheme = schemeMatch[1]?.toLowerCase();
  return scheme === "javascript" || scheme === "data" || scheme === "vbscript";
}

/**
 * Marked renderer that escapes raw HTML and strips dangerous URL schemes.
 */
class JournalRenderer extends Renderer {
  /** Escape raw HTML tokens instead of passing them through to `set:html`. */
  override html({ text }: Tokens.HTML | Tokens.Tag): string {
    return escapeHtml(text);
  }

  /** Render markdown links; neutralize dangerous href schemes. */
  override link({ href, title, tokens }: Tokens.Link): string {
    const content = this.parser.parseInline(tokens);
    if (isDangerousUrl(href)) {
      return content;
    }
    const titleAttr = title === undefined || title === "" ? "" : ` title="${escapeHtml(title)}"`;
    return `<a href="${escapeHtml(href)}"${titleAttr}>${content}</a>`;
  }

  /** Render markdown images; neutralize dangerous src schemes. */
  override image({ href, title, text }: Tokens.Image): string {
    if (isDangerousUrl(href)) {
      return escapeHtml(text);
    }
    const titleAttr = title === undefined || title === "" ? "" : ` title="${escapeHtml(title)}"`;
    return `<img src="${escapeHtml(href)}" alt="${escapeHtml(text)}"${titleAttr}>`;
  }
}

const journalRenderer = new JournalRenderer();

/**
 * Render journal markdown to HTML for static pages.
 *
 * Raw HTML in the source is escaped (journals do not need inline HTML).
 * Dangerous URL schemes in links/images are stripped. A soulchain signature
 * proves the soul signed the text; it does not prove the text is safe to
 * inject into a browser.
 *
 * @throws {Error} when marked returns a non-string result.
 */
export function renderJournalHtml(markdown: string): string {
  const rendered = marked.parse(markdown, { async: false, renderer: journalRenderer });
  if (typeof rendered !== "string") {
    throw new Error("marked.parse returned a non-string result for a journal");
  }
  return rendered;
}
