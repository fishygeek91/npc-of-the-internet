import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { canonicalize } from "../src/canonical.js";
import { computeCidFromCanonicalBytes } from "../src/crypto/cid.js";
import { CorruptionError, StorageError } from "../src/errors.js";
import { BlobDir } from "../src/store/blob-dir.js";

const SAMPLE_RECORD = {
  body: { kind: "shard", text: "I remember the rain." },
  cosigners: [],
  prev: "bagu" + "a".repeat(57),
  residency: "door:discord:guild123/epoch:77",
  seq: 42,
  sig: "abc",
  spec: "osp/0.1",
  type: "memory"
};

describe("BlobDir", () => {
  let dir: string;
  let blobs: BlobDir;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "osp-blobdir-"));
    blobs = new BlobDir(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("putIdempotent and readVerified roundtrip", async () => {
    const bytes = canonicalize(SAMPLE_RECORD);
    const cid = await computeCidFromCanonicalBytes(bytes);

    await blobs.putIdempotent(cid, bytes);
    const readBack = await blobs.readVerified(cid);
    expect(readBack).toEqual(bytes);
  });

  it("treats identical putIdempotent as a no-op", async () => {
    const bytes = canonicalize(SAMPLE_RECORD);
    const cid = await computeCidFromCanonicalBytes(bytes);

    await blobs.putIdempotent(cid, bytes);
    await blobs.putIdempotent(cid, bytes);

    const readBack = await blobs.readVerified(cid);
    expect(readBack).toEqual(bytes);
  });

  it("throws CorruptionError when existing blob bytes differ", async () => {
    const bytes = canonicalize(SAMPLE_RECORD);
    const cid = await computeCidFromCanonicalBytes(bytes);
    const other = new Uint8Array([0xde, 0xad]);

    await blobs.putIdempotent(cid, bytes);
    await expect(blobs.putIdempotent(cid, other)).rejects.toThrow(CorruptionError);
    await expect(blobs.putIdempotent(cid, other)).rejects.toThrow(
      `blob already exists for CID ${cid} with different bytes`
    );
  });

  it("rejects invalid CID format", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    await expect(blobs.putIdempotent("not-a-cid", bytes)).rejects.toThrow(StorageError);
    await expect(blobs.putIdempotent("not-a-cid", bytes)).rejects.toThrow(
      "invalid CID format: not-a-cid"
    );
    await expect(blobs.readVerified("not-a-cid")).rejects.toThrow(StorageError);
  });

  it("throws StorageError when blob is missing (default not_found)", async () => {
    const bytes = canonicalize(SAMPLE_RECORD);
    const cid = await computeCidFromCanonicalBytes(bytes);

    await expect(blobs.readVerified(cid)).rejects.toThrow(StorageError);
    await expect(blobs.readVerified(cid)).rejects.toThrow(`record not found for CID ${cid}`);
  });

  it("throws CorruptionError when blob is missing with corruption missingAs", async () => {
    const bytes = canonicalize(SAMPLE_RECORD);
    const cid = await computeCidFromCanonicalBytes(bytes);

    await expect(blobs.readBytes(cid, { missingAs: "corruption" })).rejects.toThrow(
      CorruptionError
    );
    await expect(blobs.readBytes(cid, { missingAs: "corruption" })).rejects.toThrow(
      `missing blob for CID ${cid}`
    );
  });

  it("throws CorruptionError when on-disk bytes do not match CID", async () => {
    const bytes = canonicalize(SAMPLE_RECORD);
    const cid = await computeCidFromCanonicalBytes(bytes);
    const wrongBytes = new Uint8Array([9, 9, 9]);

    await writeFile(path.join(dir, cid), wrongBytes);
    await expect(blobs.readVerified(cid)).rejects.toThrow(CorruptionError);
    await expect(blobs.readVerified(cid)).rejects.toThrow(/blob CID mismatch/);

    const disk = await readFile(path.join(dir, cid));
    expect(disk.equals(Buffer.from(wrongBytes))).toBe(true);
  });

  it("delete removes a blob and is idempotent when missing", async () => {
    const bytes = canonicalize(SAMPLE_RECORD);
    const cid = await computeCidFromCanonicalBytes(bytes);

    await blobs.putIdempotent(cid, bytes);
    await blobs.delete(cid);
    await expect(blobs.readVerified(cid)).rejects.toThrow(StorageError);
    await blobs.delete(cid);
  });
});
