import { cp, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { decodePublicKey, FileSoulStore } from "@npc/osp-core";
import { afterEach, describe, expect, it } from "vitest";

import { createAtlasServer } from "../src/server.js";
import {
  createArrivalRecord,
  createDepartureRecord,
  createGenesisRecord,
  createHeartbeatRecord,
  createTravelRecord,
  DEFAULT_DOOR,
  DEFAULT_DOOR_ID,
  DEFAULT_OTHER_DOOR_ID,
  DEFAULT_RESIDENCY,
  DEFAULT_SESSION,
  DEFAULT_SOUL
} from "./helpers/chain-builder.js";
import {
  FIXTURE_DOOR_PUBLIC_KEYS_B64,
  JOURNAL_EPOCH_1,
  JOURNAL_EPOCH_2,
  LEAK_SHARD_TEXT,
  MULTI_RESIDENCY_FIXTURE_DIR
} from "./helpers/fixture-meta.js";
import { snapshotDirectory } from "./helpers/hash-snapshot.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function doorPublicKeys(): Uint8Array[] {
  return FIXTURE_DOOR_PUBLIC_KEYS_B64.map((value) => decodePublicKey(value));
}

async function openServer(chainDir: string) {
  const app = await createAtlasServer({
    chainDir,
    port: 8787,
    doorPublicKeys: doorPublicKeys()
  });
  return app;
}

describe("atlas API read-only guarantees", () => {
  it("does not modify fixture files or create lock files", async () => {
    const before = await snapshotDirectory(MULTI_RESIDENCY_FIXTURE_DIR);
    const app = await openServer(MULTI_RESIDENCY_FIXTURE_DIR);
    try {
      const endpoints = ["/state", "/chain/head", "/records", "/journals"];
      for (const url of endpoints) {
        const response = await app.inject({ method: "GET", url });
        expect(response.statusCode).toBe(200);
      }
    } finally {
      await app.close();
    }

    const after = await snapshotDirectory(MULTI_RESIDENCY_FIXTURE_DIR);
    expect(after).toEqual(before);
    await expect(accessMissingLock(MULTI_RESIDENCY_FIXTURE_DIR)).resolves.toBe(true);
  });

  it("serves requests while .append.lock exists on a copy of the fixture", async () => {
    const copyDir = await makeTempDir("atlas-lock-copy-");
    await cp(MULTI_RESIDENCY_FIXTURE_DIR, copyDir, { recursive: true });
    const lockPath = join(copyDir, ".append.lock");
    const lockFd = await open(lockPath, "wx");
    await lockFd.close();

    const app = await openServer(copyDir);
    try {
      const response = await app.inject({ method: "GET", url: "/state" });
      expect(response.statusCode).toBe(200);
      const body = response.json() as { status: string; verified: boolean };
      expect(body.status).toBe("present");
      expect(body.verified).toBe(true);
    } finally {
      await app.close();
    }
  });
});

async function accessMissingLock(dir: string): Promise<boolean> {
  try {
    await readFile(join(dir, ".append.lock"));
    return false;
  } catch {
    return true;
  }
}

describe("GET /state derivation branches", () => {
  it("returns sleeping for genesis-only chain", async () => {
    const dir = await makeTempDir("atlas-state-genesis-");
    const store = await FileSoulStore.open(dir);
    try {
      const genesis = await createGenesisRecord(DEFAULT_SOUL);
      await store.append(genesis.record);
    } finally {
      await store.close();
    }

    const app = await openServer(dir);
    try {
      const response = await app.inject({ method: "GET", url: "/state" });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        status: "sleeping",
        door_id: null,
        epoch: null,
        last_record_at: "2026-01-01T00:00:00.000Z",
        verified: true
      });
    } finally {
      await app.close();
    }
  });

  it("returns present for arrival and heartbeat endings", async () => {
    const arrivalDir = await makeTempDir("atlas-state-arrival-");
    await buildArrivalChain(arrivalDir);
    const arrivalApp = await openServer(arrivalDir);
    try {
      const arrivalResponse = await arrivalApp.inject({ method: "GET", url: "/state" });
      expect(arrivalResponse.json()).toMatchObject({
        status: "present",
        door_id: DEFAULT_DOOR_ID,
        epoch: 1,
        verified: true
      });
    } finally {
      await arrivalApp.close();
    }

    const heartbeatDir = await makeTempDir("atlas-state-heartbeat-");
    await buildHeartbeatChain(heartbeatDir);
    const heartbeatApp = await openServer(heartbeatDir);
    try {
      const heartbeatResponse = await heartbeatApp.inject({ method: "GET", url: "/state" });
      expect(heartbeatResponse.json()).toMatchObject({
        status: "present",
        door_id: DEFAULT_DOOR_ID,
        epoch: 1,
        verified: true
      });
    } finally {
      await heartbeatApp.close();
    }
  });

  it("returns traveling with null door_id for departure and travel endings", async () => {
    const departureDir = await makeTempDir("atlas-state-departure-");
    await buildDepartureChain(departureDir);
    const departureApp = await openServer(departureDir);
    try {
      const departureResponse = await departureApp.inject({ method: "GET", url: "/state" });
      expect(departureResponse.json()).toMatchObject({
        status: "traveling",
        door_id: null,
        epoch: 1,
        verified: true
      });
    } finally {
      await departureApp.close();
    }

    const travelDir = await makeTempDir("atlas-state-travel-");
    await buildTravelChain(travelDir);
    const travelApp = await openServer(travelDir);
    try {
      const travelResponse = await travelApp.inject({ method: "GET", url: "/state" });
      expect(travelResponse.json()).toMatchObject({
        status: "traveling",
        door_id: null,
        epoch: 1,
        verified: true
      });
    } finally {
      await travelApp.close();
    }
  });
});

