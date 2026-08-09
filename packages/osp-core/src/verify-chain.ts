import type { ChainFailure } from "./chain-types.js";
import { computeCid } from "./crypto/cid.js";
import { decodePublicKey } from "./encoding/base64url.js";
import { SchemaError, VerificationError } from "./errors.js";
import { verifyRecord } from "./record.js";
import { RecordSchema, type OspRecord } from "./schemas/index.js";
import type { HeadInfo, SoulStore } from "./store/types.js";

export type { ChainFailure, ChainRule } from "./chain-types.js";

/** Result of {@link verifyRecords} or {@link verifyChain}. */
export type VerifyChainResult =
  { valid: true; head: HeadInfo | null } | { valid: false; failures: ChainFailure[] };

/** Options for chain verification. */
export type VerifyChainOptions = {
  /**
   * Door public keys keyed by residency Door id for cosigner verification.
   */
  doorPublicKeys?: Readonly<Record<string, Uint8Array>>;
};

/** Open residency session tracked from an arrival attestation. */
type ActiveSession = {
  doorId: string;
  sessionPubkey: string;
};

/** Mutable PoP presence state walked by {@link collectPresenceFailures}. */
type PresenceState = {
  /** Open sessions only — departure / travel / newer arrival may close these. */
  activeSessions: Map<number, ActiveSession>;
  /** Permanent first `door_id` seen per epoch (never deleted). */
  epochDoors: Map<number, string>;
};

/** Returns true when the record type requires a non-empty Door cosignature. */
function requiresCosigner(record: OspRecord): boolean {
  if (record.type === "memory" && record.body.kind === "shard") {
    return true;
  }
  if (record.type === "attestation") {
    const kind = record.body.kind;
    return kind === "arrival" || kind === "departure" || kind === "heartbeat";
  }
  return false;
}

/** Validate the first genesis record and detect later genesis records. */
function collectGenesisFailures(record: OspRecord, isFirstRecord: boolean): ChainFailure[] {
  const failures: ChainFailure[] = [];

  if (!isFirstRecord && record.type === "genesis") {
    failures.push({
      seq: record.seq,
      rule: "bad_genesis",
      message: "only one genesis record is permitted at seq 0"
    });
    return failures;
  }

  if (!isFirstRecord) {
    return failures;
  }

  if (
    record.type !== "genesis" ||
    record.seq !== 0 ||
    record.prev !== null ||
    record.residency !== null
  ) {
    failures.push({
      seq: record.seq,
      rule: "bad_genesis",
      message: "first record must be genesis with seq 0, prev null, and residency null"
    });
    return failures;
  }

  try {
    decodePublicKey(record.body.soul_pubkey);
  } catch {
    failures.push({
      seq: record.seq,
      rule: "bad_genesis",
      message: "genesis soul_pubkey is not a valid Ed25519 public key"
    });
  }

  return failures;
}

/** Map {@link verifyRecord} errors to chain-level failure rules. */
function mapVerifyRecordError(record: OspRecord, error: unknown): ChainFailure {
  if (error instanceof VerificationError) {
    if (error.message === "soul signature verification failed") {
      return {
        seq: record.seq,
        rule: "bad_soul_sig",
        message: error.message
      };
    }

    if (
      error.message === "doorPublicKeys required when cosigners are present" ||
      error.message === "cosigners require a non-null residency to resolve Door public key" ||
      error.message === "residency must match door:<platform>:<door-id>/epoch:<n>" ||
      error.message.startsWith("no doorPublicKeys entry for residency Door") ||
      error.message.startsWith("cosigner signature at index")
    ) {
      return {
        seq: record.seq,
        rule: "missing_cosigner",
        message: error.message
      };
    }
  }

  if (error instanceof SchemaError) {
    return {
      seq: record.seq,
      rule: "schema_violation",
      message: error.message
    };
  }

  // Do not guess a ChainRule for unexpected errors (e.g. EncodingError, CID mismatch).
  if (error instanceof Error) {
    throw error;
  }
  throw new Error(String(error));
}

/** True when the value is an async iterable (including async generators). */
function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const iterator = Reflect.get(value, Symbol.asyncIterator);
  return typeof iterator === "function";
}

/** Materialize an array or async iterable of records into an ordered list. */
async function materializeRecords(
  records: AsyncIterable<unknown> | readonly unknown[]
): Promise<unknown[]> {
  if (isAsyncIterable(records)) {
    const list: unknown[] = [];
    for await (const record of records) {
      list.push(record);
    }
    return list;
  }

  return [...records];
}

/**
 * Collect PoP continuity and presence-conflict failures for an attestation.
 * Mutates `state.activeSessions` and `state.epochDoors` as the chain advances.
 */
