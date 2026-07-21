/**
 * Generates the committed multi-residency Atlas fixture chain.
 * Run via: pnpm --filter @npc/atlas generate:fixtures
 *
 * TEST-ONLY: uses deterministic private keys. Never use in production.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { FileSoulStore } from "@npc/osp-core";

import {
  createArrivalRecord,
  createDepartureRecord,
  createGenesisRecord,
  createHeartbeatRecord,
  createShardRecord,
  createTravelRecord
} from "../test/helpers/chain-builder.js";
import {
  DOOR,
  DOOR_ID,
  DOOR_PUBLIC_KEY_B64,
  JOURNAL_EPOCH_1,
  JOURNAL_EPOCH_2,
  LEAK_SHARD_TEXT,
  OTHER_DOOR,
  OTHER_DOOR_ID,
  OTHER_DOOR_PUBLIC_KEY_B64,
  RESIDENCY_1,
  RESIDENCY_2,
  SESSION,
  SOUL
} from "../test/helpers/fixed-keys.js";

const OUTPUT_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "test",
  "fixtures",
  "multi-residency"
);

async function main(): Promise<void> {
  // Wipe so regeneration is idempotent (open() would otherwise re-verify existing cosigned records).
  rmSync(OUTPUT_DIR, { recursive: true, force: true });
  mkdirSync(OUTPUT_DIR, { recursive: true });

  const store = await FileSoulStore.open(OUTPUT_DIR, {
    doorPublicKeys: [DOOR.publicKey, OTHER_DOOR.publicKey]
  });
  try {
    const genesis = await createGenesisRecord(SOUL);
    await store.append(genesis.record);

    const arrival1 = await createArrivalRecord(
      SOUL,
      DOOR,
      SESSION,
      1,
      genesis.cid,
      DOOR_ID,
      1,
      RESIDENCY_1,
      "2026-01-02T00:00:00.000Z"
    );
    await store.append(arrival1.record);

    const shard1 = await createShardRecord(
      SOUL,
      DOOR,
      2,
      arrival1.cid,
      "I remember the quiet guild hall.",
      RESIDENCY_1,
      { journal: JOURNAL_EPOCH_1, distilled_at: "2026-01-02T01:00:00.000Z" }
    );
    await store.append(shard1.record);

    const shardLeak = await createShardRecord(
      SOUL,
      DOOR,
      3,
      shard1.cid,
      LEAK_SHARD_TEXT,
      RESIDENCY_1,
      { distilled_at: "2026-01-02T01:30:00.000Z" }
    );
    await store.append(shardLeak.record);

    const departure = await createDepartureRecord(
      SOUL,
      DOOR,
      4,
      shardLeak.cid,
      DOOR_ID,
      1,
      RESIDENCY_1,
      "2026-01-02T02:00:00.000Z"
    );
    await store.append(departure.record);

    const travel = await createTravelRecord(
      SOUL,
      5,
      departure.cid,
      DOOR_ID,
      1,
      RESIDENCY_1,
      "2026-01-02T02:30:00.000Z",
      OTHER_DOOR_ID
    );
    await store.append(travel.record);

    const arrival2 = await createArrivalRecord(
      SOUL,
      OTHER_DOOR,
      SESSION,
      6,
      travel.cid,
      OTHER_DOOR_ID,
      2,
      RESIDENCY_2,
      "2026-01-03T00:00:00.000Z"
    );
    await store.append(arrival2.record);

    const shard2 = await createShardRecord(
      SOUL,
      OTHER_DOOR,
      7,
      arrival2.cid,
      "I learned to leave without apology.",
      RESIDENCY_2,
      { journal: JOURNAL_EPOCH_2, distilled_at: "2026-01-03T01:00:00.000Z" }
    );
    await store.append(shard2.record);

    const heartbeat = await createHeartbeatRecord(
      SOUL,
      OTHER_DOOR,
      SESSION,
      8,
      shard2.cid,
      OTHER_DOOR_ID,
      2,
      RESIDENCY_2,
      "2026-01-03T02:00:00.000Z"
    );
    await store.append(heartbeat.record);
  } finally {
    await store.close();
  }

  const meta = {
    doorPublicKey: DOOR_PUBLIC_KEY_B64,
    doorPublicKeys: [DOOR_PUBLIC_KEY_B64, OTHER_DOOR_PUBLIC_KEY_B64]
  };
  writeFileSync(
    join(OUTPUT_DIR, "fixture-meta.json"),
    `${JSON.stringify(meta, null, 2)}\n`,
    "utf8"
  );
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
