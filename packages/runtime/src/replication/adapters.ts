import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";

import type { ReplicationConfig, ReplicationTarget } from "./config.js";

/** Injectable fetch for CAR upload (tests inject a mock; production uses global fetch). */
export type FetchImpl = typeof fetch;

/** Outbound CAR upload adapter for one replication target. */
export type CarUploadAdapter = {
  name: string;
  uploadCar(carBytes: Uint8Array, manifestCid: string): Promise<void>;
};

/**
 * Read a bearer token from `env[tokenEnv]` or `env[tokenEnv + "_FILE"]`.
 * Caller must validate presence before adapter construction.
 */
function resolveTokenForTarget(env: NodeJS.ProcessEnv, tokenEnv: string): string {
  const fileVarName = `${tokenEnv}_FILE`;
  const direct = env[tokenEnv];
  const filePath = env[fileVarName];

  if (filePath !== undefined && filePath !== "") {
    const trimmed = readFileSync(filePath, "utf8").trim();
    if (trimmed === "") {
      throw new Error(`${fileVarName} is empty`);
    }
    return trimmed;
  }

  if (direct !== undefined && direct !== "") {
    return direct;
  }

  throw new Error(`${tokenEnv} is not set`);
}

/**
 * Create a CAR upload adapter for Storacha/Filebase-style HTTPS CAR upload.
 *
 * POST `target.endpoint` with bearer auth, CAR content type, and manifest CID header.
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
 */
export function createAdaptersFromConfig(
  config: ReplicationConfig,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: FetchImpl = fetch
): CarUploadAdapter[] {
  const adapters: CarUploadAdapter[] = [];

  for (const target of config.targets) {
    const token = resolveTokenForTarget(env, target.tokenEnv);
    adapters.push(createCarUploadAdapter(target, token, fetchImpl));
  }

  return adapters;
}
