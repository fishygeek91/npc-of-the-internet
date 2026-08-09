import {
  StorageError,
  computeCid,
  decodeShardTextBlob,
  verifyRecords,
  type OspRecord,
  type SoulStore
} from "@npc/osp-core";

import { ComposeError } from "./errors.js";
import { SYSTEM_TEMPLATE } from "../prompts/composer/system.js";

/** One committed shard entry in the composed memory index. */
export type MemoryIndexEntry = { cid: string; seq: number; text: string };

/** Result of composing a verified soulchain into a system prompt and shard index. */
export type ComposedSelf = { systemPrompt: string; memoryIndex: MemoryIndexEntry[] };

/** Options for {@link composeSelf}; door keys are verification-only inputs. */
export type ComposeSelfOptions = { doorPublicKeys?: Readonly<Record<string, Uint8Array>> };

type Section = "charter" | "drifts" | "shards";

/** Fixed sentinel when a list section has no items (readable goldens, deterministic). */
const EMPTY_SECTION = "(none yet)";

/**
 * Visible marker for a tombstoned (or missing-after-erasure) shard.
 * Must never silently omit the shard from composition.
 */
export function erasedMemoryMarker(reason: string): string {
  return `[memory erased: ${reason}]`;
}

/**
 * Render the system prompt by substituting template placeholders in a single pass.
 * Replacer-function form keeps `$&` / `{{...}}` in chain content inert.
 */
function renderSystemPrompt(sections: Record<Section, string>): string {
  return SYSTEM_TEMPLATE.replaceAll(
    /\{\{(charter|drifts|shards)\}\}/g,
    (_match, key: Section): string => sections[key]
  );
}

function joinSection(items: readonly string[]): string {
  return items.length === 0 ? EMPTY_SECTION : items.join("\n");
}

/** Collect blob_cid → tombstone reason for erased side blobs. */
function collectTombstoneReasons(records: readonly OspRecord[]): Map<string, string> {
  const reasons = new Map<string, string>();
  for (const record of records) {
    if (record.type === "tombstone") {
      reasons.set(record.body.blob_cid, record.body.reason);
    }
  }
  return reasons;
}

/**
 * Resolve shard display text for composition (inline osp/0.1 or side-blob osp/0.2).
 */
async function resolveShardText(
  store: SoulStore,
  body: Extract<OspRecord, { type: "memory" }>["body"] & { kind: "shard" },
  tombstones: ReadonlyMap<string, string>
): Promise<string> {
  if ("text" in body) {
    return body.text;
  }

  const erasedReason = tombstones.get(body.text_cid);
  if (erasedReason !== undefined) {
    return erasedMemoryMarker(erasedReason);
  }

  try {
    const bytes = await store.getSideBlob(body.text_cid);
    return decodeShardTextBlob(bytes);
  } catch (error) {
    if (error instanceof StorageError) {
      // Missing blob without a tombstone — still surface a visible marker (availability).
      return erasedMemoryMarker("unavailable");
    }
    throw error;
  }
}

/**
 * Project a verified soulchain into the Wanderer's system prompt and shard memory index.
 *
 * Materializes the chain once, verifies that snapshot, then composes from the same array
 * (no second iterate). Door public keys affect verification only, not prompt content.
 */
export async function composeSelf(
  store: SoulStore,
  options?: ComposeSelfOptions
): Promise<ComposedSelf> {
  const records: OspRecord[] = [];
  for await (const record of store.iterate()) {
    records.push(record);
  }

  const doorPublicKeys = options?.doorPublicKeys;
  const result = await verifyRecords(
    records,
    doorPublicKeys === undefined ? undefined : { doorPublicKeys }
  );
  if (!result.valid) {
    throw new ComposeError("cannot compose self from an invalid soulchain", result.failures);
  }

  // Retain verifyChain's store-head cross-check against the verified snapshot head.
  const storeHead = await store.head();
  if (
    result.head !== null &&
    storeHead !== null &&
    (storeHead.cid !== result.head.cid || storeHead.seq !== result.head.seq)
  ) {
    throw new ComposeError("cannot compose self from an invalid soulchain", [
      {
        seq: storeHead.seq,
        cid: storeHead.cid,
        rule: "forked_head",
        message: "store head does not match verified chain head"
      }
    ]);
  }

  const tombstones = collectTombstoneReasons(records);

  let charter: string | undefined;
  const driftSummaries: string[] = [];
  const shardTexts: string[] = [];
  const memoryIndex: MemoryIndexEntry[] = [];

  for (const record of records) {
    switch (record.type) {
      case "genesis":
        charter = record.body.charter;
        break;
      case "drift":
        driftSummaries.push(record.body.summary);
        break;
      case "memory":
        if (record.body.kind === "shard") {
          const text = await resolveShardText(store, record.body, tombstones);
          shardTexts.push(text);
          memoryIndex.push({
            cid: await computeCid(record),
            seq: record.seq,
            text
          });
        }
        break;
      case "attestation":
      case "decision":
      case "transaction":
      case "sleep":
      case "tombstone":
        break;
      default: {
        const _exhaustive: never = record;
        throw new ComposeError(`unexpected record type: ${String(_exhaustive)}`, []);
      }
    }
  }

  if (charter === undefined) {
    throw new ComposeError("cannot compose self: no genesis record found on chain", []);
  }

  const systemPrompt = renderSystemPrompt({
    charter,
    drifts: joinSection(driftSummaries),
    shards: joinSection(shardTexts)
  });

  return { systemPrompt, memoryIndex };
}
