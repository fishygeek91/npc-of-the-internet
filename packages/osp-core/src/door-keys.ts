import { EncodingError } from "./errors.js";
import { decodePublicKey } from "./encoding/base64url.js";

/**
 * Parse a single Door public-key binding of the form `doorId=base64url`.
 * Door ids match the residency Door portion (e.g. `discord:guild123`).
 */
export function parseDoorPublicKeyBinding(encoded: string): {
  doorId: string;
  publicKey: Uint8Array;
} {
  const trimmed = encoded.trim();
  const separator = trimmed.indexOf("=");
  if (separator <= 0 || separator === trimmed.length - 1) {
    throw new EncodingError(
      'door public key binding must be "doorId=base64url" (example: discord:guild123=<key>)'
    );
  }

  const doorId = trimmed.slice(0, separator);
  const keyPart = trimmed.slice(separator + 1);
  if (doorId.includes("=") || keyPart.includes("=")) {
    throw new EncodingError(
      'door public key binding must be "doorId=base64url" with a single "=" separator'
    );
  }

  return {
    doorId,
    publicKey: decodePublicKey(keyPart)
  };
}

/**
 * Parse comma-separated or list-of `doorId=base64url` bindings into a doorId → key map.
 * Later duplicates for the same doorId overwrite earlier entries.
 */
export function parseDoorPublicKeyMap(
  entries: readonly string[] | string
): Record<string, Uint8Array> {
  const segments =
    typeof entries === "string"
      ? entries
          .split(",")
          .map((part) => part.trim())
          .filter((part) => part.length > 0)
      : [...entries];

  const map: Record<string, Uint8Array> = {};
  for (const segment of segments) {
    const binding = parseDoorPublicKeyBinding(segment);
    map[binding.doorId] = binding.publicKey;
  }
  return map;
}

/** True when the map contains at least one Door public key. */
export function hasDoorPublicKeys(
  doorPublicKeys: Readonly<Record<string, Uint8Array>> | undefined
): boolean {
  return doorPublicKeys !== undefined && Object.keys(doorPublicKeys).length > 0;
}