async function buildArrivalChain(dir: string): Promise<void> {
  const store = await FileSoulStore.open(dir);
  try {
    const genesis = await createGenesisRecord(DEFAULT_SOUL);
    await store.append(genesis.record);
    const arrival = await createArrivalRecord(
      DEFAULT_SOUL,
      DEFAULT_DOOR,
      DEFAULT_SESSION,
      1,
      genesis.cid,
      DEFAULT_DOOR_ID,
      1,
      DEFAULT_RESIDENCY,
      "2026-01-02T00:00:00.000Z"
    );
    await store.append(arrival.record);
  } finally {
    await store.close();
  }
}

async function buildHeartbeatChain(dir: string): Promise<void> {
  const store = await FileSoulStore.open(dir);
  try {
    const genesis = await createGenesisRecord(DEFAULT_SOUL);
    await store.append(genesis.record);
    const arrival = await createArrivalRecord(
      DEFAULT_SOUL,
      DEFAULT_DOOR,
      DEFAULT_SESSION,
      1,
      genesis.cid,
      DEFAULT_DOOR_ID,
      1,
      DEFAULT_RESIDENCY,
      "2026-01-02T00:00:00.000Z"
    );
    await store.append(arrival.record);
    const heartbeat = await createHeartbeatRecord(
      DEFAULT_SOUL,
      DEFAULT_DOOR,
      DEFAULT_SESSION,
      2,
      arrival.cid,
      DEFAULT_DOOR_ID,
      1,
      DEFAULT_RESIDENCY,
      "2026-01-02T01:00:00.000Z"
    );
    await store.append(heartbeat.record);
  } finally {
    await store.close();
  }
}

async function buildDepartureChain(dir: string): Promise<void> {
  const store = await FileSoulStore.open(dir);
  try {
    const genesis = await createGenesisRecord(DEFAULT_SOUL);
    await store.append(genesis.record);
    const arrival = await createArrivalRecord(
      DEFAULT_SOUL,
      DEFAULT_DOOR,
      DEFAULT_SESSION,
      1,
      genesis.cid,
      DEFAULT_DOOR_ID,
      1,
      DEFAULT_RESIDENCY,
      "2026-01-02T00:00:00.000Z"
    );
    await store.append(arrival.record);
    const departure = await createDepartureRecord(
      DEFAULT_SOUL,
      DEFAULT_DOOR,
      2,
      arrival.cid,
      DEFAULT_DOOR_ID,
      1,
      DEFAULT_RESIDENCY,
      "2026-01-02T02:00:00.000Z"
    );
    await store.append(departure.record);
  } finally {
    await store.close();
  }
}

async function buildTravelChain(dir: string): Promise<void> {
  const store = await FileSoulStore.open(dir);
  try {
    const genesis = await createGenesisRecord(DEFAULT_SOUL);
    await store.append(genesis.record);
    const arrival = await createArrivalRecord(
      DEFAULT_SOUL,
      DEFAULT_DOOR,
      DEFAULT_SESSION,
      1,
      genesis.cid,
      DEFAULT_DOOR_ID,
      1,
      DEFAULT_RESIDENCY,
      "2026-01-02T00:00:00.000Z"
    );
    await store.append(arrival.record);
    const travel = await createTravelRecord(
      DEFAULT_SOUL,
      2,
      arrival.cid,
      DEFAULT_DOOR_ID,
      1,
      DEFAULT_RESIDENCY,
      "2026-01-02T02:30:00.000Z"
    );
    await store.append(travel.record);
  } finally {
    await store.close();
  }
}

