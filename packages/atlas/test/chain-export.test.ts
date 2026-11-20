import { readFile, mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  contentAddressSideBlob,
  decodeBase64Url,
  decodeJournalBlob,
  decodePublicKey,
  encodeJournalBlob,
  FileSoulStore,
  OSP_SPEC_V02
} from "@npc/osp-core";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { ifNoneMatchSatisfied } from "../src/export-chain.js";
import {
  CHAIN_EXPORT_TAIL_CACHE_ENTRIES,
  chainExportTailCacheSize,
  createAtlasServer
} from "../src/server.js";
import {
  createArrivalRecord,
  createGenesisRecord,
  createHeartbeatRecord,
  createJournalRecord,
  createTombstoneRecord,
  DEFAULT_DOOR,
  DEFAULT_DOOR_ID,
  DEFAULT_RESIDENCY,
  DEFAULT_SESSION,
  DEFAULT_SOUL
} from "./helpers/chain-builder.js";
import {
  FIXTURE_DOOR_PUBLIC_KEYS_B64,
  fixtureDoorPublicKeys,
  LEAK_SHARD_TEXT,
  MULTI_RESIDENCY_FIXTURE_DIR
} from "./helpers/fixture-meta.js";

/**
 * Fill-byte private keys from `test/helpers/fixed-keys.ts`. They must never
 * appear in an export, including as a doorPublicKeys value.
 */
const FIXTURE_PRIVATE_KEYS = [
  "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc",
  "CAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg",
  "CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk",
  "CgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgo",
  "CwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCws"
];

type ExportRecord = {
  seq: number;
  prev: string | null;
  type: string;
  sig: string;
  body: {
    soul_pubkey?: string;
    kind?: string;
    text_cid?: string;
    journal_cid?: string;
    blob_cid?: string;
    text?: string;
    journal?: string;
  };
  summary?: string;
};

type ExportBody = {
  records: ExportRecord[];
  doorPublicKeys: Record<string, string>;
  blobs: Record<string, string>;
  verified?: boolean;
  status?: string;
};

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

function isExportBody(value: unknown): value is ExportBody {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  if (!("records" in value) || !("doorPublicKeys" in value) || !("blobs" in value)) {
    return false;
  }
  const records = value.records;
  const doorPublicKeys = value.doorPublicKeys;
  const blobs = value.blobs;
  return Array.isArray(records) && isStringRecord(doorPublicKeys) && isStringRecord(blobs);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every((entry) => typeof entry === "string");
}

function readExport(payload: unknown): ExportBody {
  if (!isExportBody(payload)) {
    throw new Error("chain export body is missing records, doorPublicKeys, or blobs");
  }
  return payload;
}

function headerEtag(headers: { etag?: string | string[] | number | undefined }): string {
  const etag = headers.etag;
  if (typeof etag !== "string" || !/^"[A-Za-z0-9_-]+"$/u.test(etag)) {
    throw new Error("export response is missing a strong ETag");
  }
  return etag;
}

function journalProse(encoded: string): string {
  const prose: unknown = JSON.parse(new TextDecoder().decode(decodeBase64Url(encoded)));
  if (typeof prose !== "string") {
    throw new Error("journal blob is not a string");
  }
  return prose;
}

const INVALID_AFTER = { error: { code: "invalid_request", message: "after must be a CID" } };
const UNKNOWN_AFTER = {
  error: { code: "export_after_unknown", message: "after is not a record on this chain" }
};

/** `GET /chain/export`, with an optional cursor and `If-None-Match`. */
async function getExport(app: FastifyInstance, after?: string, ifNoneMatch?: string) {
  const url =
    after === undefined ? "/chain/export" : `/chain/export?after=${encodeURIComponent(after)}`;
  if (ifNoneMatch === undefined) {
    return app.inject({ method: "GET", url });
  }
  return app.inject({ method: "GET", url, headers: { "if-none-match": ifNoneMatch } });
}

