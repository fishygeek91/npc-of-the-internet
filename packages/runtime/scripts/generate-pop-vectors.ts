/**
 * Generates PoP session-key derivation conformance vectors.
 * Run via: pnpm --filter "./packages/runtime" generate:pop-vectors
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
  soulPrivateKeyFillByte: number;
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

  const fillByte = soulPrivateKey[0];
  if (!soulPrivateKey.every((byte) => byte === fillByte)) {
    throw new Error("vector generator only supports uniform fill-byte soul keys");
  }

  return {
    description,
    soulPrivateKeyFillByte: fillByte,
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

  const soulFill11 = new Uint8Array(32).fill(11);

  const cases: VectorCase[] = [
    buildCase(
      "soul fill-byte 7, discord guild, epoch 1",
      soulFill7,
      "discord:guild123",
      1,
      "npc-pop/0.1 heartbeat ping"
    ),
    buildCase(
      "soul fill-byte 7, matrix room, epoch 10",
      soulFill7,
      "matrix:room-abc",
      10,
      "session-bound live output"
    ),
    buildCase(
      "soul fill-byte 7, irc channel, epoch 77",
      soulFill7,
      "irc:libera-wanderer",
      77,
      "multi-digit epoch binding"
    ),
    buildCase(
      "soul fill-byte 11, web door, epoch 100",
      soulFill11,
      "web:shrine.example",
      100,
      "alternate fill-byte soul material"
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
