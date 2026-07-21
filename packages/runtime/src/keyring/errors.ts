/** Thrown when keyring custody or key loading fails. */
export class KeyringError extends Error {
  readonly code = "KEYRING_ERROR";

  constructor(message: string) {
    super(message);
    this.name = "KeyringError";
  }
}
