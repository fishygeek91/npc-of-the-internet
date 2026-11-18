/**
 * Closed Discord Door `error.code` vocabulary.
 */
export const DISCORD_DOOR_ERROR_CODES = [
  "invalid_config",
  "discord_error",
  "internal_error"
] as const;

/** Machine code for {@link DiscordDoorError}. Same union as {@link DISCORD_DOOR_ERROR_CODES}. */
export type DiscordDoorErrorCode = (typeof DISCORD_DOOR_ERROR_CODES)[number];

/**
 * Typed error for the Discord Door adapter.
 * Messages may name env vars or Discord identifiers; never include secret values.
 */
export class DiscordDoorError extends Error {
  readonly code: DiscordDoorErrorCode;

  constructor(code: DiscordDoorErrorCode, message: string, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "DiscordDoorError";
    this.code = code;
  }
}

/**
 * Short operator-facing notice for in-channel errors (no stacks, no payloads).
 */
export function operatorNotice(error: unknown): string {
  if (error instanceof DiscordDoorError) {
    return `Door error (${error.code}): ${error.message}`;
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    "message" in error &&
    typeof (error as { code: unknown }).code === "string" &&
    typeof (error as { message: unknown }).message === "string"
  ) {
    const coded = error as { code: string; message: string };
    return `Door error (${coded.code}): ${coded.message}`;
  }
  if (error instanceof Error) {
    return `Door error: ${error.message}`;
  }
  return "Door error: unexpected failure";
}
