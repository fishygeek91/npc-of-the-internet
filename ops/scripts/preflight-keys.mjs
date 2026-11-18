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

/** Same text for a missing dist and for a dist that predates the parser export. */
const BUILD_HINT =
  "preflight-keys: build @npc/osp-core first (pnpm --filter @npc/osp-core build)\n";

/**
 * Tell the operator to rebuild osp-core, then stop.
 * @returns {never}
 */
function writeBuildHint() {
  process.stderr.write(BUILD_HINT);
  process.exit(2);
}

/**
 * A dist built before `parsePrivateKeyBytes` still loads. That must use the
 * build hint, not `ospCore.parsePrivateKeyBytes is not a function`.
 *
 * @param {object | null | undefined} loaded
 * @returns {boolean}
 */
function ospCoreExportsReady(loaded) {
  if (loaded === null || loaded === undefined || typeof loaded !== "object") {
    return false;
  }
  return (
    typeof loaded.parsePrivateKeyBytes === "function" &&
    typeof loaded.publicKeyFromPrivate === "function" &&
    typeof loaded.encodePublicKey === "function" &&
    typeof loaded.PrivateKeyParseError === "function"
  );
}

/**
 * @type {{
 *   encodePublicKey: (key: Uint8Array) => string,
 *   parsePrivateKeyBytes: (bytes: Uint8Array) => Uint8Array,
 *   publicKeyFromPrivate: (key: Uint8Array) => Uint8Array,
 *   PrivateKeyParseError: new (failure: {
 *     kind: "empty" | "invalid_encoding" | "bad_length",
 *     detail?: string,
 *     decodedLength?: number
 *   }) => Error & {
 *     failure: { kind: string, detail?: string, decodedLength?: number }
 *   }
 * }}
 */
let ospCore;
try {
  ospCore = ospRequire(ospCoreEntry);
} catch {
  writeBuildHint();
}

if (!ospCoreExportsReady(ospCore)) {
  writeBuildHint();
}

const KEY_LEN = 32;

/**
 * Same acceptance rule as `parsePrivateKeyBytes`. Messages stay the historical
 * preflight wording: invalid base64url is the decoder detail alone (no path, no
 * "must be 32 raw bytes" wrapper); empty and bad length name the path.
 *
 * @param {Uint8Array} fileBytes
 * @param {string} path
 * @returns {Uint8Array}
 */
function parsePrivateKeyFile(fileBytes, path) {
  try {
    return ospCore.parsePrivateKeyBytes(fileBytes);
  } catch (error) {
    if (!(error instanceof ospCore.PrivateKeyParseError)) {
      throw error;
    }
    const failure = error.failure;
    if (failure.kind === "empty") {
      throw new Error(`key file at ${path} is empty`);
    }
    if (failure.kind === "bad_length") {
      throw new Error(
        `key file at ${path} must decode to ${String(KEY_LEN)} bytes, got ${String(failure.decodedLength)}`
      );
    }
    if (failure.kind === "invalid_encoding") {
      throw new Error(failure.detail ?? "invalid base64url encoding");
    }
    throw error;
  }
}

const mode = process.argv[2];
const keyPath = process.argv[3];

if ((mode !== "soul" && mode !== "door") || keyPath === undefined || keyPath === "") {
  process.stderr.write("usage: preflight-keys.mjs soul|door <path>\n");
  process.exit(2);
}

try {
  const fileBytes = readFileSync(keyPath);
  const privateKey = parsePrivateKeyFile(fileBytes, keyPath);
  const publicKey = ospCore.publicKeyFromPrivate(privateKey);
  process.stdout.write(`${ospCore.encodePublicKey(publicKey)}\n`);
} catch (error) {
  const detail = error instanceof Error ? error.message : "failed";
  process.stderr.write(`preflight-keys: ${detail}\n`);
  process.exit(1);
}
