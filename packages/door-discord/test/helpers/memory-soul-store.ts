import {
  computeCid,
  computeCidFromCanonicalBytes,
  StorageError,
  type AppendResult,
  type HeadInfo,
  type OspRecord,
  type PutSideBlobResult,
  type SoulStore
} from "@npc/osp-core";

/** In-memory append-only SoulStore for door-discord integration tests. */
export class MemorySoulStore implements SoulStore {
  private readonly records: OspRecord[] = [];
  private readonly byCid = new Map<string, OspRecord>();
  private readonly sideBlobs = new Map<string, Uint8Array>();
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

  async putSideBlob(bytes: Uint8Array): Promise<PutSideBlobResult> {
    const cid = await computeCidFromCanonicalBytes(bytes);
    const existing = this.sideBlobs.get(cid);
    if (existing !== undefined) {
      if (existing.length !== bytes.length || !existing.every((b, i) => b === bytes[i])) {
        throw new StorageError(`side blob already exists for CID ${cid} with different bytes`);
      }
      return { cid };
    }
    this.sideBlobs.set(cid, bytes);
    return { cid };
  }

  async getSideBlob(cid: string): Promise<Uint8Array> {
    const bytes = this.sideBlobs.get(cid);
    if (bytes === undefined) {
      throw new StorageError(`side blob not found for CID ${cid}`);
    }
    return bytes;
  }

  async deleteSideBlob(cid: string): Promise<void> {
    this.sideBlobs.delete(cid);
  }
}
