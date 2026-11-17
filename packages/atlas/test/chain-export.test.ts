import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { decodeBase64Url, decodePublicKey, FileSoulStore } from "@npc/osp-core";
import { afterEach, describe, expect, it } from "vitest";

import { ifNoneMatchSatisfied } from "../src/export-chain.js";
import { createAtlasServer } from "../src/server.js";
import { createGenesisRecord, DEFAULT_SOUL } from "./helpers/chain-builder.js";
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
  type: string;
  sig: string;
  body: {
    soul_pubkey?: string;
    kind?: string;
    text_cid?: string;
    journal_cid?: string;
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
});

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
