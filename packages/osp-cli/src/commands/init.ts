import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";

import {
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

/**
 * Initialize a new soulchain directory with a fresh key and genesis record.
 */
export async function runInit(options: InitOptions): Promise<InitResult> {
  const targetDir = path.resolve(options.dir);
  const charterPath = resolveCharterPath(options.charterPath);
  const charter = readCharterContents(charterPath);

  mkdirSync(targetDir, { recursive: true });

  const keypair = generateKeypair();
  const soulKeyPath = path.join(targetDir, "soul.key");
  writeFileSync(soulKeyPath, encodeBase64Url(keypair.privateKey), { mode: 0o600 });

  const publicKey = encodePublicKey(keypair.publicKey);
  const { record, cid } = await createRecord({
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
