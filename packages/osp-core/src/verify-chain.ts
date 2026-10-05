import type { ChainFailure } from "./chain-types.js";
import { computeCid } from "./crypto/cid.js";
import { decodePublicKey } from "./encoding/base64url.js";
import { ChainMismatchError, CorruptionError, SchemaError, VerificationError } from "./errors.js";
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

/** Mutable PoP presence state walked by {@link evaluatePresence}. */
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

/** No-op state mutation (evaluation produced nothing to commit). */
function noop(): void {
  // intentionally empty
}

/** Failures for one record plus the deferred state mutation that admits it. */
type PresenceEvaluation = {
  failures: ChainFailure[];
  apply: () => void;
};

/**
 * Evaluate PoP continuity and presence-conflict rules for an attestation without mutating
 * `state`. The returned `apply` advances `activeSessions` / `epochDoors` exactly as the chain
 * walk requires once the record is admitted.
 */
function evaluatePresence(
  record: OspRecord,
  cid: string,
  state: PresenceState
): PresenceEvaluation {
  if (record.type !== "attestation") {
    return { failures: [], apply: noop };
  }

  const kind = record.body.kind;
  if (kind !== "arrival" && kind !== "heartbeat" && kind !== "departure") {
    if (kind === "travel") {
      // Travel means no live session; clear open epochs only (epoch history is permanent).
      return {
        failures: [],
        apply: () => {
          state.activeSessions.clear();
        }
      };
    }
    return { failures: [], apply: noop };
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
      return { failures, apply: noop };
    }

    if (openSession !== undefined) {
      failures.push({
        seq: record.seq,
        cid,
        rule: "presence_conflict",
        message: `second arrival for epoch ${epoch} without a prior departure`
      });
      return { failures, apply: noop };
    }

    const sessionPubkey = record.body.session_pubkey;
    return {
      failures,
      apply: () => {
        // New epoch retires prior open session keys (pop/0.1 global monotonic epoch).
        for (const openEpoch of [...state.activeSessions.keys()]) {
          if (openEpoch < epoch) {
            state.activeSessions.delete(openEpoch);
          }
        }
        state.epochDoors.set(epoch, doorId);
        state.activeSessions.set(epoch, { doorId, sessionPubkey });
      }
    };
  }

  // Record first door_id for this epoch from heartbeat/departure if somehow first
  // (normally arrival records it). Still useful for conflict detection.
  const recordDoor = (): void => {
    if (recordedDoor === undefined) {
      state.epochDoors.set(epoch, doorId);
    }
  };

  if (openSession === undefined) {
    failures.push({
      seq: record.seq,
      cid,
      rule: "bad_session_continuity",
      message: `${kind} for epoch ${epoch} has no matching open arrival attestation`
    });
    return { failures, apply: recordDoor };
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
    return { failures, apply: recordDoor };
  }

  // departure — close the open session; keep epochDoors for conflict history
  return {
    failures,
    apply: () => {
      recordDoor();
      state.activeSessions.delete(epoch);
    }
  };
}

/** Side-blob CIDs (`text_cid` / `journal_cid`) referenced by an osp/0.2 memory body. */
function proseBlobRefs(record: OspRecord): readonly string[] {
  if (record.type !== "memory") {
    return [];
  }
  const body = record.body;
  const refs: string[] = [];
  if ("text_cid" in body && typeof body.text_cid === "string") {
    refs.push(body.text_cid);
  }
  if ("journal_cid" in body && typeof body.journal_cid === "string") {
    refs.push(body.journal_cid);
  }
  return refs;
}

/**
 * Result of evaluating one candidate record against the chain prefix held by a
 * {@link ChainVerifier}. Evaluation never mutates verifier state; call {@link commit}
 * to admit the record (advance the prefix).
 */
export type ChainStep = {
  /** Chain-rule failures for this record (empty when the record may extend the prefix). */
  failures: ChainFailure[];
  /** Schema-parsed record, or null on schema_violation. */
  record: OspRecord | null;
  /** CID of the parsed record, or null on schema_violation. */
  cid: string | null;
  /**
   * Original error thrown by {@link verifyRecord} (signature/cosigner/schema), when any.
   * Stores rethrow it so append keeps its historical error types and messages.
   */
  recordError?: unknown;
  /** Admit the record into the verifier state. */
  commit: () => void;
};

/**
 * Incremental soulchain verifier: the single implementation of `spec/osp/records.md`
 * Verification rules 1–16 (structural, cryptographic, chain-level schema, drift evidence,
 * tombstone references, PoP continuity and presence conflicts).
 *
 * {@link verifyRecords} walks a whole chain with it; `SoulStore.append` evaluates the
 * candidate record against the loaded prefix **before** any durable write, so a store can
 * never persist a record that would make its own chain fail verification on the next open.
 */
