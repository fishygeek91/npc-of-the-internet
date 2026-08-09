import {
  computeCidFromCanonicalBytes,
  EncodingError,
  parseDoorPublicKeyMap,
  RecordSchema,
  verifyRecords,
  type ChainFailure,
  type OspRecord
} from "@npc/osp-core";

import { createHttpGatewayFetcher, type BlockFetcher } from "../gateway-fetch.js";
import { writeStderr } from "../io.js";
import { EXIT_USAGE, EXIT_VERIFY_FAILED, printFailures } from "./verify.js";

/** Default public gateway used when `--gateway` is omitted. */
export const DEFAULT_IPFS_GATEWAY = "https://ipfs.io";

/** Options for {@link runVerifyFromIpfs}. */
export type VerifyFromIpfsOptions = {
  headCid: string;
  gatewayUrl?: string;
  doorKeys?: readonly string[];
  /**
   * Injected block fetcher for tests. When omitted, uses HTTP gateway fetch.
   * CI must always inject a fake fetcher — never hit the real network.
   */
  fetcher?: BlockFetcher;
};

/**
 * Fetch a chain from a trustless gateway by walking `prev` from the head CID,
 * then run {@link verifyRecords}. The pin manifest is not used or trusted.
 */
export async function runVerifyFromIpfs(options: VerifyFromIpfsOptions): Promise<number> {
  let doorPublicKeys: Readonly<Record<string, Uint8Array>> | undefined;
  if (options.doorKeys !== undefined && options.doorKeys.length > 0) {
    try {
      doorPublicKeys = parseDoorPublicKeyMap(options.doorKeys);
    } catch (error) {
      if (error instanceof EncodingError) {
        writeStderr(error.message);
        return EXIT_USAGE;
      }
      throw error;
    }
  }

  const fetcher =
    options.fetcher ??
    createHttpGatewayFetcher({
      gatewayUrl: options.gatewayUrl ?? DEFAULT_IPFS_GATEWAY
    });

  let records: OspRecord[];
  try {
    records = await fetchChainByPrevWalk(options.headCid, fetcher);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeStderr(message);
    return EXIT_USAGE;
  }

  const verifyOptions = doorPublicKeys === undefined ? undefined : { doorPublicKeys };
  const result = await verifyRecords(records, verifyOptions);

  if (result.valid) {
    if (result.head === null || result.head.cid !== options.headCid) {
      const failures: ChainFailure[] = [
        {
          seq: result.head?.seq ?? -1,
          rule: "broken_prev_link",
          message: `fetched head CID ${options.headCid} does not match verified head ${result.head?.cid ?? "null"}`,
          cid: options.headCid
        }
      ];
      printFailures(failures);
      return EXIT_VERIFY_FAILED;
    }
    return 0;
  }

  printFailures(result.failures);
  return EXIT_VERIFY_FAILED;
}

/**
 * Fetch head→genesis by walking `prev` strings; return genesis→head order.
 */
async function fetchChainByPrevWalk(headCid: string, fetcher: BlockFetcher): Promise<OspRecord[]> {
  const reversed: OspRecord[] = [];
  let currentCid: string | null = headCid;
  const seen = new Set<string>();

  while (currentCid !== null) {
    if (seen.has(currentCid)) {
      throw new Error(`cycle detected while walking prev at CID ${currentCid}`);
    }
    seen.add(currentCid);

    const bytes = await fetcher.fetchBlock(currentCid);
    const computedCid = await computeCidFromCanonicalBytes(bytes);
    if (computedCid !== currentCid) {
      throw new Error(`fetched block CID mismatch for ${currentCid}: computed ${computedCid}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(bytes));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`invalid record JSON for ${currentCid}: ${message}`);
    }

    const schema = RecordSchema.safeParse(parsed);
    if (!schema.success) {
      throw new Error(`invalid record schema for ${currentCid}: ${schema.error.message}`);
    }

    reversed.push(schema.data);
    currentCid = schema.data.prev;
  }

  reversed.reverse();
  return reversed;
}