function collectPresenceFailures(
  record: OspRecord,
  cid: string,
  state: PresenceState
): ChainFailure[] {
  if (record.type !== "attestation") {
    return [];
  }

  const kind = record.body.kind;
  if (kind !== "arrival" && kind !== "heartbeat" && kind !== "departure") {
    if (kind === "travel") {
      // Travel means no live session; clear open epochs only (epoch history is permanent).
      state.activeSessions.clear();
    }
    return [];
  }

  const failures: ChainFailure[] = [];
  const epoch = record.body.epoch;
  const doorId = record.body.door_id;
  const recordedDoor = state.epochDoors.get(epoch);
  const openSession = state.activeSessions.get(epoch);

  if (recordedDoor !== undefined && recordedDoor !== doorId) {
    failures.push({
      seq: record.seq,
      cid,
      rule: "presence_conflict",
      message: `presence conflict for epoch ${epoch}: Door "${doorId}" conflicts with Door "${recordedDoor}"`
    });
  }

  if (kind === "arrival") {
    if (recordedDoor !== undefined) {
      // Epoch already claimed (including after departure) — reuse is a conflict.
      failures.push({
        seq: record.seq,
        cid,
        rule: "presence_conflict",
        message: `second arrival for epoch ${epoch} (epoch already claimed by Door "${recordedDoor}")`
      });
      return failures;
    }

    if (openSession !== undefined) {
      failures.push({
        seq: record.seq,
        cid,
        rule: "presence_conflict",
        message: `second arrival for epoch ${epoch} without a prior departure`
      });
      return failures;
    }

    // New epoch retires prior open session keys (pop/0.1 global monotonic epoch).
    for (const openEpoch of [...state.activeSessions.keys()]) {
      if (openEpoch < epoch) {
        state.activeSessions.delete(openEpoch);
      }
    }

    state.epochDoors.set(epoch, doorId);
    state.activeSessions.set(epoch, {
      doorId,
      sessionPubkey: record.body.session_pubkey
    });
    return failures;
  }

  // Record first door_id for this epoch from heartbeat/departure if somehow first
  // (normally arrival records it). Still useful for conflict detection.
  if (recordedDoor === undefined) {
    state.epochDoors.set(epoch, doorId);
  }

  if (openSession === undefined) {
    failures.push({
      seq: record.seq,
      cid,
      rule: "bad_session_continuity",
      message: `${kind} for epoch ${epoch} has no matching open arrival attestation`
    });
    return failures;
  }

  if (kind === "heartbeat") {
    if (record.body.session_pubkey !== openSession.sessionPubkey) {
      failures.push({
        seq: record.seq,
        cid,
        rule: "bad_session_continuity",
        message: `heartbeat session_pubkey must match the arrival attestation for epoch ${epoch}`
      });
    }
    return failures;
  }

  // departure — close the open session; keep epochDoors for conflict history
  state.activeSessions.delete(epoch);
  return failures;
}

/**
 * Verify an ordered soulchain from an array or async iterable.
 *
 * Structural, cryptographic, and schema rules follow `spec/osp/records.md` Verification.
 * Accepts unknown JSON-shaped records (e.g. from disk) and validates each with {@link RecordSchema}.
 *
 * On `schema_violation`, the walker `continue`s without advancing `previousSeq`/`previousCid`,
 * so later records may also report derived `seq_gap` / `broken_prev_link` noise after the first
 * real failure. Callers that only need a labeled outcome should check rule presence, not assume
 * `failures` is a minimal set.
 */
