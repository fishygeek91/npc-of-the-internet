import { access } from "node:fs/promises";
import * as path from "node:path";

import { decodePublicKey } from "@npc/osp-core";
import { z } from "zod";

const fixtureMetaSchema = z.object({
  doorPublicKeys: z.array(z.string().min(1)).optional(),
  doorPublicKey: z.string().min(1).optional()
});

const atlasSiteConfigSchema = z.object({
  chainDir: z.string().min(1),
  basePath: z.string().min(1),
  doorPublicKeys: z.array(z.instanceof(Uint8Array)).optional()
});

/** Validated Atlas static site configuration. */
export type AtlasSiteConfig = z.infer<typeof atlasSiteConfigSchema>;

/**
 * Parse comma-separated base64url door public keys from an env value.
 * @throws {Error} when any segment is not valid base64url Ed25519 key material.
 */
function parseDoorPublicKeys(value: string | undefined): Uint8Array[] | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }

  const keys: Uint8Array[] = [];
  for (const segment of value.split(",")) {
    const trimmed = segment.trim();
    if (trimmed === "") {
      continue;
    }
    try {
      keys.push(decodePublicKey(trimmed));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`ATLAS_SITE_DOOR_PUBKEYS contains invalid base64url public key: ${message}`);
    }
  }

  return keys.length > 0 ? keys : undefined;
}

/**
 * Load door public keys from `fixture-meta.json` when present in the chain directory.
 */
async function loadDoorKeysFromFixtureMeta(chainDir: string): Promise<Uint8Array[] | undefined> {
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

  const b64Keys =
    parsed.data.doorPublicKeys ??
    (parsed.data.doorPublicKey === undefined ? undefined : [parsed.data.doorPublicKey]);
  if (b64Keys === undefined) {
    return undefined;
  }

  const keys: Uint8Array[] = [];
  for (const keyB64 of b64Keys) {
    keys.push(decodePublicKey(keyB64));
  }
  return keys.length > 0 ? keys : undefined;
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
