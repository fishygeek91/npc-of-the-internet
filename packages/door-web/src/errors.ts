/**
 * Closed website Door `error.code` vocabulary.
 * These are process errors, not the porch HTTP codes in `site.ts`.
 */
export const WEB_DOOR_ERROR_CODES = ["invalid_config", "payload_too_large"] as const;

/** Machine code for {@link WebDoorError}. Same union as {@link WEB_DOOR_ERROR_CODES}. */
export type WebDoorErrorCode = (typeof WEB_DOOR_ERROR_CODES)[number];

/**
 * Typed error for the website Door.
 * Messages may name env vars or paths; never secret values, visitor text or IPs.
 */
export class WebDoorError extends Error {
  readonly code: WebDoorErrorCode;

  constructor(code: WebDoorErrorCode, message: string, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "WebDoorError";
    this.code = code;
  }
}