export class ChainVerifier {
  private readonly options: VerifyChainOptions | undefined;
  private index = 0;
  private previousSeq: number | null = null;
  private previousCid: string | null = null;
  private soulPublicKey: Uint8Array | null = null;
  /** Homogeneous chain `spec` from the first successfully parsed record. */
  private chainSpec: OspRecord["spec"] | null = null;
  private readonly seenSeq = new Set<number>();
  private readonly shardCids = new Set<string>();
  /** Every record CID on the prefix → prose blob CIDs it references (rule 12). */
  private readonly recordBlobRefs = new Map<string, readonly string[]>();
  /** Blob CIDs already tombstoned on the prefix (rule 12 re-tombstone allowance). */
  private readonly tombstonedBlobs = new Set<string>();
  private readonly presenceState: PresenceState = {
    activeSessions: new Map<number, ActiveSession>(),
    epochDoors: new Map<number, string>()
  };
  private lastHead: HeadInfo | null = null;

  constructor(options?: VerifyChainOptions) {
    this.options = options;
  }

  /** Head of the admitted prefix, or null when nothing has been admitted. */
  get head(): HeadInfo | null {
    return this.lastHead === null ? null : { cid: this.lastHead.cid, seq: this.lastHead.seq };
  }

  /** Blob CIDs tombstoned on the admitted prefix. */
  tombstonedBlobCids(): ReadonlySet<string> {
    return new Set(this.tombstonedBlobs);
  }

  /**
   * Evaluate the next record (raw JSON or a parsed record) against the admitted prefix.
   * Pure with respect to verifier state until the returned step is committed.
   *
   * @throws non-chain errors from {@link verifyRecord} (e.g. EncodingError), as before
   */
  async evaluate(raw: unknown): Promise<ChainStep> {
    const index = this.index;
    const parsed = RecordSchema.safeParse(raw);
    if (!parsed.success) {
      const seq =
        typeof raw === "object" && raw !== null && "seq" in raw && typeof raw.seq === "number"
          ? raw.seq
          : index;
      return {
        failures: [{ seq, rule: "schema_violation", message: parsed.error.message }],
        record: null,
        cid: null,
        commit: () => {
          this.index = index + 1;
        }
      };
    }

    const failures: ChainFailure[] = [];
    const record = parsed.data;
    if (this.chainSpec !== null && record.spec !== this.chainSpec) {
      failures.push({
        seq: record.seq,
        rule: "schema_violation",
        message: `mixed osp spec versions on one chain (expected ${this.chainSpec}, found ${record.spec})`
      });
    }
    const cid = await computeCid(record);

    const duplicateSeq = this.seenSeq.has(record.seq);
    if (duplicateSeq) {
      failures.push({
        seq: record.seq,
        cid,
        rule: "forked_head",
        message: `duplicate seq ${record.seq}`
      });
    }

    const isFirstRecord = index === 0;
    failures.push(...collectGenesisFailures(record, isFirstRecord));

    let soulPublicKey = this.soulPublicKey;
    if (isFirstRecord && record.type === "genesis" && record.seq === 0) {
      try {
        soulPublicKey = decodePublicKey(record.body.soul_pubkey);
      } catch {
        // bad_genesis already recorded in collectGenesisFailures
        soulPublicKey = null;
      }
    }

    if (this.previousSeq !== null && record.seq !== this.previousSeq + 1) {
      failures.push({
        seq: record.seq,
        cid,
        rule: "seq_gap",
        message: `expected seq ${this.previousSeq + 1}, found ${record.seq}`
      });
    }

    if (
      this.previousSeq !== null &&
      this.previousCid !== null &&
      record.prev !== this.previousCid
    ) {
      failures.push({
        seq: record.seq,
        cid,
        rule: "broken_prev_link",
        message: `prev must equal CID of record at seq ${this.previousSeq}`
      });
    }

    if (record.type === "drift") {
      for (const evidenceCid of record.body.evidence) {
        if (!this.shardCids.has(evidenceCid)) {
          failures.push({
            seq: record.seq,
            cid,
            rule: "bad_drift_evidence",
            message: `evidence CID ${evidenceCid} is not an earlier committed memory shard on this chain`
          });
        }
      }
    }

    if (record.type === "tombstone") {
      const targetRefs = this.recordBlobRefs.get(record.body.target_cid);
      if (targetRefs === undefined) {
        failures.push({
          seq: record.seq,
          cid,
          rule: "bad_tombstone",
          message: `target_cid ${record.body.target_cid} is not an earlier record on this chain`
        });
      } else if (
        !targetRefs.includes(record.body.blob_cid) &&
        !this.tombstonedBlobs.has(record.body.blob_cid)
      ) {
        failures.push({
          seq: record.seq,
          cid,
          rule: "bad_tombstone",
          message: `blob_cid ${record.body.blob_cid} is not a text_cid/journal_cid of target ${record.body.target_cid} nor a previously tombstoned blob`
        });
      }
    }

    const presence = evaluatePresence(record, cid, this.presenceState);
    failures.push(...presence.failures);

    let recordError: unknown;
    // Belt-and-suspenders: RecordSchema already rejects empty cosigners for these kinds
    // (schema_violation), so this branch is unreachable for schema-valid records.
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
      if (this.options?.doorPublicKeys !== undefined) {
        verifyOptions.doorPublicKeys = this.options.doorPublicKeys;
      }

      try {
        await verifyRecord(record, verifyOptions);
      } catch (error) {
        recordError = error;
        const mapped = mapVerifyRecordError(record, error);
        failures.push({ ...mapped, cid });
      }
    }

