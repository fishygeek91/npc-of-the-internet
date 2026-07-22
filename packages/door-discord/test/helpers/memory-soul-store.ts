import {
  computeCid,
  StorageError,
  type AppendResult,
  type HeadInfo,
  type OspRecord,
  type SoulStore
} from "@npc/osp-core";

/** In-memory append-only SoulStore for door-discord integration tests. */
export class MemorySoulStore implements SoulStore {
  private readonly records: OspRecord[] = [];
  private readonly byCid = new Map<string, OspRecord>();
  private headInfo: HeadInfo | null = null;

  async append(record: OspRecord): Promise<AppendResult> {
    const cid = await computeCid(record);
    this.records.push(record);
    this.byCid.set(cid, record);
    this.headInfo = { cid, seq: record.seq };
    return { cid };
  }

  async head(): Promise<HeadInfo | null> {
    return this.headInfo;
  }

  async get(cid: string): Promise<OspRecord> {
    const record = this.byCid.get(cid);
    if (record === undefined) {
      throw new StorageError(`record not found for CID ${cid}`);
    }
    return record;
  }

  async *iterate(): AsyncIterable<OspRecord> {
    for (const record of this.records) {
      yield record;
    }
  }
}
