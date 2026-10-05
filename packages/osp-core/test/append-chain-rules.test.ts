import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DualSoulStore,
  FileSoulStore,
  IpfsSoulStore,
  OSP_SPEC_V01,
  OSP_SPEC_V02,
  computeCid,
  contentAddressSideBlob,
  createRecord,
  encodePublicKey,
  encodeShardTextBlob,
  generateKeypair,
  signCore,
  verifyChain,
  VerificationError,
  type Ed25519Keypair,
  type OspRecord,
  type SoulStore
} from "../src/index.js";

/**
 * Regression suite for review finding F2: append must enforce the full chain rules
 * (records.md Verification) — not just per-record signatures — BEFORE any durable write,
 * so a store can never persist a record that makes its own chain unopenable.
 */

const DOOR_ID = "discord:g";
const RESIDENCY = `door:${DOOR_ID}/epoch:1`;

type Spec = typeof OSP_SPEC_V01 | typeof OSP_SPEC_V02;

type Harness = {
  name: string;
  /** Open (or re-open) the store rooted at `root`. */
  open: (
    root: string,
    doorKeys: Record<string, Uint8Array>
  ) => Promise<SoulStore & { close(): Promise<void> }>;
};

const HARNESSES: Harness[] = [
  {
    name: "FileSoulStore",
    open: (root, doorPublicKeys) => FileSoulStore.open(root, { doorPublicKeys })
  },
  {
    name: "IpfsSoulStore",
    open: (root, doorPublicKeys) => IpfsSoulStore.open(root, { doorPublicKeys })
  },
  {
    name: "DualSoulStore",
    open: (root, doorPublicKeys) =>
      DualSoulStore.open(path.join(root, "file"), path.join(root, "ipfs"), { doorPublicKeys })
  }
];

type Keys = { soul: Ed25519Keypair; door: Ed25519Keypair; session: Ed25519Keypair };

function makeKeys(): Keys {
  return { soul: generateKeypair(), door: generateKeypair(), session: generateKeypair() };
}

async function genesis(keys: Keys, spec: Spec) {
  return createRecord({
    spec,
    seq: 0,
    prev: null,
    type: "genesis",
    body: {
      charter: "# Wanderer",
      soul_pubkey: encodePublicKey(keys.soul.publicKey),
      created_at: "2026-01-01T00:00:00.000Z"
    },
    residency: null,
    cosigners: [],
    soulPrivateKey: keys.soul.privateKey
  });
}

async function arrival(keys: Keys, seq: number, prev: string, spec: Spec, epoch = 1) {
  const fields = {
    spec,
    seq,
    prev,
    type: "attestation" as const,
    body: {
      kind: "arrival" as const,
      pop_version: "pop/0.1" as const,
      door_id: DOOR_ID,
      epoch,
      session_pubkey: encodePublicKey(keys.session.publicKey),
      at: "2026-01-02T00:00:00.000Z"
    },
    residency: `door:${DOOR_ID}/epoch:${epoch}`
  };
  return createRecord({
    ...fields,
    cosigners: [signCore(fields, keys.door.privateKey)],
    soulPrivateKey: keys.soul.privateKey
  });
}

async function heartbeat(keys: Keys, seq: number, prev: string, spec: Spec) {
  const fields = {
    spec,
    seq,
    prev,
    type: "attestation" as const,
    body: {
      kind: "heartbeat" as const,
      pop_version: "pop/0.1" as const,
      door_id: DOOR_ID,
      epoch: 1,
      session_pubkey: encodePublicKey(keys.session.publicKey),
      at: "2026-01-02T00:10:00.000Z"
    },
    residency: RESIDENCY
  };
  return createRecord({
    ...fields,
    cosigners: [signCore(fields, keys.door.privateKey)],
    soulPrivateKey: keys.soul.privateKey
  });
}

async function travel(keys: Keys, seq: number, prev: string, spec: Spec) {
  return createRecord({
    spec,
    seq,
    prev,
    type: "attestation",
    body: {
      kind: "travel",
      pop_version: "pop/0.1",
      from_door_id: DOOR_ID,
      from_epoch: 1,
      at: "2026-01-02T01:00:00.000Z"
    },
    residency: RESIDENCY,
    cosigners: [],
    soulPrivateKey: keys.soul.privateKey
  });
}

async function decision(keys: Keys, seq: number, prev: string, spec: Spec) {
  return createRecord({
    spec,
    seq,
    prev,
    type: "decision",
    body: { decision: "x", reasoning: "y", decided_at: "2026-01-01T00:00:00.000Z" },
    residency: RESIDENCY,
    cosigners: [],
    soulPrivateKey: keys.soul.privateKey
  });
}

