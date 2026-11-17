import { encodePublicKey, generateKeypair, type Ed25519Keypair } from "@npc/osp-core";
import { afterEach, describe, expect, it } from "vitest";

import { JOURNAL_ERASED, loadShrine } from "../src/browser/shrine-chain.js";
import { DOOR_ID, LEAK, pins, PROSE, serveExport, stay, type BuiltStay } from "./shrine-fixture.js";

describe("shrine chain", () => {
  const closers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const close of closers.splice(0)) {
      await close();
    }
  });

  it("shows PRESENT and a checked journal, and hides shard text", async () => {
    const soul = generateKeypair();
    const door = generateKeypair();
    const built = await stay(soul, door);
    const served = await open(built, door, closers);
    const loaded = await loadShrine(pins(served.url, soul), null);
    expect(loaded.snapshot.badge).toBe("PRESENT");
    expect(loaded.snapshot.doorId).toBe(DOOR_ID);
    expect(loaded.snapshot.journals).toEqual([PROSE]);
    expect(JSON.stringify(loaded.snapshot)).not.toContain(LEAK);
  });

  it("does not show PRESENT for an invalid chain, a bad soul pin, or a replaced door key", async () => {
    const soul = generateKeypair();
    const door = generateKeypair();
    const built = await stay(soul, door);
    const genesis = built.records[0];
    if (genesis === undefined) {
      throw new Error("missing genesis");
    }
    const broken = built.records.map((record, index) =>
      index === 0
        ? {
            ...record,
            sig: record.sig.endsWith("A")
              ? `${record.sig.slice(0, -1)}B`
              : `${record.sig.slice(0, -1)}A`
          }
        : record
    );
    const invalid = await serveExport({
      records: broken,
      doorPublicKeys: { [DOOR_ID]: encodePublicKey(door.publicKey) },
      blobs: built.blobs
    });
    closers.push(invalid.close);
    const invalidLoad = await loadShrine(pins(invalid.url, soul), null);
    expect(invalidLoad.snapshot.badge).not.toBe("PRESENT");
    expect(invalidLoad.snapshot.detail).toBe("verification failed");
    expect(invalidLoad.snapshot.journals).toEqual([]);

    const valid = await open(built, door, closers);
    const wrongSoul = await loadShrine(
      pins(valid.url, soul, encodePublicKey(generateKeypair().publicKey)),
      null
    );
    expect(wrongSoul.snapshot.badge).not.toBe("PRESENT");
    const replaced = await loadShrine(
      {
        ...pins(valid.url, soul),
        doorPublicKeys: { [DOOR_ID]: encodePublicKey(generateKeypair().publicKey) }
      },
      null
    );
    expect(replaced.snapshot.badge).not.toBe("PRESENT");
    expect(replaced.snapshot.journals).toEqual([]);
  });

  it("renders a tombstoned journal as erased even when the bytes are still in the export", async () => {
    const soul = generateKeypair();
    const door = generateKeypair();
    const built = await stay(soul, door, { tombstone: true });
    const served = await open(built, door, closers);
    const loaded = await loadShrine(pins(served.url, soul), null);
    expect(loaded.snapshot.badge).toBe("PRESENT");
    expect(loaded.snapshot.journals).toEqual([JOURNAL_ERASED]);
    expect(loaded.snapshot.journals.join("\n")).not.toContain(PROSE);
  });
});

async function open(
  built: BuiltStay,
  door: Ed25519Keypair,
  closers: Array<() => Promise<void>>
): Promise<{ url: string }> {
  const served = await serveExport({
    records: built.records,
    doorPublicKeys: { [DOOR_ID]: encodePublicKey(door.publicKey) },
    blobs: built.blobs
  });
  closers.push(served.close);
  return served;
}
