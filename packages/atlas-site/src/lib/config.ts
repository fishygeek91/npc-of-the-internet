import { access } from "node:fs/promises";
import * as path from "node:path";

import { decodePublicKey, EncodingError, parseDoorPublicKeyMap } from "@npc/osp-core";
import { z } from "zod";

const fixtureMetaSchema = z.object({
  doorPublicKeys: z.record(z.string().min(1)).optional(),
  doorPublicKey: z.string().min(1).optional()
});

const atlasSiteConfigSchema = z.object({
  chainDir: z.string().min(1),
  basePath: z.string().min(1),
  doorPublicKeys: z.record(z.string(), z.instanceof(Uint8Array)).optional()
});

/** Validated Atlas static site configuration. */
export type AtlasSiteConfig = z.infer<typeof atlasSiteConfigSchema>;

/**
 * Parse comma-separated `doorId=base64url` bindings from an env value.
 * @throws {Error} when any segment is invalid.
 */
function parseDoorPublicKeys(
  value: string | undefined
): Readonly<Record<string, Uint8Array>> | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }

  try {
    const map = parseDoorPublicKeyMap(value);
    return Object.keys(map).length > 0 ? map : undefined;
  } catch (error) {
    if (error instanceof EncodingError) {
      throw new Error(`ATLAS_SITE_DOOR_PUBKEYS: ${error.message}`);
    }
    throw error;
  }
}

/**
 * Load door public keys from `fixture-meta.json` when present in the chain directory.
 */
async function loadDoorKeysFromFixtureMeta(
  chainDir: string
): Promise<Readonly<Record<string, Uint8Array>> | undefined> {
  const metaPath = path.join(chainDir, "fixture-meta.json");
  try {
    await access(metaPath);
  } catch {
    return undefined;
  }

  const { readFile } = await import("node:fs/promises");
  const raw = await readFile(metaPath, "utf8");
  const parsed = fixtureMetaSchema.safeParse(JSON.parse(raw) as unknown);
  if (!parsed.success) {
    return undefined;
  }

  const recordKeys = parsed.data.doorPublicKeys;
  if (recordKeys !== undefined && Object.keys(recordKeys).length > 0) {
    const map: Record<string, Uint8Array> = {};
    for (const [doorId, keyB64] of Object.entries(recordKeys)) {
      map[doorId] = decodePublicKey(keyB64);
    }
    return map;
  }

  if (parsed.data.doorPublicKey !== undefined) {
    return undefined;
  }

  return undefined;
}

/**
 * Load and validate Atlas site configuration from environment variables.
 *
 * Env vars: `ATLAS_SITE_CHAIN_DIR` (required), `ATLAS_SITE_DOOR_PUBKEYS` (optional),
 * `ATLAS_SITE_BASE` (optional, default `/`).
 *
 * @param env - Environment map; defaults to `process.env`. Inject a plain object in tests.
 * @throws {Error} when required env is missing, chain dir is invalid, or keys fail to parse.
 */
export async function loadAtlasSiteConfig(
  env: NodeJS.ProcessEnv = process.env
): Promise<AtlasSiteConfig> {
  const chainDirRaw = env.ATLAS_SITE_CHAIN_DIR;
  if (chainDirRaw === undefined || chainDirRaw === "") {
    throw new Error("ATLAS_SITE_CHAIN_DIR is required but not set");
  }

  const chainDir = path.resolve(chainDirRaw);
  const chainPath = path.join(chainDir, "chain.jsonl");

  try {
    await access(chainPath);
  } catch {
    throw new Error(`ATLAS_SITE_CHAIN_DIR does not contain chain.jsonl: ${chainDir}`);
  }

  const basePath =
    env.ATLAS_SITE_BASE === undefined || env.ATLAS_SITE_BASE === "" ? "/" : env.ATLAS_SITE_BASE;

  let doorPublicKeys = parseDoorPublicKeys(env.ATLAS_SITE_DOOR_PUBKEYS);
  if (doorPublicKeys === undefined) {
    doorPublicKeys = await loadDoorKeysFromFixtureMeta(chainDir);
  }

  const result = atlasSiteConfigSchema.safeParse({
    chainDir,
    basePath,
    doorPublicKeys
  });

  if (!result.success) {
    const detail = result.error.issues.map((issue) => issue.message).join("; ");
    throw new Error(`Invalid Atlas site configuration: ${detail}`);
  }

  return result.data;
}
