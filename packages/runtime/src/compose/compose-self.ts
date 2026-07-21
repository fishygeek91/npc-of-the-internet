import { computeCid, verifyRecords, type OspRecord, type SoulStore } from "@npc/osp-core";

import { ComposeError } from "./errors.js";
import { SYSTEM_TEMPLATE } from "../prompts/composer/system.js";

/** One committed shard entry in the composed memory index. */
export type MemoryIndexEntry = { cid: string; seq: number; text: string };

/** Result of composing a verified soulchain into a system prompt and shard index. */
export type ComposedSelf = { systemPrompt: string; memoryIndex: MemoryIndexEntry[] };

/** Options for {@link composeSelf}; door keys are verification-only inputs. */
export type ComposeSelfOptions = { doorPublicKeys?: readonly Uint8Array[] };

type Section = "charter" | "drifts" | "shards";

/** Fixed sentinel when a list section has no items (readable goldens, deterministic). */
const EMPTY_SECTION = "(none yet)";

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
          shardTexts.push(record.body.text);
          memoryIndex.push({
            cid: await computeCid(record),
            seq: record.seq,
            text: record.body.text
          });
        }
        break;
      case "attestation":
      case "decision":
      case "transaction":
      case "sleep":
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
