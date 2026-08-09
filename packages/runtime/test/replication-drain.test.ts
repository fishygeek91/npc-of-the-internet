import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import pino from "pino";

import {
  createRecord,
  enqueueReplication,
  encodePublicKey,
  generateKeypair,
  IpfsSoulStore,
  listUnackedForTarget,
  type Ed25519Keypair
} from "@npc/osp-core";

import { createCarUploadAdapter } from "../src/replication/adapters.js";
import { startReplicationDrain } from "../src/replication/drain.js";

const TARGET = "test-target";
const ENQUEUED_AT = "2026-08-09T12:00:00.000Z";
const FIXED_NOW = "2026-08-09T12:00:01.000Z";

async function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

async function seedIpfsChain(ipfsDir: string, soul: Ed25519Keypair): Promise<string> {
  const store = await IpfsSoulStore.open(ipfsDir);
  const genesis = await createRecord({
    seq: 0,
    prev: null,
    type: "genesis",
    body: {
      charter: "# Wanderer",
      soul_pubkey: encodePublicKey(soul.publicKey),
      created_at: "2026-01-01T00:00:00.000Z"
    },
    residency: null,
    cosigners: [],
    soulPrivateKey: soul.privateKey
  });
  const { cid } = await store.append(genesis.record);
  await store.close();
  return cid;
}

describe("replication drain", () => {
  let ipfsDir: string;
  let publishedDir: string;
  let publishedCarPath: string;
  let manifestCidPath: string;
  let soul: Ed25519Keypair;

  beforeEach(async () => {
    ipfsDir = await makeTempDir("npc-repl-drain-ipfs-");
    publishedDir = await makeTempDir("npc-repl-drain-pub-");
    publishedCarPath = path.join(publishedDir, "soulchain-latest.car");
    manifestCidPath = path.join(publishedDir, "manifest-cid.txt");
    soul = generateKeypair();
    const recordCid = await seedIpfsChain(ipfsDir, soul);
    await enqueueReplication(ipfsDir, {
      cid: recordCid,
      kind: "record",
      enqueued_at: ENQUEUED_AT
    });
  });

  afterEach(async () => {
    await rm(ipfsDir, { recursive: true, force: true });
    await rm(publishedDir, { recursive: true, force: true });
  });

  it("tick uploads CAR and acks pending entries", async () => {
    let uploadCount = 0;
    const fetchImpl: typeof fetch = async (url, init) => {
      uploadCount += 1;
      expect(url).toBe("https://pin.example/car");
      const headers = init?.headers;
      if (headers instanceof Headers) {
        expect(headers.get("Authorization")).toBe("Bearer test-token");
        expect(headers.get("Content-Type")).toBe("application/vnd.ipld.car");
        expect(headers.get("X-Manifest-Cid")).toMatch(/^bagu/);
      }
      return new Response(null, { status: 200 });
    };

    const adapter = createCarUploadAdapter(
      {
        name: TARGET,
        kind: "car-upload",
        endpoint: "https://pin.example/car",
        tokenEnv: "TEST_TOKEN"
      },
      "test-token",
      fetchImpl
    );

    const drain = startReplicationDrain({
      ipfsDir,
      soulPrivateKey: soul.privateKey,
      publishedCarPath,
      manifestCidPath,
      targets: [adapter],
      intervalMs: 60_000,
      logger: pino({ level: "silent" }),
      now: () => FIXED_NOW
    });

    await drain.tick();
    await drain.stop();

    expect(uploadCount).toBe(1);
    const pending = await listUnackedForTarget(ipfsDir, TARGET);
    expect(pending).toEqual([]);

    const manifestRaw = await readFile(manifestCidPath, "utf8");
    expect(manifestRaw.trim()).toMatch(/^bagu/);
    const carBytes = await readFile(publishedCarPath);
    expect(carBytes.length).toBeGreaterThan(0);
  });

  it("does not ack when adapter throws; retries on next tick", async () => {
    let callCount = 0;
    const fetchImpl: typeof fetch = async () => {
      callCount += 1;
      if (callCount === 1) {
        return new Response(null, { status: 503 });
      }
      return new Response(null, { status: 200 });
    };

    const adapter = createCarUploadAdapter(
      {
        name: TARGET,
        kind: "car-upload",
        endpoint: "https://pin.example/car",
        tokenEnv: "TEST_TOKEN"
      },
      "test-token",
      fetchImpl
    );

    const drain = startReplicationDrain({
      ipfsDir,
      soulPrivateKey: soul.privateKey,
      publishedCarPath,
      manifestCidPath,
      targets: [adapter],
      intervalMs: 60_000,
      logger: pino({ level: "silent" }),
      now: () => FIXED_NOW
    });

    await drain.tick();
    let pending = await listUnackedForTarget(ipfsDir, TARGET);
    expect(pending.length).toBeGreaterThan(0);

    await drain.tick();
    pending = await listUnackedForTarget(ipfsDir, TARGET);
    expect(pending).toEqual([]);

    await drain.stop();
    expect(callCount).toBe(2);
  });
});
