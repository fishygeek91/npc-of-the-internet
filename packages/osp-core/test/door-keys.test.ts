import { describe, expect, it } from "vitest";

import { encodePublicKey } from "../src/encoding/base64url.js";
import { EncodingError } from "../src/errors.js";
import {
  hasDoorPublicKeys,
  parseDoorPublicKeyBinding,
  parseDoorPublicKeyMap
} from "../src/door-keys.js";

const TEST_DOOR_ID = "discord:guild123";
const TEST_PUBLIC_KEY = encodePublicKey(new Uint8Array(32).fill(7));
const TEST_BINDING = `${TEST_DOOR_ID}=${TEST_PUBLIC_KEY}`;

describe("parseDoorPublicKeyBinding", () => {
  it("parses a valid doorId=base64url binding", () => {
    const binding = parseDoorPublicKeyBinding(TEST_BINDING);
    expect(binding.doorId).toBe(TEST_DOOR_ID);
    expect(binding.publicKey).toEqual(new Uint8Array(32).fill(7));
  });

  it("rejects bindings without a separator", () => {
    expect(() => parseDoorPublicKeyBinding("discord:guild123")).toThrow(EncodingError);
  });

  it("rejects bindings with multiple equals signs", () => {
    expect(() => parseDoorPublicKeyBinding("discord:guild123=abc=def")).toThrow(EncodingError);
  });

  it("rejects bindings with an empty door id", () => {
    expect(() => parseDoorPublicKeyBinding(`=${TEST_PUBLIC_KEY}`)).toThrow(EncodingError);
  });
});

describe("parseDoorPublicKeyMap", () => {
  it("parses comma-separated bindings into a door id map", () => {
    const otherBinding = `discord:other=${encodePublicKey(new Uint8Array(32).fill(8))}`;
    const map = parseDoorPublicKeyMap(`${TEST_BINDING},${otherBinding}`);
    expect(Object.keys(map)).toEqual([TEST_DOOR_ID, "discord:other"]);
    expect(map[TEST_DOOR_ID]).toEqual(new Uint8Array(32).fill(7));
    expect(map["discord:other"]).toEqual(new Uint8Array(32).fill(8));
  });

  it("parses an array of bindings", () => {
    const map = parseDoorPublicKeyMap([TEST_BINDING]);
    expect(map[TEST_DOOR_ID]).toEqual(new Uint8Array(32).fill(7));
  });

  it("lets later duplicate door ids overwrite earlier entries", () => {
    const replacement = encodePublicKey(new Uint8Array(32).fill(9));
    const map = parseDoorPublicKeyMap([TEST_BINDING, `${TEST_DOOR_ID}=${replacement}`]);
    expect(map[TEST_DOOR_ID]).toEqual(new Uint8Array(32).fill(9));
  });
});

describe("hasDoorPublicKeys", () => {
  it("returns false for undefined or empty maps", () => {
    expect(hasDoorPublicKeys(undefined)).toBe(false);
    expect(hasDoorPublicKeys({})).toBe(false);
  });

  it("returns true when at least one door key is present", () => {
    expect(hasDoorPublicKeys({ [TEST_DOOR_ID]: new Uint8Array(32) })).toBe(true);
  });
});
