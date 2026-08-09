import { computeCidFromCanonicalBytes } from "@npc/osp-core";

/**
 * Fetches opaque IPFS block bytes by CID (trustless raw responses).
 * Injected in tests; production uses {@link createHttpGatewayFetcher}.
 */
export type BlockFetcher = {
  fetchBlock(cid: string): Promise<Uint8Array>;
};

/** Options for {@link createHttpGatewayFetcher}. */
export type HttpGatewayFetcherOptions = {
  gatewayUrl: string;
  /**
   * Injected fetch implementation. Defaults to global `fetch`.
   * Tests pass a stub; CI must never call the real network.
   */
  fetchImpl?: typeof fetch;
};

/**
 * Build a gateway fetcher that requests trustless raw block bytes.
 *
 * URL: `{gateway}/ipfs/{cid}` with `Accept: application/vnd.ipld.raw`.
 * Verifies the response body hashes to the requested CID before returning.
 */
export function createHttpGatewayFetcher(options: HttpGatewayFetcherOptions): BlockFetcher {
  const base = options.gatewayUrl.replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    async fetchBlock(cid: string): Promise<Uint8Array> {
      const url = `${base}/ipfs/${cid}`;
      const response = await fetchImpl(url, {
        headers: {
          Accept: "application/vnd.ipld.raw"
        }
      });

      if (!response.ok) {
        throw new Error(`gateway fetch failed for ${cid}: HTTP ${response.status}`);
      }

      const buffer = new Uint8Array(await response.arrayBuffer());
      const computedCid = await computeCidFromCanonicalBytes(buffer);
      if (computedCid !== cid) {
        throw new Error(`gateway block CID mismatch for ${cid}: computed ${computedCid}`);
      }

      return buffer;
    }
  };
}
