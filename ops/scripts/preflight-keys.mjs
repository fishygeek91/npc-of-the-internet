#!/usr/bin/env node
/**
 * Derive base64url Ed25519 public keys from soul.key / door.key files for preflight.
 * Usage:
 *   node ops/scripts/preflight-keys.mjs soul <path>
 *   node ops/scripts/preflight-keys.mjs door <path>
 * Prints the public key on stdout. Never prints private key material.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "../..");
const ospCoreEntry = join(repoRoot, "packages/osp-core/dist/index.js");
const ospRequire = createRequire(ospCoreEntry);

/** @type {{ decodeBase64Url: (s: string) => Uint8Array, encodePublicKey: (k: Uint8Array) => string }} */
let ospCore;
try {
  ospCore = ospRequire(ospCoreEntry);
} catch {
  process.stderr.write(
    "preflight-keys: build @npc/osp-core first (pnpm --filter @npc/osp-core build)\n"
  );
  process.exit(2);
}

/** @type {typeof import("@noble/ed25519")} */
const ed = ospRequire("@noble/ed25519");
/** @type {typeof import("@noble/hashes/sha512")} */
const { sha512 } = ospRequire("@noble/hashes/sha512");

ed.etc.sha512Sync = (...messages) => sha512(ed.etc.concatBytes(...messages));

const KEY_LEN = 32;

/**
 * @param {Buffer} fileBytes
 * @param {string} path
 * @returns {Uint8Array}
 */
function parsePrivateKeyBytes(fileBytes, path) {
  if (fileBytes.length === KEY_LEN) {
    return new Uint8Array(fileBytes);
  }
  const trimmed = fileBytes.toString("utf8").trim();
  if (trimmed.length === 0) {
    throw new Error(`key file at ${path} is empty`);
  }
  const decoded = ospCore.decodeBase64Url(trimmed);
  if (decoded.length !== KEY_LEN) {
    throw new Error(
      `key file at ${path} must decode to ${String(KEY_LEN)} bytes, got ${String(decoded.length)}`
    );
  }
  return decoded;
}

const mode = process.argv[2];
const keyPath = process.argv[3];

if ((mode !== "soul" && mode !== "door") || keyPath === undefined || keyPath === "") {
  process.stderr.write("usage: preflight-keys.mjs soul|door <path>\n");
  process.exit(2);
}

try {
  const fileBytes = readFileSync(keyPath);
  const privateKey = parsePrivateKeyBytes(fileBytes, keyPath);
  const publicKey = ed.getPublicKey(privateKey);
  process.stdout.write(`${ospCore.encodePublicKey(publicKey)}\n`);
} catch (error) {
  const detail = error instanceof Error ? error.message : "failed";
  process.stderr.write(`preflight-keys: ${detail}\n`);
  process.exit(1);
}
