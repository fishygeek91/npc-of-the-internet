import type { MemoryIndexEntry } from "../../src/compose/compose-self.js";

/**
 * Serialize a memory index for golden files and byte-identical test comparison.
 * Object keys are emitted in fixed order: cid, seq, text.
 */
export function serializeMemoryIndex(index: readonly MemoryIndexEntry[]): string {
  const rows = index.map((entry) => ({
    cid: entry.cid,
    seq: entry.seq,
    text: entry.text
  }));
  return `${JSON.stringify(rows, null, 2)}\n`;
}
