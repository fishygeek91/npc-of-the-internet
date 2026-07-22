export type DaemonErrorReason = "invalid_config" | "door_mismatch" | "boot_failed";

/** Thrown when residency daemon configuration or boot fails. */
export class DaemonError extends Error {
  readonly reason: DaemonErrorReason;
  /** Set when a required environment variable is missing. */
  readonly envVar?: string;

  constructor(message: string, reason: DaemonErrorReason, envVar?: string) {
    super(message);
    this.name = "DaemonError";
    this.reason = reason;
    if (envVar !== undefined) {
      this.envVar = envVar;
    }
  }
}
