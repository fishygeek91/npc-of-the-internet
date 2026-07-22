/**
 * Typed error for the Discord Door adapter.
 * Messages may name env vars or Discord identifiers; never include secret values.
 */
export class DiscordDoorError extends Error {
  readonly code: string;

  constructor(code: string, message: string, cause?: unknown) {
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
