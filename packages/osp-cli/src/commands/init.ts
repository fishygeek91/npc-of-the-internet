import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";

import {
  OSP_SPEC_V02,
  createRecord,
  encodeBase64Url,
  encodePublicKey,
  FileSoulStore,
  generateKeypair
} from "@npc/osp-core";

import { readCharterContents, resolveCharterPath } from "../charter.js";

/** Options for {@link runInit}. */
export type InitOptions = {
  dir: string;
  charterPath?: string;
};

/** Result printed after a successful init. */
export type InitResult = {
  publicKey: string;
  genesisCid: string;
};

/** True when the caught value is a Node.js errno exception with the given code. */
function isErrnoCode(error: unknown, code: string): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  return error.code === code;
}

/**
 * Initialize a new soulchain directory with a fresh key and genesis record.
 *
 * Refuses when `soul.key` or `chain.jsonl` already exists in the target directory
 * (no `--force`). The key is created with exclusive `wx` so concurrent inits cannot
 * interleave. Guards run before any key material is generated.
 */
export async function runInit(options: InitOptions): Promise<InitResult> {
  const targetDir = path.resolve(options.dir);
  const charterPath = resolveCharterPath(options.charterPath);
  const charter = readCharterContents(charterPath);

  const soulKeyPath = path.join(targetDir, "soul.key");
  const chainPath = path.join(targetDir, "chain.jsonl");

  if (existsSync(soulKeyPath)) {
    throw new Error(`refusing to init: soul.key already exists at ${soulKeyPath}`);
  }
  if (existsSync(chainPath)) {
    throw new Error(`refusing to init: chain.jsonl already exists at ${chainPath}`);
  }

  mkdirSync(targetDir, { recursive: true });

  const keypair = generateKeypair();
  try {
    writeFileSync(soulKeyPath, encodeBase64Url(keypair.privateKey), {
      flag: "wx",
      mode: 0o600
    });
  } catch (error) {
    if (isErrnoCode(error, "EEXIST")) {
      throw new Error(`refusing to init: soul.key already exists at ${soulKeyPath}`);
    }
    throw error;
  }

  const publicKey = encodePublicKey(keypair.publicKey);
  const { record, cid } = await createRecord({
    spec: OSP_SPEC_V02,
    seq: 0,
    prev: null,
    type: "genesis",
    body: {
      charter,
      soul_pubkey: publicKey,
      created_at: new Date().toISOString()
    },
    residency: null,
    cosigners: [],
    soulPrivateKey: keypair.privateKey
  });

  const store = await FileSoulStore.open(targetDir);
  try {
    await store.append(record);
  } finally {
    await store.close();
  }

  return { publicKey, genesisCid: cid };
}
