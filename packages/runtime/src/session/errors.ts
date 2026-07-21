/** Thrown when Session loop operations or Door contract checks fail. */
export class SessionError extends Error {
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "SessionError";
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}
