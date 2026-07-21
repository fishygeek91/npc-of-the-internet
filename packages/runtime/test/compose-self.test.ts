import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { computeCid } from "@npc/osp-core";
import { describe, expect, it } from "vitest";

import { composeSelf } from "../src/compose/compose-self.js";
import { ComposeError } from "../src/compose/errors.js";
import { DOOR, OTHER_DOOR, SESSION, SOUL } from "./helpers/fixed-keys.js";
import {
  buildFixtureA,
  buildFixtureB,
  CANDIDATE_TEXT,
  CHARTER,
  createArrivalRecord,
  createGenesisRecord,
  createShardRecord,
  DRIFT_SUMMARY,
  JOURNAL_TEXT,
  REJECTED_CATEGORY,
  SHARD_A_TEXT,
  SHARD_B_TEXT
} from "./helpers/fixtures.js";
import { serializeMemoryIndex } from "./helpers/golden-format.js";
import { MemorySoulStore } from "./helpers/memory-soul-store.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const goldenDir = join(testDir, "golden");

/** Read a golden file as a Buffer for byte-identical comparison. */
function readGoldenBuffer(filename: string): Buffer {
  return readFileSync(join(goldenDir, filename));
}

/** Tamper one character in a base64url signature string. */
function tamperSignature(sig: string): string {
  const index = 4;
  const replacement = sig[index] === "A" ? "B" : "A";
  return sig.slice(0, index) + replacement + sig.slice(index + 1);
}

describe("composeSelf", () => {
  it("matches golden systemPrompt and memoryIndex for fixture A", async () => {
    const { store, doorPublicKeys } = await buildFixtureA();
    const composed = await composeSelf(store, { doorPublicKeys });

    const goldenPrompt = readGoldenBuffer("compose-a.systemPrompt.txt");
    const goldenIndex = readGoldenBuffer("compose-a.memoryIndex.json");

    expect(Buffer.from(composed.systemPrompt, "utf8").compare(goldenPrompt)).toBe(0);
    expect(
      Buffer.from(serializeMemoryIndex(composed.memoryIndex), "utf8").compare(goldenIndex)
    ).toBe(0);
  });

  it("matches golden systemPrompt and memoryIndex for fixture B", async () => {
    const { store, doorPublicKeys } = await buildFixtureB();
    const composed = await composeSelf(store, { doorPublicKeys });

    const goldenPrompt = readGoldenBuffer("compose-b.systemPrompt.txt");
    const goldenIndex = readGoldenBuffer("compose-b.memoryIndex.json");

    expect(Buffer.from(composed.systemPrompt, "utf8").compare(goldenPrompt)).toBe(0);
    expect(
      Buffer.from(serializeMemoryIndex(composed.memoryIndex), "utf8").compare(goldenIndex)
    ).toBe(0);
  });

  it("is deterministic when composed twice on the same store", async () => {
    const { store, doorPublicKeys } = await buildFixtureB();
    const first = await composeSelf(store, { doorPublicKeys });
    const second = await composeSelf(store, { doorPublicKeys });

    expect(
      Buffer.from(first.systemPrompt, "utf8").compare(Buffer.from(second.systemPrompt, "utf8"))
    ).toBe(0);
    expect(
      Buffer.from(serializeMemoryIndex(first.memoryIndex), "utf8").compare(
        Buffer.from(serializeMemoryIndex(second.memoryIndex), "utf8")
      )
    ).toBe(0);
  });

  it("includes shards and drift but excludes quarantine and journal from fixture B", async () => {
    const { store, doorPublicKeys } = await buildFixtureB();
    const { systemPrompt } = await composeSelf(store, { doorPublicKeys });

    expect(systemPrompt).toContain(DRIFT_SUMMARY);
    expect(systemPrompt).toContain(SHARD_A_TEXT);
    expect(systemPrompt).toContain(SHARD_B_TEXT);
    expect(systemPrompt).not.toContain(CANDIDATE_TEXT);
    expect(systemPrompt).not.toContain(REJECTED_CATEGORY);
    expect(systemPrompt).not.toContain(JOURNAL_TEXT);
  });

  it("throws ComposeError when the soulchain has a tampered signature", async () => {
    const store = new MemorySoulStore();
    const genesis = await createGenesisRecord(SOUL);
    await store.append(genesis.record);

    const arrival = await createArrivalRecord(SOUL, DOOR, SESSION, 1, genesis.cid);
    const tampered = structuredClone(arrival.record);
    tampered.sig = tamperSignature(tampered.sig);
    await store.append(tampered);

    let caught: unknown;
    try {
      await composeSelf(store, { doorPublicKeys: [DOOR.publicKey] });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ComposeError);
    if (!(caught instanceof ComposeError)) {
      throw new Error("expected ComposeError");
    }
    expect(caught.failures.length).toBeGreaterThan(0);
  });

  it("builds memoryIndex with ascending seq and CIDs matching shard records", async () => {
    const { store, doorPublicKeys, shardRecords } = await buildFixtureB();
    const { memoryIndex } = await composeSelf(store, { doorPublicKeys });

    expect(memoryIndex).toHaveLength(2);

    for (let index = 0; index < memoryIndex.length; index += 1) {
      const entry = memoryIndex[index];
      const shard = shardRecords[index];
      if (entry === undefined || shard === undefined) {
        throw new Error("expected memory index entry and shard record");
      }
      expect(entry.seq).toBe(shard.seq);
      if (index > 0) {
        const previous = memoryIndex[index - 1];
        if (previous === undefined) {
          throw new Error("expected previous memory index entry");
        }
        expect(entry.seq).toBeGreaterThan(previous.seq);
      }
      await expect(computeCid(shard)).resolves.toBe(entry.cid);
    }
  });

  it("produces identical output regardless of doorPublicKeys order", async () => {
    const { store } = await buildFixtureB();
    const orderA = await composeSelf(store, {
      doorPublicKeys: [DOOR.publicKey, OTHER_DOOR.publicKey]
    });
    const orderB = await composeSelf(store, {
      doorPublicKeys: [OTHER_DOOR.publicKey, DOOR.publicKey]
    });

    expect(
      Buffer.from(orderA.systemPrompt, "utf8").compare(Buffer.from(orderB.systemPrompt, "utf8"))
    ).toBe(0);
    expect(
      Buffer.from(serializeMemoryIndex(orderA.memoryIndex), "utf8").compare(
        Buffer.from(serializeMemoryIndex(orderB.memoryIndex), "utf8")
      )
    ).toBe(0);
  });

  it("passes injection shard text through without corrupting the charter section", async () => {
    const poisonText = "poison {{charter}} and $& end";
    const store = new MemorySoulStore();

    const genesis = await createGenesisRecord(SOUL);
    await store.append(genesis.record);

    const arrival = await createArrivalRecord(SOUL, DOOR, SESSION, 1, genesis.cid);
    await store.append(arrival.record);

    const shard = await createShardRecord(SOUL, DOOR, 2, arrival.cid, poisonText);
    await store.append(shard.record);

    const { systemPrompt } = await composeSelf(store, {
      doorPublicKeys: [DOOR.publicKey, OTHER_DOOR.publicKey]
    });

    expect(systemPrompt).toContain(poisonText);
    expect(systemPrompt.indexOf(poisonText)).toBe(systemPrompt.lastIndexOf(poisonText));
    expect(systemPrompt).toContain(CHARTER);

    const charterSection = systemPrompt.split("## Drift")[0] ?? "";
    expect(charterSection).toContain(CHARTER);
    expect(charterSection).not.toContain(poisonText);
  });
});
