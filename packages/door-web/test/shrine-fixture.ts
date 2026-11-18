import { createServer, type Server } from "node:http";

import {
  contentAddressSideBlob,
  createRecord,
  encodeBase64Url,
  encodeJournalBlob,
  encodePublicKey,
  generateKeypair,
  OSP_SPEC_V02,
  POP_VERSION,
  signCore,
  type Ed25519Keypair,
  type OspRecord
} from "@npc/osp-core";

import type { ShrineConfig } from "../src/browser/shrine-chain.js";

export const DOOR_ID = "web:test";
export const RESIDENCY = "door:web:test/epoch:1";
export const PROSE = "A quiet road.";
export const LEAK = "LEAK_SHARD_TEXT";

export type BuiltStay = {
  records: OspRecord[];
  blobs: Record<string, string>;
  journalCid: string;
  headCid: string;
};

/** Pins for a shrine pointed at a local export. */
export function pins(atlasUrl: string, soul: Ed25519Keypair, soulPublicKey?: string): ShrineConfig {
  return {
    atlasUrl,
    porchUrl: "https://porch.example/",
    mount: "#wanderer-shrine",
    soulPublicKey: soulPublicKey ?? encodePublicKey(soul.publicKey),
    doorPublicKeys: null
  };
}

/** Genesis, arrival, a shard whose text must not render, and one journal. */
export async function stay(
  soul: Ed25519Keypair,
  door: Ed25519Keypair,
  options: { tombstone?: boolean } = {}
): Promise<BuiltStay> {
  const session = generateKeypair();
  const journalBytes = encodeJournalBlob(PROSE);
  const journal = await contentAddressSideBlob(journalBytes);
  const leakBytes = encodeJournalBlob(LEAK);
  const leak = await contentAddressSideBlob(leakBytes);
  const genesis = await createRecord({
    spec: OSP_SPEC_V02,
    seq: 0,
    prev: null,
    type: "genesis",
    body: {
      charter: "# Wanderer\n\nI travel.",
      soul_pubkey: encodePublicKey(soul.publicKey),
      created_at: "2026-01-01T00:00:00.000Z"
    },
    residency: null,
    cosigners: [],
    soulPrivateKey: soul.privateKey
  });
  const arrival = await witnessed(soul, door, 1, genesis.cid, "attestation", {
    kind: "arrival",
    pop_version: POP_VERSION,
    door_id: DOOR_ID,
    epoch: 1,
    session_pubkey: encodePublicKey(session.publicKey),
    at: "2026-01-02T00:00:00.000Z"
  });
  const shard = await witnessed(soul, door, 2, arrival.cid, "memory", {
    kind: "shard",
    text_cid: leak.cid,
    text_hash: leak.hash,
    distilled_at: "2026-01-02T01:00:00.000Z"
  });
  const journalRecord = await witnessed(soul, door, 3, shard.cid, "memory", {
    kind: "journal",
    journal_cid: journal.cid,
    journal_hash: journal.hash,
    written_at: "2026-01-02T02:00:00.000Z"
  });
  const records = [genesis.record, arrival.record, shard.record, journalRecord.record];
  let headCid = journalRecord.cid;
  if (options.tombstone === true) {
    const tombstone = await createRecord({
      spec: OSP_SPEC_V02,
      seq: 4,
      prev: journalRecord.cid,
      type: "tombstone",
      body: {
        target_cid: journalRecord.cid,
        blob_cid: journal.cid,
        reason: "erasure_request",
        erased_at: "2026-01-03T00:00:00.000Z"
      },
      residency: null,
      cosigners: [],
      soulPrivateKey: soul.privateKey
    });
    records.push(tombstone.record);
    headCid = tombstone.cid;
  }
  return {
    records,
    blobs: {
      [journal.cid]: encodeBase64Url(journalBytes),
      [leak.cid]: encodeBase64Url(leakBytes)
    },
    journalCid: journal.cid,
    headCid
  };
}

/** Serve one export body, including a 304 when `If-None-Match` repeats the tag. */
export function serveExport(
  body: unknown,
  options: { etag?: string } = {}
): Promise<{ url: string; close: () => Promise<void> }> {
  const etag = options.etag ?? '"export"';
  const server: Server = createServer((request, response) => {
    const path = (request.url ?? "/").split("?")[0];
    if (path !== "/chain/export") {
      response.writeHead(404);
      response.end();
      return;
    }
    if (request.headers["if-none-match"] === etag) {
      response.writeHead(304, { ETag: etag });
      response.end();
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json", ETag: etag });
    response.end(JSON.stringify(body));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("export server failed to bind"));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${String(address.port)}`,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
          })
      });
    });
  });
}

async function witnessed(
  soul: Ed25519Keypair,
  door: Ed25519Keypair,
  seq: number,
  prev: string,
  type: "attestation" | "memory",
  body: { kind: string }
): Promise<{ record: OspRecord; cid: string }> {
  const fields = {
    spec: OSP_SPEC_V02,
    seq,
    prev,
    type,
    body,
    residency: RESIDENCY
  };
  return createRecord({
    ...fields,
    cosigners: [signCore(fields, door.privateKey)],
    soulPrivateKey: soul.privateKey
  });
}
