/**
 * Typed error for the website Door.
 * Messages may name env vars or paths; never secret values, visitor text or IPs.
 */
export class WebDoorError extends Error {
  readonly code: string;

  constructor(code: string, message: string, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "WebDoorError";
    this.code = code;
  }
}
