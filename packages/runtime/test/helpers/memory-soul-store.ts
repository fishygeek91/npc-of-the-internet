import {
  computeCid,
  StorageError,
  type AppendResult,
  type HeadInfo,
  type OspRecord,
  type SoulStore
} from "@npc/osp-core";

/**
 * In-memory append-only {@link SoulStore} for tests.
 *
 * Records are kept in append order; {@link head} reflects the last append.
 * No chain validation on append (seq/prev continuity, signatures) — callers own
 * continuity. Negative tests may append broken records and discover failures via
 * {@link composeSelf} / verifyChain.
 */
export class MemorySoulStore implements SoulStore {
  private readonly records: OspRecord[] = [];
  private readonly byCid = new Map<string, OspRecord>();
  private headInfo: HeadInfo | null = null;

  /** Append a signed record and update the chain head (no validation). */
  async append(record: OspRecord): Promise<AppendResult> {
    const cid = await computeCid(record);
    this.records.push(record);
    this.byCid.set(cid, record);
    this.headInfo = { cid, seq: record.seq };
    return { cid };
  }

  /** Return the last appended head, or null when empty. */
  async head(): Promise<HeadInfo | null> {
    return this.headInfo;
  }

  /** Fetch a record by CID; throws {@link StorageError} when missing. */
  async get(cid: string): Promise<OspRecord> {
    const record = this.byCid.get(cid);
    if (record === undefined) {
      throw new StorageError(`record not found for CID ${cid}`);
    }
    return record;
  }

  /** Yield records in append (chain) order from genesis to head. */
  async *iterate(): AsyncIterable<OspRecord> {
    for (const record of this.records) {
      yield record;
    }
  }
}
