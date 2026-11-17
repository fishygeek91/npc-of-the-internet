import { cp, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canonicalize, computeCidFromCanonicalBytes, FileSoulStore } from "@npc/osp-core";
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
  fixtureDoorPublicKeys,
  JOURNAL_EPOCH_1,
  JOURNAL_EPOCH_2,
  JOURNAL_EPOCH_3,
  LEAK_SHARD_TEXT,
  MULTI_RESIDENCY_FIXTURE_DIR
} from "./helpers/fixture-meta.js";
import { WEB_DOOR_ID } from "./helpers/fixed-keys.js";
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

function doorPublicKeys(): Readonly<Record<string, Uint8Array>> {
  return fixtureDoorPublicKeys();
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
      const endpoints = ["/state", "/chain/head", "/records", "/journals", "/residencies"];
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
      // The fixture ends with a travel record out of web:home.
      expect(body.status).toBe("traveling");
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
    const store = await FileSoulStore.open(dir, { doorPublicKeys: doorPublicKeys() });
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
        since: null,
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
        since: "2026-01-02T00:00:00.000Z",
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
      // `since` is the arrival time, not the latest heartbeat.
      expect(heartbeatResponse.json()).toMatchObject({
        status: "present",
        door_id: DEFAULT_DOOR_ID,
        epoch: 1,
        since: "2026-01-02T00:00:00.000Z",
        last_record_at: "2026-01-02T01:00:00.000Z",
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
        since: "2026-01-02T02:00:00.000Z",
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
        since: "2026-01-02T02:30:00.000Z",
        verified: true
      });
    } finally {
      await travelApp.close();
    }
  });
});

async function buildArrivalChain(dir: string): Promise<void> {
  const store = await FileSoulStore.open(dir, { doorPublicKeys: doorPublicKeys() });
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
  const store = await FileSoulStore.open(dir, { doorPublicKeys: doorPublicKeys() });
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
  const store = await FileSoulStore.open(dir, { doorPublicKeys: doorPublicKeys() });
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
  const store = await FileSoulStore.open(dir, { doorPublicKeys: doorPublicKeys() });
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
      // Truncation drops the final travel record; the departure before it still says traveling.
      expect(body.status).toBe("traveling");
    } finally {
      await app.close();
    }

    const afterBytes = await readFile(chainPath);
    expect(afterBytes.equals(truncated)).toBe(true);
  });
});

describe("schema-invalid mid-chain records", () => {
  it("returns 503 chain_unreadable on every endpoint (not 500) without path leak", async () => {
    const copyDir = await makeTempDir("atlas-schema-skew-");
    await cp(MULTI_RESIDENCY_FIXTURE_DIR, copyDir, { recursive: true });
    const chainPath = join(copyDir, "chain.jsonl");
    const chainText = await readFile(chainPath, "utf8");
    const lines = chainText.split("\n").filter((line) => line.length > 0);
    // Mutate a mid-chain line (not genesis, not head) with an unrecognized key.
    const midIndex = 1;
    const midLine = lines[midIndex];
    if (midLine === undefined || lines.length < 3) {
      throw new Error("fixture chain too short for mid-chain mutation");
    }

    const record = JSON.parse(midLine) as Record<string, unknown>;
    record.future_field = "x";
    const tamperedBytes = canonicalize(record);
    const tamperedCid = await computeCidFromCanonicalBytes(tamperedBytes);
    await writeFile(join(copyDir, "blobs", tamperedCid), tamperedBytes);
    lines[midIndex] = new TextDecoder().decode(tamperedBytes);
    await writeFile(chainPath, `${lines.join("\n")}\n`);

    const app = await openServer(copyDir);
    try {
      for (const url of ["/state", "/chain/head", "/records", "/journals", "/residencies"]) {
        const response = await app.inject({ method: "GET", url });
        expect(response.statusCode).toBe(503);
        expect(response.json()).toEqual({
          error: { code: "chain_unreadable", message: "chain is unreadable" }
        });
        expect(response.body.includes(copyDir)).toBe(false);
        expect(response.body.includes("blobs")).toBe(false);
      }
    } finally {
      await app.close();
    }
  });
});