async function drift(keys: Keys, seq: number, prev: string, evidence: string[], spec: Spec) {
  return createRecord({
    spec,
    seq,
    prev,
    type: "drift",
    body: { summary: "x", evidence, effective_at: "2026-01-01T00:00:00.000Z" },
    residency: RESIDENCY,
    cosigners: [],
    soulPrivateKey: keys.soul.privateKey
  });
}

async function shardV02(keys: Keys, seq: number, prev: string, text: string) {
  const blob = await contentAddressSideBlob(encodeShardTextBlob(text));
  const fields = {
    spec: OSP_SPEC_V02,
    seq,
    prev,
    type: "memory" as const,
    body: {
      kind: "shard" as const,
      text_cid: blob.cid,
      text_hash: blob.hash,
      distilled_at: "2026-01-02T00:30:00.000Z"
    },
    residency: RESIDENCY
  };
  const result = await createRecord({
    ...fields,
    cosigners: [signCore(fields, keys.door.privateKey)],
    soulPrivateKey: keys.soul.privateKey
  });
  return { ...result, blob };
}

async function tombstone(
  keys: Keys,
  seq: number,
  prev: string,
  targetCid: string,
  blobCid: string
) {
  return createRecord({
    spec: OSP_SPEC_V02,
    seq,
    prev,
    type: "tombstone",
    body: {
      target_cid: targetCid,
      blob_cid: blobCid,
      reason: "operator",
      erased_at: "2026-01-03T00:00:00.000Z"
    },
    residency: null,
    cosigners: [],
    soulPrivateKey: keys.soul.privateKey
  });
}

/** Snapshot every file under `root` (path → bytes) to prove no durable write happened. */
async function snapshotTree(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else {
        out.set(path.relative(root, full), (await readFile(full)).toString("base64"));
      }
    }
  };
  await walk(root);
  return out;
}

