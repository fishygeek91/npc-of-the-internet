import { Buffer } from "node:buffer";

import { resolveTokenFromEnv, type ReplicationConfig, type ReplicationTarget } from "./config.js";

/** Injectable fetch for CAR upload (tests inject a mock; production uses global fetch). */
export type FetchImpl = typeof fetch;

/** Outbound CAR upload adapter for one replication target. */
export type CarUploadAdapter = {
  name: string;
  uploadCar(carBytes: Uint8Array, manifestCid: string): Promise<void>;
};

/**
 * Create a CAR upload adapter for Storacha/Filebase-style HTTPS CAR upload.
 *
 * POST `target.endpoint` with bearer auth, CAR content type, and `X-Manifest-Cid`.
 * The header/protocol shape is a placeholder until a Gate-2 live dry-run against
 * each real service confirms the upload API; do not treat this as endpoint-tested.
 */
export function createCarUploadAdapter(
  target: ReplicationTarget,
  token: string,
  fetchImpl: FetchImpl = fetch
): CarUploadAdapter {
  return {
    name: target.name,
    uploadCar: async (carBytes: Uint8Array, manifestCid: string): Promise<void> => {
      const response = await fetchImpl(target.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/vnd.ipld.car",
          "X-Manifest-Cid": manifestCid
        },
        body: Buffer.from(carBytes)
      });

      if (response.status < 200 || response.status >= 300) {
        throw new Error(`CAR upload failed with status ${String(response.status)}`);
      }
    }
  };
}

/**
 * Build CAR upload adapters from replication config and environment tokens.
 *
 * Token resolution uses {@link resolveTokenFromEnv} (same rules as boot validation).
 */
export function createAdaptersFromConfig(
  config: ReplicationConfig,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: FetchImpl = fetch
): CarUploadAdapter[] {
  const adapters: CarUploadAdapter[] = [];

  for (const target of config.targets) {
    const token = resolveTokenFromEnv(env, target.tokenEnv);
    adapters.push(createCarUploadAdapter(target, token, fetchImpl));
  }

  return adapters;
}