describe("unreadable snapshot cache", () => {
  it("recovers after a missing blob is restored without chain.jsonl change", async () => {
    const copyDir = await makeTempDir("atlas-blob-restore-");
    await cp(MULTI_RESIDENCY_FIXTURE_DIR, copyDir, { recursive: true });
    const chainPath = join(copyDir, "chain.jsonl");
    const chainText = await readFile(chainPath, "utf8");
    const lines = chainText.split("\n").filter((line) => line.length > 0);
    const midLine = lines[1];
    if (midLine === undefined) {
      throw new Error("fixture chain too short for blob restore test");
    }
    const midCid = await computeCidFromCanonicalBytes(new TextEncoder().encode(midLine));
    const blobPath = join(copyDir, "blobs", midCid);
    const blobBytes = await readFile(blobPath);
    await rm(blobPath);

    const app = await openServer(copyDir);
    try {
      const broken = await app.inject({ method: "GET", url: "/state" });
      expect(broken.statusCode).toBe(503);
      expect(broken.json()).toEqual({
        error: { code: "chain_unreadable", message: "chain is unreadable" }
      });
      expect(broken.body.includes(copyDir)).toBe(false);

      await writeFile(blobPath, blobBytes);

      const recovered = await app.inject({ method: "GET", url: "/state" });
      expect(recovered.statusCode).toBe(200);
      expect(recovered.json()).toMatchObject({ status: "traveling", verified: true });
    } finally {
      await app.close();
    }
  });
});