    const step: ChainStep = {
      failures,
      record,
      cid,
      commit: () => {
        this.index = index + 1;
        if (this.chainSpec === null) {
          this.chainSpec = record.spec;
        }
        if (!duplicateSeq) {
          this.seenSeq.add(record.seq);
        }
        if (isFirstRecord) {
          this.soulPublicKey = soulPublicKey;
        }
        if (record.type === "memory" && record.body.kind === "shard") {
          this.shardCids.add(cid);
        }
        this.recordBlobRefs.set(cid, proseBlobRefs(record));
        if (record.type === "tombstone") {
          this.tombstonedBlobs.add(record.body.blob_cid);
        }
        presence.apply();
        this.previousSeq = record.seq;
        this.previousCid = cid;
        this.lastHead = { cid, seq: record.seq };
      }
    };
    if (recordError !== undefined) {
      step.recordError = recordError;
    }
    return step;
  }
}

/**
 * Walk an ordered chain through a fresh {@link ChainVerifier}, admitting every record
 * (including failing ones, so later failures are still reported). Returns the result and the
 * verifier holding the walked prefix — stores keep it for incremental append verification.
 */
export async function verifyRecordsWithState(
  records: AsyncIterable<unknown> | readonly unknown[],
  options?: VerifyChainOptions
): Promise<{ result: VerifyChainResult; verifier: ChainVerifier }> {
  const ordered = await materializeRecords(records);
  const verifier = new ChainVerifier(options);

  if (ordered.length === 0) {
    return { result: { valid: true, head: null }, verifier };
  }

  const failures: ChainFailure[] = [];
  for (const raw of ordered) {
    const step = await verifier.evaluate(raw);
    failures.push(...step.failures);
    step.commit();
  }

  if (failures.length > 0) {
    return { result: { valid: false, failures }, verifier };
  }

  return { result: { valid: true, head: verifier.head }, verifier };
}

/**
 * Convert chain-rule failures for an append candidate into the typed error `append` throws.
 * Structural rules map to {@link ChainMismatchError}; all other rules to {@link VerificationError}.
 */
export function appendRejectionError(failures: readonly ChainFailure[]): Error {
  const first = failures[0];
  if (first === undefined) {
    return new VerificationError("append rejected by chain verification");
  }
  const message = `append rejected: ${first.rule} at seq ${first.seq}: ${first.message}`;
  switch (first.rule) {
    case "seq_gap":
    case "broken_prev_link":
    case "forked_head":
    case "bad_genesis":
      return new ChainMismatchError(message);
    default:
      return new VerificationError(message);
  }
}

/** CorruptionError describing the first chain-verification failure found when a store opens. */
export function chainVerificationCorruption(failures: readonly ChainFailure[]): CorruptionError {
  const firstFailure = failures[0];
  if (firstFailure !== undefined) {
    const cidPart = firstFailure.cid === undefined ? "" : ` (cid ${firstFailure.cid})`;
    return new CorruptionError(
      `chain verification failed: ${firstFailure.rule} at seq ${firstFailure.seq}${cidPart}: ${firstFailure.message}`,
      { failures }
    );
  }
  return new CorruptionError("chain verification failed", { failures });
}

/**
 * Verify an ordered soulchain from an array or async iterable.
 *
 * Structural, cryptographic, and schema rules follow `spec/osp/records.md` Verification.
 * Accepts unknown JSON-shaped records (e.g. from disk) and validates each with {@link RecordSchema}.
 *
 * On `schema_violation`, the walker skips the record without advancing `previousSeq`/`previousCid`,
 * so later records may also report derived `seq_gap` / `broken_prev_link` noise after the first
 * real failure. Callers that only need a labeled outcome should check rule presence, not assume
 * `failures` is a minimal set.
 */
export async function verifyRecords(
  records: AsyncIterable<unknown> | readonly unknown[],
  options?: VerifyChainOptions
): Promise<VerifyChainResult> {
  const { result } = await verifyRecordsWithState(records, options);
  return result;
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