describe.each(HARNESSES)(
  "$name append enforces chain rules before any durable write",
  (harness) => {
    const roots: string[] = [];

    afterEach(async () => {
      for (const root of roots.splice(0)) {
        await rm(root, { recursive: true, force: true });
      }
    });

    /**
     * Append `prefix` to a fresh store, then assert `bad` is rejected with VerificationError,
     * nothing on disk changed, and the store re-opens and verifies with the prefix head.
     */
    async function expectRejected(
      keys: Keys,
      prefix: OspRecord[],
      bad: OspRecord,
      rule: RegExp
    ): Promise<void> {
      const root = await mkdtemp(path.join(tmpdir(), "osp-append-rules-"));
      roots.push(root);
      const doorKeys = { [DOOR_ID]: keys.door.publicKey };

      const store = await harness.open(root, doorKeys);
      let headCid = "";
      try {
        for (const record of prefix) {
          headCid = (await store.append(record)).cid;
        }
        const before = await snapshotTree(root);
        const attempt = store.append(bad);
        await expect(attempt).rejects.toThrow(VerificationError);
        await expect(store.append(bad)).rejects.toThrow(rule);
        // The lock file is released after the failed append; everything else is byte-identical.
        expect(await snapshotTree(root)).toEqual(before);
        expect((await store.head())?.cid).toBe(headCid);
      } finally {
        await store.close();
      }

      const reopened = await harness.open(root, doorKeys);
      try {
        expect((await reopened.head())?.cid).toBe(headCid);
        const verified = await verifyChain(reopened, { doorPublicKeys: doorKeys });
        expect(verified.valid).toBe(true);
      } finally {
        await reopened.close();
      }
    }

    it("rejects a mixed-spec record (osp/0.2 after osp/0.1 genesis)", async () => {
      const keys = makeKeys();
      const g = await genesis(keys, OSP_SPEC_V01);
      const d = await decision(keys, 1, g.cid, OSP_SPEC_V02);
      await expectRejected(keys, [g.record], d.record, /schema_violation.*mixed osp spec/);
    });

    it("rejects drift whose evidence is not an earlier committed shard", async () => {
      const keys = makeKeys();
      const g = await genesis(keys, OSP_SPEC_V01);
      const d = await drift(keys, 1, g.cid, [g.cid], OSP_SPEC_V01);
      await expectRejected(keys, [g.record], d.record, /bad_drift_evidence/);
    });

    it("rejects a heartbeat after travel closed the session", async () => {
      const keys = makeKeys();
      const g = await genesis(keys, OSP_SPEC_V01);
      const a = await arrival(keys, 1, g.cid, OSP_SPEC_V01);
      const t = await travel(keys, 2, a.cid, OSP_SPEC_V01);
      const h = await heartbeat(keys, 3, t.cid, OSP_SPEC_V01);
      await expectRejected(
        keys,
        [g.record, a.record, t.record],
        h.record,
        /bad_session_continuity/
      );
    });

    it("rejects a second arrival for an already-claimed epoch", async () => {
      const keys = makeKeys();
      const g = await genesis(keys, OSP_SPEC_V01);
      const a = await arrival(keys, 1, g.cid, OSP_SPEC_V01);
      const again = await arrival(keys, 2, a.cid, OSP_SPEC_V01);
      await expectRejected(keys, [g.record, a.record], again.record, /presence_conflict/);
    });

    it("rejects a tombstone whose target is not on the chain (rule 12)", async () => {
      const keys = makeKeys();
      const g = await genesis(keys, OSP_SPEC_V02);
      const a = await arrival(keys, 1, g.cid, OSP_SPEC_V02);
      const orphan = await shardV02(keys, 2, a.cid, "never appended");
      const t = await tombstone(keys, 2, a.cid, orphan.cid, orphan.blob.cid);
      await expectRejected(keys, [g.record, a.record], t.record, /bad_tombstone/);
    });

    it("rejects a tombstone whose blob is not the target's text/journal blob (rule 12)", async () => {
      const keys = makeKeys();
      const g = await genesis(keys, OSP_SPEC_V02);
      const a = await arrival(keys, 1, g.cid, OSP_SPEC_V02);
      const s = await shardV02(keys, 2, a.cid, "a real memory");
      const other = await contentAddressSideBlob(encodeShardTextBlob("unrelated"));
      const t = await tombstone(keys, 3, s.cid, s.cid, other.cid);
      await expectRejected(keys, [g.record, a.record, s.record], t.record, /bad_tombstone/);
    });

    it("accepts a valid tombstone and a re-tombstone of the same blob", async () => {
      const keys = makeKeys();
      const root = await mkdtemp(path.join(tmpdir(), "osp-append-rules-"));
      roots.push(root);
      const doorKeys = { [DOOR_ID]: keys.door.publicKey };
      const g = await genesis(keys, OSP_SPEC_V02);
      const a = await arrival(keys, 1, g.cid, OSP_SPEC_V02);
      const s = await shardV02(keys, 2, a.cid, "erase me");
      const t1 = await tombstone(keys, 3, s.cid, s.cid, s.blob.cid);
      const t2 = await tombstone(keys, 4, t1.cid, s.cid, s.blob.cid);

      const store = await harness.open(root, doorKeys);
      try {
        for (const record of [g.record, a.record, s.record, t1.record, t2.record]) {
          await store.append(record);
        }
      } finally {
        await store.close();
      }
      const reopened = await harness.open(root, doorKeys);
      try {
        expect((await reopened.head())?.cid).toBe(t2.cid);
        expect(await computeCid(t2.record)).toBe(t2.cid);
      } finally {
        await reopened.close();
      }
    });
  }
);

describe.each(HARNESSES.filter((h) => h.name !== "DualSoulStore"))(
  "$name append verifier follows appends made by another instance",
  (harness) => {
    const roots: string[] = [];

    afterEach(async () => {
      for (const root of roots.splice(0)) {
        await rm(root, { recursive: true, force: true });
      }
    });

    it("re-walks the on-disk chain before evaluating, so rules see the other instance's records", async () => {
      const keys = makeKeys();
      const root = await mkdtemp(path.join(tmpdir(), "osp-append-rules-"));
      roots.push(root);
      const doorKeys = { [DOOR_ID]: keys.door.publicKey };

      const first = await harness.open(root, doorKeys);
      const second = await harness.open(root, doorKeys);
      try {
        const g = await genesis(keys, OSP_SPEC_V01);
        await first.append(g.record);
        const a = await arrival(keys, 1, g.cid, OSP_SPEC_V01);
        await first.append(a.record);

        // `second` loaded an empty chain; its verifier must catch up before judging this.
        const again = await arrival(keys, 2, a.cid, OSP_SPEC_V01);
        await expect(second.append(again.record)).rejects.toThrow(/presence_conflict/);

        const h = await heartbeat(keys, 2, a.cid, OSP_SPEC_V01);
        await expect(second.append(h.record)).resolves.toEqual({ cid: h.cid });
      } finally {
        await first.close();
        await second.close();
      }
    });
  }
);
