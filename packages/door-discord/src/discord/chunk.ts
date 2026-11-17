/** Discord rejects message content longer than 2000 characters. */
export const DISCORD_MESSAGE_MAX_CHARS = 2000;

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/** Best split index in `text[0..limit]`: newline, then space; late boundaries preferred. */
function findSplit(text: string, limit: number): { cut: number; skip: number } {
  const half = Math.floor(limit / 2);
  for (const minIndex of [half, 1]) {
    for (const separator of ["\n", " "]) {
      const index = text.lastIndexOf(separator, limit);
      if (index >= minIndex) {
        return { cut: index, skip: 1 };
      }
    }
  }
  // No boundary: hard split, never between the halves of a surrogate pair.
  const cut = isHighSurrogate(text.charCodeAt(limit - 1)) ? limit - 1 : limit;
  return { cut, skip: 0 };
}

/**
 * Split text into Discord-sized chunks (≤ `limit` UTF-16 units each), preferring
 * newline then space boundaries and never splitting a surrogate pair.
 * Whitespace-only chunks are dropped.
 */
export function chunkDiscordMessage(text: string, limit = DISCORD_MESSAGE_MAX_CHARS): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const { cut, skip } = findSplit(rest, limit);
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut + skip);
  }
  chunks.push(rest);
  return chunks.filter((chunk) => chunk.trim().length > 0);
}

/**
 * Clamp content to `limit` UTF-16 units without splitting a surrogate pair
 * (last-resort guard for host notices; relay text is chunked instead).
 */
export function clampDiscordMessage(text: string, limit = DISCORD_MESSAGE_MAX_CHARS): string {
  if (text.length <= limit) {
    return text;
  }
  const ellipsis = "…";
  let cut = limit - ellipsis.length;
  if (isHighSurrogate(text.charCodeAt(cut - 1))) {
    cut -= 1;
  }
  return `${text.slice(0, cut)}${ellipsis}`;
}
