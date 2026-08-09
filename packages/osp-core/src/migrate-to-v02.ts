import { computeCid } from "./crypto/cid.js";
import { EncodingError, StorageError } from "./errors.js";
import { contentAddressSideBlob, encodeJournalBlob, encodeShardTextBlob } from "./memory-blob.js";
import { createRecord, signCore, type CreateRecordFields } from "./record.js";
import { OSP_SPEC_V01, OSP_SPEC_V02 } from "./schemas/body.js";
import { parseResidency, type OspRecord } from "./schemas/index.js";

/** Options for {@link migrateChainToV02}. */
export type MigrateChainToV02Options = {
  records: readonly OspRecord[];
  soulPrivateKey: Uint8Array;
  /**
   * Door private keys keyed by Door id (residency `door:<id>/epoch:n` → id).
   * Required for every record that has non-empty `cosigners`.
   */
  doorPrivateKeys: Readonly<Record<string, Uint8Array>>;
};

/** Result of {@link migrateChainToV02}. */
export type MigrateChainToV02Result = {
  records: OspRecord[];
  /** Side-blob bytes keyed by content CID. */
  blobs: Map<string, Uint8Array>;
  /** Old record CID → new record CID (for operator notes / evidence rewrites). */
  cidMap: Map<string, string>;
};

/**
 * Rewrite a CID string through the migration map when present.
 */
function remapCid(cid: string, cidMap: ReadonlyMap<string, string>): string {
  return cidMap.get(cid) ?? cid;
}

/**
 * Build an osp/0.2 memory body from an osp/0.1 inline body, collecting blob bytes.
 */
async function migrateMemoryBody(
  body: Extract<OspRecord, { type: "memory" }>["body"],
  blobs: Map<string, Uint8Array>,
  cidMap: ReadonlyMap<string, string>
): Promise<Extract<OspRecord, { type: "memory" }>["body"]> {
  if (body.kind === "rejected") {
    if (body.candidate_cid === undefined) {
      return body;
    }
    return {
      ...body,
      candidate_cid: remapCid(body.candidate_cid, cidMap)
    };
  }

  if (body.kind === "candidate") {
    if ("text_cid" in body) {
      return body;
    }
    const bytes = encodeShardTextBlob(body.text);
    const addr = await contentAddressSideBlob(bytes);
    blobs.set(addr.cid, bytes);
    return {
      kind: "candidate",
      text_cid: addr.cid,
      text_hash: addr.hash,
      proposed_at: body.proposed_at
    };
  }

  // shard
  if ("text_cid" in body) {
    const next: Extract<OspRecord, { type: "memory" }>["body"] = { ...body };
    if (body.candidate_cid !== undefined && "candidate_cid" in next) {
      next.candidate_cid = remapCid(body.candidate_cid, cidMap);
    }
    return next;
  }

  const textBytes = encodeShardTextBlob(body.text);
  const textAddr = await contentAddressSideBlob(textBytes);
  blobs.set(textAddr.cid, textBytes);

  const nextBody: {
    kind: "shard";
    text_cid: string;
    text_hash: string;
    distilled_at: string;
    candidate_cid?: string;
    journal_cid?: string;
    journal_hash?: string;
  } = {
    kind: "shard",
    text_cid: textAddr.cid,
    text_hash: textAddr.hash,
    distilled_at: body.distilled_at
  };

  if (body.candidate_cid !== undefined) {
    nextBody.candidate_cid = remapCid(body.candidate_cid, cidMap);
  }

  if (body.journal !== undefined) {
    const journalBytes = encodeJournalBlob(body.journal);
    const journalAddr = await contentAddressSideBlob(journalBytes);
    blobs.set(journalAddr.cid, journalBytes);
    nextBody.journal_cid = journalAddr.cid;
    nextBody.journal_hash = journalAddr.hash;
  }

  return nextBody;
}

/**
 * Migrate a homogeneous osp/0.1 record list to osp/0.2 (whole-chain re-sign).
 *
 * Extracts inline `text`/`journal` into side blobs, rewrites CID cross-references
 * (`prev`, `candidate_cid`, drift `evidence`, genesis `fork_point`), sets
 * `spec: osp/0.2` on every record, and re-signs under the soul key (and Door
 * keys for cosigned records). See `spec/osp/records.md` §Spec migration.
 */
export async function migrateChainToV02(
  options: MigrateChainToV02Options
): Promise<MigrateChainToV02Result> {
  if (options.records.length === 0) {
    throw new StorageError("migrateChainToV02: empty record list");
  }

  for (const record of options.records) {
    if (record.spec !== OSP_SPEC_V01) {
      throw new StorageError(
        `migrateChainToV02: expected homogeneous ${OSP_SPEC_V01}, found ${record.spec} at seq ${String(record.seq)}`
      );
    }
  }

  const blobs = new Map<string, Uint8Array>();
  const cidMap = new Map<string, string>();
  const migrated: OspRecord[] = [];
  let prevCid: string | null = null;

  for (const source of options.records) {
    const oldCid = await computeCid(source);
    let body: OspRecord["body"] = source.body;

    if (source.type === "memory") {
      body = await migrateMemoryBody(source.body, blobs, cidMap);
    } else if (source.type === "drift") {
      body = {
        ...source.body,
        evidence: source.body.evidence.map((cid) => remapCid(cid, cidMap))
      };
    } else if (source.type === "genesis") {
      if (source.body.fork_point !== undefined) {
        body = {
          ...source.body,
          fork_point: remapCid(source.body.fork_point, cidMap)
        };
      }
    } else if (source.type === "tombstone") {
      throw new StorageError("migrateChainToV02: unexpected tombstone on an osp/0.1 chain");
    }

    const fields: Omit<CreateRecordFields, "cosigners"> & { spec: typeof OSP_SPEC_V02 } = {
      spec: OSP_SPEC_V02,
      seq: source.seq,
      prev: prevCid,
      type: source.type,
      body,
      residency: source.residency
    };

    let cosigners: string[] = [];
    if (source.cosigners.length > 0) {
      if (source.residency === null) {
        throw new StorageError(
          `migrateChainToV02: cosigned record at seq ${String(source.seq)} has null residency`
        );
      }
      const parsed = parseResidency(source.residency);
      if (parsed === null) {
        throw new StorageError(
          `migrateChainToV02: invalid residency at seq ${String(source.seq)}: ${source.residency}`
        );
      }
      const doorPrivateKey = options.doorPrivateKeys[parsed.doorId];
      if (doorPrivateKey === undefined) {
        throw new EncodingError(
          `migrateChainToV02: missing door private key for ${parsed.doorId} (seq ${String(source.seq)})`
        );
      }
      // Ghost uses a single Door cosigner per record; re-sign once under that Door.
      cosigners = [signCore(fields, doorPrivateKey)];
    }

    const created = await createRecord({
      ...fields,
      cosigners,
      soulPrivateKey: options.soulPrivateKey
    });

    migrated.push(created.record);
    cidMap.set(oldCid, created.cid);
    prevCid = created.cid;
  }

  return { records: migrated, blobs, cidMap };
}