describe("CORS", () => {
  it("reflects Origin on GET responses", async () => {
    const app = await openServer(MULTI_RESIDENCY_FIXTURE_DIR);
    try {
      const response = await app.inject({
        method: "GET",
        url: "/state",
        headers: { origin: "https://example.com" }
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers["access-control-allow-origin"]).toBe("https://example.com");
    } finally {
      await app.close();
    }
  });
});

describe("chain reload", () => {
  it("reflects newly appended records on subsequent requests", async () => {
    const dir = await makeTempDir("atlas-reload-");
    const store = await FileSoulStore.open(dir, { doorPublicKeys: doorPublicKeys() });
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

      const writer = await FileSoulStore.open(dir, { doorPublicKeys: doorPublicKeys() });
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
  it("returns journal records and legacy shard journals newest first, and paginates", async () => {
    const app = await openServer(MULTI_RESIDENCY_FIXTURE_DIR);
    try {
      const response = await app.inject({ method: "GET", url: "/journals" });
      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        verified: boolean;
        page: number;
        per_page: number;
        total: number;
        journals: Array<{ epoch: number; journal: string; door_id: string }>;
      };
      expect(body.verified).toBe(true);
      expect(body.page).toBe(1);
      expect(body.per_page).toBe(50);
      expect(body.total).toBe(3);
      expect(body.journals.map((entry) => [entry.door_id, entry.epoch, entry.journal])).toEqual([
        [WEB_DOOR_ID, 3, JOURNAL_EPOCH_3],
        [DEFAULT_OTHER_DOOR_ID, 2, JOURNAL_EPOCH_2],
        [DEFAULT_DOOR_ID, 1, JOURNAL_EPOCH_1]
      ]);

      const paged = await app.inject({ method: "GET", url: "/journals?per_page=1&page=2" });
      const pagedBody = paged.json() as {
        journals: Array<{ journal: string }>;
        per_page: number;
        total: number;
      };
      expect(pagedBody.per_page).toBe(1);
      expect(pagedBody.journals).toHaveLength(1);
      expect(pagedBody.journals[0]?.journal).toBe(JOURNAL_EPOCH_2);
      expect(pagedBody.total).toBe(body.total);

      const clamped = await app.inject({ method: "GET", url: "/journals?per_page=999" });
      expect(clamped.json()).toMatchObject({ per_page: 200, total: body.total });
    } finally {
      await app.close();
    }
  });
});

describe("GET /residencies", () => {
  it("lists each residency newest first with door, times, counts, journal and travel", async () => {
    const app = await openServer(MULTI_RESIDENCY_FIXTURE_DIR);
    try {
      const response = await app.inject({ method: "GET", url: "/residencies" });
      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        verified: boolean;
        total: number;
        residencies: Array<Record<string, unknown>>;
      };
      expect(body.verified).toBe(true);
      expect(body.total).toBe(3);
      expect(body.residencies[0]).toMatchObject({
        residency: "door:web:home/epoch:3",
        door_id: WEB_DOOR_ID,
        epoch: 3,
        arrived_at: "2026-01-04T00:00:00.000Z",
        departed_at: "2026-01-04T05:02:00.000Z",
        traveled_to: DEFAULT_DOOR_ID,
        counts: { witnessed: 1, declined: 1, screened: 1 },
        declined_reasons: ["private"],
        journal: { journal: JOURNAL_EPOCH_3 }
      });
      expect(body.residencies[1]).toMatchObject({
        door_id: DEFAULT_OTHER_DOOR_ID,
        epoch: 2,
        traveled_to: WEB_DOOR_ID,
        counts: { witnessed: 1, declined: 0, screened: 0 },
        journal: { journal: JOURNAL_EPOCH_2 }
      });
      // Residency 1: two shards plus a legacy candidate (counted in none of the buckets).
      expect(body.residencies[2]).toMatchObject({
        door_id: DEFAULT_DOOR_ID,
        epoch: 1,
        arrived_at: "2026-01-02T00:00:00.000Z",
        departed_at: "2026-01-02T02:00:00.000Z",
        traveled_to: DEFAULT_OTHER_DOOR_ID,
        counts: { witnessed: 2, declined: 0, screened: 0 },
        declined_reasons: [],
        journal: { journal: JOURNAL_EPOCH_1 }
      });
      expect(response.body.includes(LEAK_SHARD_TEXT)).toBe(false);

      const paged = await app.inject({ method: "GET", url: "/residencies?per_page=1&page=3" });
      expect(paged.json()).toMatchObject({
        page: 3,
        per_page: 1,
        total: 3,
        residencies: [{ epoch: 1 }]
      });

      const invalid = await app.inject({ method: "GET", url: "/residencies?page=abc" });
      expect(invalid.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("returns 503 when the chain is unreadable", async () => {
    const dir = await makeTempDir("atlas-residencies-missing-");
    const app = await openServer(dir);
    try {
      const response = await app.inject({ method: "GET", url: "/residencies" });
      expect(response.statusCode).toBe(503);
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

  it("serves published CAR and manifest CID sidecar when configured", async () => {
    const publishedDir = await makeTempDir("atlas-car-");
    const publishedCarPath = join(publishedDir, "soulchain-latest.car");
    const manifestCidPath = join(publishedDir, "manifest-cid.txt");
    const manifestCid = "bagu" + "c".repeat(57);
    await writeFile(publishedCarPath, Buffer.from([0x00, 0x01, 0x02]), "binary");
    await writeFile(manifestCidPath, `${manifestCid}\n`, "utf8");

    const app = await createAtlasServer({
      chainDir: MULTI_RESIDENCY_FIXTURE_DIR,
      port: 8787,
      doorPublicKeys: doorPublicKeys(),
      publishedCarPath,
      manifestCidPath
    });

    try {
      const carResponse = await app.inject({ method: "GET", url: "/soulchain-latest.car" });
      expect(carResponse.statusCode).toBe(200);
      expect(carResponse.headers["content-type"]).toBe("application/vnd.ipld.car");
      expect(carResponse.rawPayload).toEqual(Buffer.from([0x00, 0x01, 0x02]));

      const manifestResponse = await app.inject({ method: "GET", url: "/soulchain/manifest" });
      expect(manifestResponse.statusCode).toBe(200);
      expect(JSON.parse(manifestResponse.body)).toEqual({ manifestCid });
    } finally {
      await app.close();
    }
  });

  it("returns 404 when published CAR file is missing", async () => {
    const publishedDir = await makeTempDir("atlas-car-missing-");
    const publishedCarPath = join(publishedDir, "missing.car");
    const manifestCidPath = join(publishedDir, "manifest-cid.txt");

    const app = await createAtlasServer({
      chainDir: MULTI_RESIDENCY_FIXTURE_DIR,
      port: 8787,
      doorPublicKeys: doorPublicKeys(),
      publishedCarPath,
      manifestCidPath
    });

    try {
      const response = await app.inject({ method: "GET", url: "/soulchain-latest.car" });
      expect(response.statusCode).toBe(404);
      expect(JSON.parse(response.body).error.code).toBe("car_not_found");
    } finally {
      await app.close();
    }
  });
});
