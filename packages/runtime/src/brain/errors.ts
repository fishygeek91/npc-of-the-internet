/** Thrown when Brain configuration or completion fails. */
export class BrainError extends Error {
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "BrainError";
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}