describe("GET /chain/export", () => {
  it("returns ordered records, public door keys, and journal blobs only", async () => {
    const app = await createAtlasServer({
      chainDir: MULTI_RESIDENCY_FIXTURE_DIR,
      port: 8787,
      doorPublicKeys: fixtureDoorPublicKeys()
    });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/chain/export",
        headers: { origin: "https://shrine.example" }
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers["access-control-allow-origin"]).toBe("https://shrine.example");
      expect(String(response.headers["access-control-expose-headers"])).toMatch(/etag/iu);
      expect(response.headers["cache-control"]).toBe("no-cache");
      const etag = response.headers.etag;
      expect(etag).toMatch(/^"[A-Za-z0-9_-]+"$/u);

      const body = readExport(response.json());
      expect(body.verified).toBeUndefined();
      expect(body.status).toBeUndefined();
      expect(body.doorPublicKeys).toEqual(FIXTURE_DOOR_PUBLIC_KEYS_B64);
      for (const encoded of Object.values(body.doorPublicKeys)) {
        expect(decodePublicKey(encoded)).toHaveLength(32);
      }
      for (const privateKey of FIXTURE_PRIVATE_KEYS) {
        expect(response.body.includes(privateKey)).toBe(false);
      }
      expect(response.body.includes(LEAK_SHARD_TEXT)).toBe(false);

      expect(body.records[0]?.type).toBe("genesis");
      expect(typeof body.records[0]?.sig).toBe("string");
      expect(typeof body.records[0]?.body.soul_pubkey).toBe("string");
      expect(body.records[0]?.summary).toBeUndefined();
      for (let index = 1; index < body.records.length; index += 1) {
        const previous = body.records[index - 1];
        const current = body.records[index];
        expect(previous).toBeDefined();
        expect(current).toBeDefined();
        if (previous === undefined || current === undefined) {
          continue;
        }
        expect(current.seq).toBe(previous.seq + 1);
      }

      let journalBlobs = 0;
      for (const record of body.records) {
        if (record.body.text !== undefined || record.body.journal !== undefined) {
          expect(record.body.text ?? "").not.toContain(LEAK_SHARD_TEXT);
        }
        const textCid = record.body.text_cid;
        if (textCid !== undefined && textCid !== record.body.journal_cid) {
          expect(body.blobs[textCid]).toBeUndefined();
        }
        const journalCid = record.body.journal_cid;
        if (journalCid !== undefined) {
          const encoded = body.blobs[journalCid];
          if (encoded === undefined) {
            throw new Error(`journal blob ${journalCid} missing from export`);
          }
          const prose: unknown = JSON.parse(new TextDecoder().decode(decodeBase64Url(encoded)));
          expect(typeof prose).toBe("string");
          expect(prose).not.toBe(LEAK_SHARD_TEXT);
          journalBlobs += 1;
        }
      }
      expect(journalBlobs).toBeGreaterThan(0);

      const cached = await app.inject({
        method: "GET",
        url: "/chain/export",
        headers: { "if-none-match": String(etag) }
      });
      expect(cached.statusCode).toBe(304);
      expect(cached.body).toBe("");
      expect(cached.headers.etag).toBe(etag);

      const weak = await app.inject({
        method: "GET",
        url: "/chain/export",
        headers: { "if-none-match": `W/${String(etag)}` }
      });
      expect(weak.statusCode).toBe(304);

      const stale = await app.inject({
        method: "GET",
        url: "/chain/export",
        headers: { "if-none-match": '"not-the-export"' }
      });
      expect(stale.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("returns an empty door-key map when none are configured", async () => {
    const dir = await makeTempDir("atlas-export-nokeys-");
    const store = await FileSoulStore.open(dir);
    try {
      const genesis = await createGenesisRecord(DEFAULT_SOUL);
      await store.append(genesis.record);
    } finally {
      await store.close();
    }

    const app = await createAtlasServer({ chainDir: dir, port: 8787 });
    try {
      const response = await app.inject({ method: "GET", url: "/chain/export" });
      expect(response.statusCode).toBe(200);
      const body = readExport(response.json());
      expect(body.records.map((record) => record.type)).toEqual(["genesis"]);
      expect(body.doorPublicKeys).toEqual({});
      expect(body.blobs).toEqual({});
    } finally {
      await app.close();
    }
  });

  it("uses the public error shape when the chain cannot be read", async () => {
    const missing = join(await makeTempDir("atlas-export-missing-"), "absent");
    const app = await createAtlasServer({ chainDir: missing, port: 8787 });
    try {
      const response = await app.inject({ method: "GET", url: "/chain/export" });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        error: { code: "chain_unreadable", message: "chain is unreadable" }
      });
    } finally {
      await app.close();
    }
  });

  it("omits a tombstoned journal blob that is still on disk", async () => {
    const prose = "TOMBSTONED_JOURNAL_PROSE";
    const dir = await makeTempDir("atlas-export-tomb-");
    const written = await writeJournalChain(dir, prose);
    const keys = fixtureDoorPublicKeys();
    const store = await FileSoulStore.open(dir, { doorPublicKeys: keys });
    try {
      const tombstone = await createTombstoneRecord(
        DEFAULT_SOUL,
        3,
        written.recordCid,
        written.recordCid,
        written.journalCid,
        "2026-01-03T00:00:00.000Z"
      );
      await store.append(tombstone.record);
    } finally {
      await store.close();
    }

    const onDisk = await readFile(join(dir, "blobs", written.journalCid));
    expect(decodeJournalBlob(new Uint8Array(onDisk))).toBe(prose);

    const app = await createAtlasServer({ chainDir: dir, port: 8787, doorPublicKeys: keys });
    try {
      const response = await app.inject({ method: "GET", url: "/chain/export" });
      expect(response.statusCode).toBe(200);
      const body = readExport(response.json());
      expect(body.blobs[written.journalCid]).toBeUndefined();
      expect(response.body.includes(prose)).toBe(false);
      expect(body.records.map((record) => record.type)).toEqual([
        "genesis",
        "attestation",
        "memory",
        "tombstone"
      ]);
      const journal = body.records[2];
      expect(journal?.body.journal_cid).toBe(written.journalCid);
    } finally {
      await app.close();
    }
  });

  it("returns 200 when a journal blob is missing and leaves the record in place", async () => {
    const prose = "MISSING_JOURNAL_PROSE";
    const dir = await makeTempDir("atlas-export-missing-blob-");
    const written = await writeJournalChain(dir, prose);
    await unlink(join(dir, "blobs", written.journalCid));

    const app = await createAtlasServer({
      chainDir: dir,
      port: 8787,
      doorPublicKeys: fixtureDoorPublicKeys()
    });
    try {
      const response = await app.inject({ method: "GET", url: "/chain/export" });
      expect(response.statusCode).toBe(200);
      const body = readExport(response.json());
      expect(body.blobs[written.journalCid]).toBeUndefined();
      expect(body.records.map((record) => record.type)).toEqual([
        "genesis",
        "attestation",
        "memory"
      ]);
      expect(body.records[2]?.body.journal_cid).toBe(written.journalCid);
      expect(response.body.includes(prose)).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("sends CORS headers on 200 and 304 and does not allow credentials", async () => {
    const app = await createAtlasServer({
      chainDir: MULTI_RESIDENCY_FIXTURE_DIR,
      port: 8787,
      doorPublicKeys: fixtureDoorPublicKeys()
    });
    try {
      const origin = "https://shrine.example";
      const first = await app.inject({
        method: "GET",
        url: "/chain/export",
        headers: { origin }
      });
      expect(first.statusCode).toBe(200);
      expect(first.headers["access-control-allow-origin"]).toBe(origin);
      expect(String(first.headers["access-control-expose-headers"])).toMatch(/etag/iu);
      expect(first.headers["access-control-allow-credentials"]).toBeUndefined();
      const etag = String(first.headers.etag);

      const cached = await app.inject({
        method: "GET",
        url: "/chain/export",
        headers: { origin, "if-none-match": etag }
      });
      expect(cached.statusCode).toBe(304);
      expect(cached.body).toBe("");
      expect(cached.headers.etag).toBe(etag);
      expect(cached.headers["access-control-allow-origin"]).toBe(origin);
      expect(String(cached.headers["access-control-expose-headers"])).toMatch(/etag/iu);
      expect(cached.headers["access-control-allow-credentials"]).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it("changes the ETag after an append and keeps it while the chain is unchanged", async () => {
    const dir = await makeTempDir("atlas-export-etag-");
    const keys = fixtureDoorPublicKeys();
    const store = await FileSoulStore.open(dir, { doorPublicKeys: keys });
    try {
      const genesis = await createGenesisRecord(DEFAULT_SOUL);
      await store.append(genesis.record);
    } finally {
      await store.close();
    }

    const app = await createAtlasServer({ chainDir: dir, port: 8787, doorPublicKeys: keys });
    try {
      const first = await app.inject({ method: "GET", url: "/chain/export" });
      expect(first.statusCode).toBe(200);
      const etag = String(first.headers.etag);
      const again = await app.inject({ method: "GET", url: "/chain/export" });
      expect(again.headers.etag).toBe(etag);
      const notModified = await app.inject({
        method: "GET",
        url: "/chain/export",
        headers: { "if-none-match": etag }
      });
      expect(notModified.statusCode).toBe(304);

      const writer = await FileSoulStore.open(dir, { doorPublicKeys: keys });
      try {
        const head = await writer.head();
        if (head === null) {
          throw new Error("expected a chain head");
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

      const after = await app.inject({
        method: "GET",
        url: "/chain/export",
        headers: { "if-none-match": etag }
      });
      expect(after.statusCode).toBe(200);
      const next = String(after.headers.etag);
      expect(next).not.toBe(etag);
      const settled = await app.inject({ method: "GET", url: "/chain/export" });
      expect(settled.headers.etag).toBe(next);
      expect(settled.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("returns the tail after genesis, a middle record, and the head", async () => {
    const prose = "TAIL_JOURNAL_PROSE";
    const dir = await makeTempDir("atlas-export-after-");
    const written = await writeJournalChain(dir, prose);
    const app = await createAtlasServer({
      chainDir: dir,
      port: 8787,
      doorPublicKeys: fixtureDoorPublicKeys()
    });
    try {
      const fullResponse = await getExport(app);
      const fullBody = readExport(fullResponse.json());
      const afterGenesis = await getExport(app, written.genesisCid);
      expect(afterGenesis.statusCode).toBe(200);
      expect(afterGenesis.headers["cache-control"]).toBe("no-cache");
      const genesisTail = readExport(afterGenesis.json());
      expect(genesisTail.doorPublicKeys).toEqual(fullBody.doorPublicKeys);
      expect(genesisTail.records.map((record) => record.seq)).toEqual([1, 2]);
      expect(genesisTail.records[0]).toMatchObject({
        prev: written.genesisCid,
        seq: 1,
        type: "attestation"
      });
      expect(genesisTail.records[1]).toMatchObject({
        prev: written.arrivalCid,
        seq: 2,
        type: "memory",
        body: { journal_cid: written.journalCid }
      });
      const encoded = genesisTail.blobs[written.journalCid];
      if (typeof encoded !== "string") {
        throw new Error("journal blob missing from the genesis tail");
      }
      expect(journalProse(encoded)).toBe(prose);

      const afterMiddle = await getExport(app, written.arrivalCid);
      expect(afterMiddle.statusCode).toBe(200);
      const middleTail = readExport(afterMiddle.json());
      expect(middleTail.records).toHaveLength(1);
      expect(middleTail.records[0]).toMatchObject({
        prev: written.arrivalCid,
        seq: 2,
        body: { journal_cid: written.journalCid }
      });
      expect(typeof middleTail.blobs[written.journalCid]).toBe("string");

      const afterHead = await getExport(app, written.recordCid);
      expect(afterHead.statusCode).toBe(200);
      const headTail = readExport(afterHead.json());
      expect(headTail.records).toEqual([]);
      expect(headTail.blobs).toEqual({});
      expect(headTail.doorPublicKeys).toEqual(fullBody.doorPublicKeys);
      expect(afterHead.body.includes(prose)).toBe(false);

      const fullTag = headerEtag(fullResponse.headers);
      const genesisTag = headerEtag(afterGenesis.headers);
      const middleTag = headerEtag(afterMiddle.headers);
      const headTag = headerEtag(afterHead.headers);
      expect(new Set([fullTag, genesisTag, middleTag, headTag]).size).toBe(4);
      const cached = await getExport(app, written.arrivalCid, middleTag);
      expect(cached.statusCode).toBe(304);
      expect(cached.body).toBe("");
      expect(cached.headers.etag).toBe(middleTag);
      expect((await getExport(app, written.arrivalCid, `W/${middleTag}`)).statusCode).toBe(304);
      expect((await getExport(app, written.recordCid, "*")).statusCode).toBe(304);
      expect((await getExport(app, written.arrivalCid, fullTag)).statusCode).toBe(200);
      expect((await getExport(app, written.genesisCid, middleTag)).statusCode).toBe(200);

      for (const cid of [written.journalCid, `bagu${"a".repeat(57)}`]) {
        const missing = await getExport(app, cid);
        expect(missing.statusCode, cid).toBe(404);
        expect(missing.json(), cid).toEqual(UNKNOWN_AFTER);
      }
    } finally {
      await app.close();
    }
  });

  it("rejects a malformed after with 400 invalid_request", async () => {
    const app = await createAtlasServer({
      chainDir: join(await makeTempDir("atlas-export-after-bad-"), "absent"),
      port: 8787
    });
    try {
      const badValues = [
        "",
        "../etc/passwd",
        "bagu",
        `bagu${"A".repeat(57)}`,
        `bagu${"Z".repeat(57)}`,
        `bagu${"a".repeat(20)}/${"a".repeat(36)}`,
        ` bagu${"a".repeat(57)}`
      ];
      for (const value of badValues) {
        const response = await getExport(app, value);
        expect(response.statusCode, value).toBe(400);
        expect(response.json(), value).toEqual(INVALID_AFTER);
      }
      const duplicate = await app.inject({
        method: "GET",
        url: `/chain/export?after=bagu${"a".repeat(57)}&after=bagu${"b".repeat(57)}`
      });
      expect(duplicate.statusCode).toBe(400);
      expect(duplicate.json()).toEqual(INVALID_AFTER);
    } finally {
      await app.close();
    }
  });

  it("names a tail tombstone's blob_cid and does not return that blob", async () => {
    const prose = "TAIL_TOMBSTONE_PROSE";
    const dir = await makeTempDir("atlas-export-after-tomb-");
    const written = await writeJournalChain(dir, prose);
    const keys = fixtureDoorPublicKeys();
    const store = await FileSoulStore.open(dir, { doorPublicKeys: keys });
    try {
      const tombstone = await createTombstoneRecord(
        DEFAULT_SOUL,
        3,
        written.recordCid,
        written.recordCid,
        written.journalCid,
        "2026-01-03T00:00:00.000Z"
      );
      await store.append(tombstone.record);
    } finally {
      await store.close();
    }
    const app = await createAtlasServer({ chainDir: dir, port: 8787, doorPublicKeys: keys });
    try {
      const withJournal = await getExport(app, written.arrivalCid);
      expect(withJournal.statusCode).toBe(200);
      const both = readExport(withJournal.json());
      expect(both.records.map((record) => record.type)).toEqual(["memory", "tombstone"]);
      expect(both.records[1]).toMatchObject({ body: { blob_cid: written.journalCid } });
      expect(both.blobs[written.journalCid]).toBeUndefined();
      expect(withJournal.body.includes(prose)).toBe(false);

      const onlyTombstone = await getExport(app, written.recordCid);
      const tail = readExport(onlyTombstone.json());
      expect(tail.records[0]).toMatchObject({
        prev: written.recordCid,
        type: "tombstone",
        body: { blob_cid: written.journalCid }
      });
      expect(tail.blobs).toEqual({});
    } finally {
      await app.close();
    }
  });

  it("changes the ETag for the same after when the chain grows", async () => {
    const dir = await makeTempDir("atlas-export-grow-");
    const written = await writeJournalChain(dir, "GROW_ETAG_PROSE");
    const keys = fixtureDoorPublicKeys();
    const app = await createAtlasServer({ chainDir: dir, port: 8787, doorPublicKeys: keys });
    try {
      const before = await getExport(app, written.genesisCid);
      const beforeTag = headerEtag(before.headers);
      const store = await FileSoulStore.open(dir, { doorPublicKeys: keys });
      try {
        const heartbeat = await createHeartbeatRecord(
          DEFAULT_SOUL,
          DEFAULT_DOOR,
          DEFAULT_SESSION,
          3,
          written.recordCid,
          DEFAULT_DOOR_ID,
          1,
          DEFAULT_RESIDENCY,
          "2026-01-02T03:00:00.000Z",
          OSP_SPEC_V02
        );
        await store.append(heartbeat.record);
      } finally {
        await store.close();
      }
      const after = await getExport(app, written.genesisCid);
      expect(headerEtag(after.headers)).not.toBe(beforeTag);
      expect(readExport(after.json()).records.map((record) => record.seq)).toEqual([1, 2, 3]);
    } finally {
      await app.close();
    }
  });

  it("keeps at most the tail-cache limit and still serves evicted cursors", async () => {
    const dir = await makeTempDir("atlas-export-lru-");
    const cids = await writeCursorChain(dir, CHAIN_EXPORT_TAIL_CACHE_ENTRIES);
    const app = await createAtlasServer({
      chainDir: dir,
      port: 8787,
      doorPublicKeys: fixtureDoorPublicKeys()
    });
    try {
      const saved: Array<{ etag: string; seqs: number[] }> = [];
      for (const cid of cids) {
        const response = await getExport(app, cid);
        expect(response.statusCode).toBe(200);
        saved.push({
          etag: headerEtag(response.headers),
          seqs: readExport(response.json()).records.map((record) => record.seq)
        });
        expect(chainExportTailCacheSize(app)).toBeLessThanOrEqual(CHAIN_EXPORT_TAIL_CACHE_ENTRIES);
      }
      expect(cids.length).toBeGreaterThan(CHAIN_EXPORT_TAIL_CACHE_ENTRIES);
      expect(chainExportTailCacheSize(app)).toBe(CHAIN_EXPORT_TAIL_CACHE_ENTRIES);
      for (const index of [0, cids.length - 1]) {
        const cid = cids[index];
        const prior = saved[index];
        if (cid === undefined || prior === undefined) {
          throw new Error("missing cached cursor");
        }
        const again = await getExport(app, cid);
        expect(headerEtag(again.headers)).toBe(prior.etag);
        expect(readExport(again.json()).records.map((record) => record.seq)).toEqual(prior.seqs);
        expect(chainExportTailCacheSize(app)).toBeLessThanOrEqual(CHAIN_EXPORT_TAIL_CACHE_ENTRIES);
      }
    } finally {
      await app.close();
    }
  });
});

/** Genesis, arrival, then `extraHeartbeats` heartbeats. Returns every record CID. */
async function writeCursorChain(dir: string, extraHeartbeats: number): Promise<string[]> {
  const store = await FileSoulStore.open(dir, { doorPublicKeys: fixtureDoorPublicKeys() });
  try {
    const cids: string[] = [];
    const genesis = await createGenesisRecord(DEFAULT_SOUL);
    await store.append(genesis.record);
    cids.push(genesis.cid);
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
    cids.push(arrival.cid);
    let prev = arrival.cid;
    for (let index = 0; index < extraHeartbeats; index += 1) {
      const heartbeat = await createHeartbeatRecord(
        DEFAULT_SOUL,
        DEFAULT_DOOR,
        DEFAULT_SESSION,
        index + 2,
        prev,
        DEFAULT_DOOR_ID,
        1,
        DEFAULT_RESIDENCY,
        `2026-01-02T00:00:${String(index).padStart(2, "0")}.000Z`
      );
      await store.append(heartbeat.record);
      cids.push(heartbeat.cid);
      prev = heartbeat.cid;
    }
    return cids;
  } finally {
    await store.close();
  }
}

/** Genesis, arrival, and one journal blob still stored under `blobs/`. */
async function writeJournalChain(
  dir: string,
  prose: string
): Promise<{
  genesisCid: string;
  arrivalCid: string;
  journalCid: string;
  recordCid: string;
}> {
  const store = await FileSoulStore.open(dir, { doorPublicKeys: fixtureDoorPublicKeys() });
  try {
    const genesis = await createGenesisRecord(DEFAULT_SOUL, OSP_SPEC_V02);
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
      "2026-01-02T00:00:00.000Z",
      OSP_SPEC_V02
    );
    await store.append(arrival.record);
    const bytes = encodeJournalBlob(prose);
    const address = await contentAddressSideBlob(bytes);
    await store.putSideBlob(bytes);
    const journal = await createJournalRecord(
      DEFAULT_SOUL,
      DEFAULT_DOOR,
      2,
      arrival.cid,
      address,
      DEFAULT_RESIDENCY,
      "2026-01-02T02:00:00.000Z"
    );
    await store.append(journal.record);
    return {
      genesisCid: genesis.cid,
      arrivalCid: arrival.cid,
      journalCid: address.cid,
      recordCid: journal.cid
    };
  } finally {
    await store.close();
  }
}

describe("ifNoneMatchSatisfied", () => {
  it("matches a list, a weak tag, and star, and rejects other tags", () => {
    const etag = '"abc"';
    expect(ifNoneMatchSatisfied(undefined, etag)).toBe(false);
    expect(ifNoneMatchSatisfied("  ", etag)).toBe(false);
    expect(ifNoneMatchSatisfied("*", etag)).toBe(true);
    expect(ifNoneMatchSatisfied('"other", "abc"', etag)).toBe(true);
    expect(ifNoneMatchSatisfied('W/"abc"', etag)).toBe(true);
    expect(ifNoneMatchSatisfied('"nope"', etag)).toBe(false);
  });
});