describe("torn tail policy", () => {
  it("returns verified false without mutating chain bytes", async () => {
    const copyDir = await makeTempDir("atlas-torn-tail-");
    await cp(MULTI_RESIDENCY_FIXTURE_DIR, copyDir, { recursive: true });
    const chainPath = join(copyDir, "chain.jsonl");
    const beforeBytes = await readFile(chainPath);
    const truncated = beforeBytes.subarray(0, beforeBytes.length - 20);
    await writeFile(chainPath, truncated);

    const app = await openServer(copyDir);
    try {
      const response = await app.inject({ method: "GET", url: "/state" });
      expect(response.statusCode).toBe(200);
      const body = response.json() as { verified: boolean; status: string };
      expect(body.verified).toBe(false);
      expect(body.status).toBe("present");
    } finally {
      await app.close();
    }

    const afterBytes = await readFile(chainPath);
    expect(afterBytes.equals(truncated)).toBe(true);
  });
});

describe("chain reload", () => {
  it("reflects newly appended records on subsequent requests", async () => {
    const dir = await makeTempDir("atlas-reload-");
    const store = await FileSoulStore.open(dir);
    try {
      const genesis = await createGenesisRecord(DEFAULT_SOUL);
      await store.append(genesis.record);
    } finally {
      await store.close();
    }

    const app = await openServer(dir);
    try {
      const before = await app.inject({ method: "GET", url: "/chain/head" });
      expect(before.json()).toMatchObject({ seq: 0, kind: "genesis" });

      const writer = await FileSoulStore.open(dir);
      try {
        const head = await writer.head();
        if (head === null) {
          throw new Error("expected head");
        }
        const arrival = await createArrivalRecord(
          DEFAULT_SOUL,
          DEFAULT_DOOR,
          DEFAULT_SESSION,
          1,
          head.cid,
          DEFAULT_DOOR_ID,
          1,
          DEFAULT_RESIDENCY,
          "2026-01-02T00:00:00.000Z"
        );
        await writer.append(arrival.record);
      } finally {
        await writer.close();
      }

      const after = await app.inject({ method: "GET", url: "/chain/head" });
      expect(after.json()).toMatchObject({ seq: 1, kind: "attestation/arrival" });
    } finally {
      await app.close();
    }
  });
});

describe("GET /records pagination", () => {
  it("filters by type, clamps per_page, handles out-of-range pages, and rejects invalid type", async () => {
    const app = await openServer(MULTI_RESIDENCY_FIXTURE_DIR);
    try {
      const filtered = await app.inject({
        method: "GET",
        url: "/records?type=attestation&per_page=3&page=1"
      });
      expect(filtered.statusCode).toBe(200);
      const filteredBody = filtered.json() as {
        records: Array<{ kind: string }>;
        total: number;
        per_page: number;
        verified: boolean;
      };
      expect(filteredBody.total).toBeGreaterThan(0);
      expect(filteredBody.records).toHaveLength(3);
      expect(filteredBody.per_page).toBe(3);
      expect(filteredBody.verified).toBe(true);
      for (const item of filteredBody.records) {
        expect(item.kind.startsWith("attestation/")).toBe(true);
      }

      const clamped = await app.inject({ method: "GET", url: "/records?per_page=999" });
      expect(clamped.json()).toMatchObject({ per_page: 200 });

      const outOfRange = await app.inject({ method: "GET", url: "/records?page=999" });
      const outBody = outOfRange.json() as { records: unknown[]; total: number };
      expect(outBody.records).toEqual([]);
      expect(outBody.total).toBeGreaterThan(0);

      const invalid = await app.inject({ method: "GET", url: "/records?type=not-a-type" });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json()).toEqual({
        error: {
          code: "invalid_type",
          message: "Unknown record type: not-a-type",
          details: { type: "not-a-type" }
        }
      });
    } finally {
      await app.close();
    }
  });
});

describe("GET /journals", () => {
  it("returns journals newest first and skips shards without journal", async () => {
    const app = await openServer(MULTI_RESIDENCY_FIXTURE_DIR);
    try {
      const response = await app.inject({ method: "GET", url: "/journals" });
      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        verified: boolean;
        journals: Array<{ epoch: number; journal: string; door_id: string }>;
      };
      expect(body.verified).toBe(true);
      expect(body.journals.length).toBeGreaterThanOrEqual(2);
      expect(body.journals[0]?.journal).toBe(JOURNAL_EPOCH_2);
      expect(body.journals[1]?.journal).toBe(JOURNAL_EPOCH_1);
      expect(body.journals[0]?.epoch).toBe(2);
      expect(body.journals[1]?.epoch).toBe(1);
      expect(body.journals[0]?.door_id).toBe(DEFAULT_OTHER_DOOR_ID);
      expect(body.journals[1]?.door_id).toBe(DEFAULT_DOOR_ID);
    } finally {
      await app.close();
    }
  });
});

describe("GET /records leak safety", () => {
  it("never exposes shard text containing the leak marker", async () => {
    const app = await openServer(MULTI_RESIDENCY_FIXTURE_DIR);
    try {
      const response = await app.inject({ method: "GET", url: "/records?per_page=200" });
      expect(response.statusCode).toBe(200);
      expect(response.body.includes(LEAK_SHARD_TEXT)).toBe(false);
    } finally {
      await app.close();
    }
  });
});
