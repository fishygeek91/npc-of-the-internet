/**
 * Shared conformance-vector parsing for the Node suite and the browser runner.
 *
 * The browser runner must not import the package root (that pulls in `node:fs`),
 * so this module only parses JSON. Callers hash side blobs with their own entry.
 */
import type { ChainRule } from "../../src/chain-types.js";

/** Every `ChainRule`. `parseVectorFile` rejects an `expected` value outside this list. */
const CHAIN_RULES: readonly ChainRule[] = [
  "bad_soul_sig",
  "broken_prev_link",
  "seq_gap",
  "schema_violation",
  "missing_cosigner",
  "forked_head",
  "bad_genesis",
  "bad_drift_evidence",
  "bad_tombstone",
  "bad_session_continuity",
  "presence_conflict"
];

/** One committed file under `spec/osp/vectors/`. */
export type VectorFile = {
  description: string;
  expected: "valid" | ChainRule;
  soulPublicKey: string;
  doorPublicKeys: Record<string, string>;
  records: unknown[];
  /** Optional side-blob map (CID → base64url bytes) for osp/0.2 vectors. */
  blobs?: Record<string, string>;
};

/** Type guard for stable ChainRule identifiers. */
function isChainRule(value: string): value is ChainRule {
  return CHAIN_RULES.some((rule) => rule === value);
}

/**
 * Copy a JSON object of strings.
 *
 * @throws {Error} when `value` is not an object or a value is not a string.
 */
function copyStringRecord(
  value: unknown,
  filename: string,
  label: string,
  emptyKeyMessage: string | undefined,
  valueMessage: string
): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${filename}: ${label} must be an object`);
  }
  const map: Record<string, string> = {};
  for (const [key, encoded] of Object.entries(value)) {
    if (emptyKeyMessage !== undefined && key.length === 0) {
      throw new Error(`${filename}: ${emptyKeyMessage}`);
    }
    if (typeof encoded !== "string") {
      throw new Error(`${filename}: ${valueMessage}`);
    }
    map[key] = encoded;
  }
  return map;
}

/** Collect text_hash / journal_hash values referenced by memory bodies in the vector. */
export function collectBodyContentHashes(records: readonly unknown[]): Set<string> {
  const hashes = new Set<string>();
  for (const record of records) {
    if (typeof record !== "object" || record === null) {
      continue;
    }
    const type = Reflect.get(record, "type");
    const body = Reflect.get(record, "body");
    if (type !== "memory" || typeof body !== "object" || body === null) {
      continue;
    }
    const textHash = Reflect.get(body, "text_hash");
    if (typeof textHash === "string") {
      hashes.add(textHash);
    }
    const journalHash = Reflect.get(body, "journal_hash");
    if (typeof journalHash === "string") {
      hashes.add(journalHash);
    }
  }
  return hashes;
}

/**
 * Parse and validate one committed conformance vector JSON object.
 *
 * @throws {Error} when a required field is missing or the wrong type.
 */
export function parseVectorFile(raw: string, filename: string): VectorFile {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`${filename}: vector root must be an object`);
  }

  const description = Reflect.get(parsed, "description");
  const expectedRaw = Reflect.get(parsed, "expected");
  const soulPublicKey = Reflect.get(parsed, "soulPublicKey");
  const recordsRaw = Reflect.get(parsed, "records");

  if (typeof description !== "string" || description.length === 0) {
    throw new Error(`${filename}: description must be a non-empty string`);
  }
  if (typeof soulPublicKey !== "string") {
    throw new Error(`${filename}: soulPublicKey must be a string`);
  }

  const doorPublicKeys = copyStringRecord(
    Reflect.get(parsed, "doorPublicKeys"),
    filename,
    "doorPublicKeys",
    "doorPublicKeys keys must be non-empty strings",
    "doorPublicKeys values must be base64url strings"
  );

  if (!Array.isArray(recordsRaw)) {
    throw new Error(`${filename}: records must be an array`);
  }
  const records: unknown[] = [];
  for (const record of recordsRaw) {
    records.push(record);
  }

  const blobsRaw = Reflect.get(parsed, "blobs");
  let blobs: Record<string, string> | undefined;
  if (blobsRaw !== undefined) {
    if (typeof blobsRaw !== "object" || blobsRaw === null || Array.isArray(blobsRaw)) {
      throw new Error(`${filename}: blobs must be an object when present`);
    }
    blobs = copyStringRecord(
      blobsRaw,
      filename,
      "blobs",
      undefined,
      "blobs values must be base64url strings"
    );
  }

  if (expectedRaw === "valid") {
    return withBlobs(
      {
        description,
        expected: "valid",
        soulPublicKey,
        doorPublicKeys,
        records
      },
      blobs
    );
  }

  if (typeof expectedRaw !== "string" || !isChainRule(expectedRaw)) {
    throw new Error(`${filename}: expected must be "valid" or a ChainRule`);
  }

  return withBlobs(
    {
      description,
      expected: expectedRaw,
      soulPublicKey,
      doorPublicKeys,
      records
    },
    blobs
  );
}

/**
 * Attach `blobs` only when the vector has the field, so the property is absent otherwise.
 */
function withBlobs(file: VectorFile, blobs: Record<string, string> | undefined): VectorFile {
  if (blobs === undefined) {
    return file;
  }
  return { ...file, blobs };
}
