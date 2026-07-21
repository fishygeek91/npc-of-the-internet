/**
 * Generates PoP session-key derivation conformance vectors.
 * Run via: pnpm --filter @npc/runtime generate:pop-vectors
 *
 * TEST-ONLY: uses deterministic private keys (fill-byte patterns). Never use in production.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";

import { encodePublicKey, encodeSignature, sign } from "@npc/osp-core";

import { deriveSessionKeyMaterial } from "../src/keyring/derive-session-key.js";

ed.etc.sha512Sync = (...messages: Uint8Array[]) => sha512(ed.etc.concatBytes(...messages));

type VectorCase = {
  description: string;
  soulPrivateKeyFillByte?: number;
  soulPrivateKeyHex?: string;
  soulPrivateKeyBase64Url?: string;
  doorId: string;
  epoch: number;
  expectedSessionPublicKey: string;
  samplePayload: string;
  expectedSignature: string;
};

type VectorFile = {
  description: string;
  algorithm: string;
  cases: VectorCase[];
};

function buildCase(
  description: string,
  soulPrivateKey: Uint8Array,
  doorId: string,
  epoch: number,
  samplePayload: string
): VectorCase {
  const { privateKey, publicKey } = deriveSessionKeyMaterial(soulPrivateKey, doorId, epoch);
  const payloadBytes = new TextEncoder().encode(samplePayload);
  const signature = sign(payloadBytes, privateKey);

  return {
    description,
    soulPrivateKeyFillByte: soulPrivateKey.every((byte) => byte === soulPrivateKey[0])
      ? soulPrivateKey[0]
      : undefined,
    soulPrivateKeyHex: soulPrivateKey.every((byte) => byte === soulPrivateKey[0])
      ? undefined
      : Buffer.from(soulPrivateKey).toString("hex"),
    doorId,
    epoch,
    expectedSessionPublicKey: encodePublicKey(publicKey),
    samplePayload,
    expectedSignature: encodeSignature(signature)
  };
}

function main(): void {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const vectorsDir = join(scriptDir, "../../../spec/pop/vectors");
  mkdirSync(vectorsDir, { recursive: true });

  const soulFill7 = new Uint8Array(32).fill(7);

  const cases: VectorCase[] = [
    buildCase(
      "soul fill-byte 7, discord guild, epoch 1",
      soulFill7,
      "door:discord:guild123",
      1,
      "npc-pop/0.1 heartbeat ping"
    ),
    buildCase(
      "soul fill-byte 7, matrix room, epoch 77",
      soulFill7,
      "door:matrix:room!abc:example.org",
      77,
      "session-bound live output"
    ),
    buildCase(
      "soul fill-byte 7, epoch 0 (decimal zero)",
      soulFill7,
      "door:irc:libera#wanderer",
      0,
      "epoch-zero binding"
    ),
    buildCase(
      "non-fill-byte soul seed (hex), web door, epoch 42",
      new Uint8Array([
        0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef, 0xfe, 0xdc, 0xba, 0x98, 0x76, 0x54, 0x32,
        0x10, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee,
        0xff, 0x00
      ]),
      "door:web:shrine.example",
      42,
      "alternate soul material"
    )
  ];

  const vector: VectorFile = {
    description: "PoP session-key derivation conformance vectors (pop/0.1)",
    algorithm:
      "HKDF-SHA-512 → 32-byte Ed25519 seed; salt npc-pop/0.1/session-key; info UTF-8(door_id)||0x00||ASCII(epoch)",
    cases
  };

  writeFileSync(
    join(vectorsDir, "session-key-derivation.json"),
    `${JSON.stringify(vector, null, 2)}\n`,
    "utf8"
  );
}

main();