export async function verifyRecords(
  records: AsyncIterable<unknown> | readonly unknown[],
  options?: VerifyChainOptions
): Promise<VerifyChainResult> {
  const ordered = await materializeRecords(records);

  if (ordered.length === 0) {
    return { valid: true, head: null };
  }

  const failures: ChainFailure[] = [];
  const seenSeq = new Set<number>();

  let previousSeq: number | null = null;
  let previousCid: string | null = null;
  let soulPublicKey: Uint8Array | null = null;
  const shardCids = new Set<string>();
  const presenceState: PresenceState = {
    activeSessions: new Map<number, ActiveSession>(),
    epochDoors: new Map<number, string>()
  };
  let lastHead: HeadInfo | null = null;

  for (let index = 0; index < ordered.length; index += 1) {
    const raw = ordered[index];

    const parsed = RecordSchema.safeParse(raw);
    if (!parsed.success) {
      const seq =
        typeof raw === "object" && raw !== null && "seq" in raw && typeof raw.seq === "number"
          ? raw.seq
          : index;
      failures.push({
        seq,
        rule: "schema_violation",
        message: parsed.error.message
      });
      continue;
    }

    const record = parsed.data;
    const cid = await computeCid(record);

    if (seenSeq.has(record.seq)) {
      failures.push({
        seq: record.seq,
        cid,
        rule: "forked_head",
        message: `duplicate seq ${record.seq}`
      });
    } else {
      seenSeq.add(record.seq);
    }

    failures.push(...collectGenesisFailures(record, index === 0));

    if (index === 0 && record.type === "genesis" && record.seq === 0) {
      try {
        soulPublicKey = decodePublicKey(record.body.soul_pubkey);
      } catch {
        // bad_genesis already recorded in collectGenesisFailures
        soulPublicKey = null;
      }
    }

    if (previousSeq !== null && record.seq !== previousSeq + 1) {
      failures.push({
        seq: record.seq,
        cid,
        rule: "seq_gap",
        message: `expected seq ${previousSeq + 1}, found ${record.seq}`
      });
    }

    if (previousSeq !== null && previousCid !== null && record.prev !== previousCid) {
      failures.push({
        seq: record.seq,
        cid,
        rule: "broken_prev_link",
        message: `prev must equal CID of record at seq ${previousSeq}`
      });
    }

    if (record.type === "memory" && record.body.kind === "shard") {
      shardCids.add(cid);
    }

    if (record.type === "drift") {
      for (const evidenceCid of record.body.evidence) {
        if (!shardCids.has(evidenceCid)) {
          failures.push({
            seq: record.seq,
            cid,
            rule: "bad_drift_evidence",
            message: `evidence CID ${evidenceCid} is not an earlier committed memory shard on this chain`
          });
        }
      }
    }

    failures.push(...collectPresenceFailures(record, cid, presenceState));

    // Belt-and-suspenders: RecordSchema already rejects empty cosigners for these kinds
    // (schema_violation + continue), so this branch is unreachable for schema-valid records.
    if (requiresCosigner(record) && record.cosigners.length === 0) {
      failures.push({
        seq: record.seq,
        cid,
        rule: "missing_cosigner",
        message: "record requires at least one Door cosignature"
      });
    } else if (soulPublicKey !== null) {
      const verifyOptions: {
        soulPublicKey: Uint8Array;
        doorPublicKeys?: Readonly<Record<string, Uint8Array>>;
        expectedCid: string;
      } = {
        soulPublicKey,
        expectedCid: cid
      };
      if (options?.doorPublicKeys !== undefined) {
        verifyOptions.doorPublicKeys = options.doorPublicKeys;
      }

      try {
        await verifyRecord(record, verifyOptions);
      } catch (error) {
        const mapped = mapVerifyRecordError(record, error);
        failures.push({ ...mapped, cid });
      }
    }

    previousSeq = record.seq;
    previousCid = cid;
    lastHead = { cid, seq: record.seq };
  }

  if (failures.length > 0) {
    return { valid: false, failures };
  }

  return { valid: true, head: lastHead };
}

/**
 * Verify a soulchain loaded from a {@link SoulStore}.
 *
 * Uses {@link SoulStore.iterate} for record order, then cross-checks {@link SoulStore.head}.
 * A store-head vs verified-head mismatch is reported as `forked_head` (distinct from
 * duplicate-seq forks detected inside {@link verifyRecords}).
 */
export async function verifyChain(
  store: SoulStore,
  options?: VerifyChainOptions
): Promise<VerifyChainResult> {
  const records: OspRecord[] = [];
  for await (const record of store.iterate()) {
    records.push(record);
  }

  const result = await verifyRecords(records, options);

  if (!result.valid) {
    return result;
  }

  const storeHead = await store.head();

  if (result.head === null && storeHead === null) {
    return result;
  }

  if (result.head === null && storeHead !== null) {
    return {
      valid: false,
      failures: [
        {
          seq: storeHead.seq,
          cid: storeHead.cid,
          rule: "forked_head",
          message: "store head is set but verified chain is empty"
        }
      ]
    };
  }

  if (result.head !== null && storeHead === null) {
    return {
      valid: false,
      failures: [
        {
          seq: result.head.seq,
          cid: result.head.cid,
          rule: "forked_head",
          message: "verified chain head is set but store head is null"
        }
      ]
    };
  }

  // Both heads are non-null after the XOR checks above.
  if (result.head === null || storeHead === null) {
    return result;
  }

  if (storeHead.cid !== result.head.cid || storeHead.seq !== result.head.seq) {
    return {
      valid: false,
      failures: [
        {
          seq: storeHead.seq,
          cid: storeHead.cid,
          rule: "forked_head",
          message: "store head does not match verified chain head"
        }
      ]
    };
  }

  return result;
}
