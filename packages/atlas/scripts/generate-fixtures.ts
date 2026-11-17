/**
 * Generates the committed multi-residency Atlas fixture chain (`osp/0.2`).
 * Run via: pnpm --filter @npc/atlas generate:fixtures
 *
 * Residencies:
 * 1. `discord:g` epoch 1 — legacy forms: a `candidate` record and a journal embedded
 *    on a shard (`journal_cid`), then departure + travel to `irc:libera-wanderer`.
 * 2. `irc:libera-wanderer` epoch 2 — legacy shard-embedded journal, heartbeat,
 *    departure + travel to `web:home`.
 * 3. `web:home` epoch 3 — witnessed memory (door/0.2): an immune-screen `rejected`,
 *    a witnessed shard, a witness-declined `rejected` (`witness_private`), one `journal`
 *    record, then departure + travel to `discord:g`. The chain ends traveling.
 *
 * TEST-ONLY: uses deterministic private keys. Never use in production.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  OSP_SPEC_V02,
  contentAddressSideBlob,
  encodeJournalBlob,
  encodeShardTextBlob,
  FileSoulStore,
  type CreateRecordResult
} from "@npc/osp-core";

import {
  createArrivalRecord,
  createDepartureRecord,
  createGenesisRecord,
  createHeartbeatRecord,
  createJournalRecord,
  createLegacyCandidateRecordV02,
  createRejectedRecord,
  createShardRecordV02,
  createTravelRecord,
  type BlobAddress
} from "../test/helpers/chain-builder.js";
import {
  DOOR,
  DOOR_ID,
  DOOR_PUBLIC_KEY_B64,
  JOURNAL_EPOCH_1,
  JOURNAL_EPOCH_2,
  JOURNAL_EPOCH_3,
  LEAK_SHARD_TEXT,
  OTHER_DOOR,
  OTHER_DOOR_ID,
  OTHER_DOOR_PUBLIC_KEY_B64,
  RESIDENCY_1,
  RESIDENCY_2,
  RESIDENCY_3,
  SESSION,
  SOUL,
  WEB_DOOR,
  WEB_DOOR_ID,
  WEB_DOOR_PUBLIC_KEY_B64
} from "../test/helpers/fixed-keys.js";

const OUTPUT_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "test",
  "fixtures",
  "multi-residency"
);

const V02 = OSP_SPEC_V02;

async function main(): Promise<void> {
  // Wipe so regeneration is idempotent (open() would otherwise re-verify existing cosigned records).
  rmSync(OUTPUT_DIR, { recursive: true, force: true });
  mkdirSync(OUTPUT_DIR, { recursive: true });

  const store = await FileSoulStore.open(OUTPUT_DIR, {
    doorPublicKeys: {
      [DOOR_ID]: DOOR.publicKey,
      [OTHER_DOOR_ID]: OTHER_DOOR.publicKey,
      [WEB_DOOR_ID]: WEB_DOOR.publicKey
    }
  });

  let seq = 0;
  let prev = "";
  const append = async (
    build: (seq: number, prev: string) => Promise<CreateRecordResult>
  ): Promise<void> => {
    const created = await build(seq, prev);
    await store.append(created.record);
    seq += 1;
    prev = created.cid;
  };
  const blob = async (bytes: Uint8Array): Promise<BlobAddress> => {
    await store.putSideBlob(bytes);
    return contentAddressSideBlob(bytes);
  };
  const text = (value: string): Promise<BlobAddress> => blob(encodeShardTextBlob(value));
  const journal = (value: string): Promise<BlobAddress> => blob(encodeJournalBlob(value));

  try {
    await append(() => createGenesisRecord(SOUL, V02));

    // Residency 1 — discord:g, legacy memory forms.
    await append((s, p) =>
      createArrivalRecord(
        SOUL,
        DOOR,
        SESSION,
        s,
        p,
        DOOR_ID,
        1,
        RESIDENCY_1,
        "2026-01-02T00:00:00.000Z",
        V02
      )
    );
    const candidateText = await text("A legacy candidate awaiting a review that never comes.");
    await append((s, p) =>
      createLegacyCandidateRecordV02(
        SOUL,
        s,
        p,
        candidateText,
        RESIDENCY_1,
        "2026-01-02T00:30:00.000Z"
      )
    );
    const shard1Text = await text("I remember the quiet guild hall.");
    const journal1 = await journal(JOURNAL_EPOCH_1);
    await append((s, p) =>
      createShardRecordV02(SOUL, DOOR, s, p, shard1Text, RESIDENCY_1, {
        journal: journal1,
        distilled_at: "2026-01-02T01:00:00.000Z"
      })
    );
    const leakText = await text(LEAK_SHARD_TEXT);
    await append((s, p) =>
      createShardRecordV02(SOUL, DOOR, s, p, leakText, RESIDENCY_1, {
        distilled_at: "2026-01-02T01:30:00.000Z"
      })
    );
    await append((s, p) =>
      createDepartureRecord(
        SOUL,
        DOOR,
        s,
        p,
        DOOR_ID,
        1,
        RESIDENCY_1,
        "2026-01-02T02:00:00.000Z",
        V02
      )
    );
    await append((s, p) =>
      createTravelRecord(
        SOUL,
        s,
        p,
        DOOR_ID,
        1,
        RESIDENCY_1,
        "2026-01-02T02:30:00.000Z",
        OTHER_DOOR_ID,
        V02
      )
    );

    // Residency 2 — irc:libera-wanderer, legacy shard-embedded journal.
    await append((s, p) =>
      createArrivalRecord(
        SOUL,
        OTHER_DOOR,
        SESSION,
        s,
        p,
        OTHER_DOOR_ID,
        2,
        RESIDENCY_2,
        "2026-01-03T00:00:00.000Z",
        V02
      )
    );
    const shard2Text = await text("I learned to leave without apology.");
    const journal2 = await journal(JOURNAL_EPOCH_2);
    await append((s, p) =>
      createShardRecordV02(SOUL, OTHER_DOOR, s, p, shard2Text, RESIDENCY_2, {
        journal: journal2,
        distilled_at: "2026-01-03T01:00:00.000Z"
      })
    );
    await append((s, p) =>
      createHeartbeatRecord(
        SOUL,
        OTHER_DOOR,
        SESSION,
        s,
        p,
        OTHER_DOOR_ID,
        2,
        RESIDENCY_2,
        "2026-01-03T02:00:00.000Z",
        V02
      )
    );
    await append((s, p) =>
      createDepartureRecord(
        SOUL,
        OTHER_DOOR,
        s,
        p,
        OTHER_DOOR_ID,
        2,
        RESIDENCY_2,
        "2026-01-03T03:00:00.000Z",
        V02
      )
    );
    await append((s, p) =>
      createTravelRecord(
        SOUL,
        s,
        p,
        OTHER_DOOR_ID,
        2,
        RESIDENCY_2,
        "2026-01-03T03:30:00.000Z",
        WEB_DOOR_ID,
        V02
      )
    );

    // Residency 3 — web:home, witnessed memory (records.md §Order within a residency).
    await append((s, p) =>
      createArrivalRecord(
        SOUL,
        WEB_DOOR,
        SESSION,
        s,
        p,
        WEB_DOOR_ID,
        3,
        RESIDENCY_3,
        "2026-01-04T00:00:00.000Z",
        V02
      )
    );
    await append((s, p) =>
      createRejectedRecord(SOUL, s, p, "pii.email", RESIDENCY_3, "2026-01-04T05:00:00.000Z")
    );
    const shard3Text = await text("A stranger at the web door asked me where I had been.");
    await append((s, p) =>
      createShardRecordV02(SOUL, WEB_DOOR, s, p, shard3Text, RESIDENCY_3, {
        distilled_at: "2026-01-04T05:00:00.000Z"
      })
    );
    await append((s, p) =>
      createRejectedRecord(SOUL, s, p, "witness_private", RESIDENCY_3, "2026-01-04T05:00:00.000Z")
    );
    const journal3 = await journal(JOURNAL_EPOCH_3);
    await append((s, p) =>
      createJournalRecord(SOUL, WEB_DOOR, s, p, journal3, RESIDENCY_3, "2026-01-04T05:01:00.000Z")
    );
    await append((s, p) =>
      createDepartureRecord(
        SOUL,
        WEB_DOOR,
        s,
        p,
        WEB_DOOR_ID,
        3,
        RESIDENCY_3,
        "2026-01-04T05:02:00.000Z",
        V02
      )
    );
    await append((s, p) =>
      createTravelRecord(
        SOUL,
        s,
        p,
        WEB_DOOR_ID,
        3,
        RESIDENCY_3,
        "2026-01-04T05:03:00.000Z",
        DOOR_ID,
        V02
      )
    );
  } finally {
    await store.close();
  }

  const meta = {
    doorPublicKeys: {
      [DOOR_ID]: DOOR_PUBLIC_KEY_B64,
      [OTHER_DOOR_ID]: OTHER_DOOR_PUBLIC_KEY_B64,
      [WEB_DOOR_ID]: WEB_DOOR_PUBLIC_KEY_B64
    }
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
