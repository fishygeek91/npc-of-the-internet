import type { ChainFailure } from "@npc/osp-core";

/** Thrown when composeSelf cannot build a self from the store (e.g. invalid chain). */
export class ComposeError extends Error {
  readonly code = "COMPOSE_ERROR";
  readonly failures: readonly ChainFailure[];

  constructor(message: string, failures: readonly ChainFailure[]) {
    super(message);
    this.name = "ComposeError";
    this.failures = failures;
  }
}
