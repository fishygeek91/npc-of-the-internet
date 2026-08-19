import { BrainError } from "./errors.js";
import type { Brain, BrainMessage, BrainResult, BrainUsage, CompleteOptions } from "./types.js";
import { ZERO_BRAIN_USAGE } from "./types.js";

export type FakeBrainHandler = (
  messages: BrainMessage[],
  opts?: CompleteOptions
) => string | BrainResult | Promise<string | BrainResult>;

/** Recorded arguments from each `complete` call (for test assertions). */
export type FakeBrainCall = {
  messages: BrainMessage[];
  opts?: CompleteOptions;
};

/** Optional FakeBrain constructor overrides. */
export type FakeBrainOptions = {
  usage?: BrainUsage;
};

function toResult(value: string | BrainResult, fallback: BrainUsage): BrainResult {
  if (typeof value === "string") {
    return { text: value, usage: fallback };
  }
  return value;
}

/**
 * Deterministic Brain for tests. Returns scripted responses in order, or delegates
 * to a handler function. Records every call for inspection.
 */
export class FakeBrain implements Brain {
  readonly calls: FakeBrainCall[] = [];
  private scriptIndex = 0;
  private readonly defaultUsage: BrainUsage;

  constructor(
    private readonly script: string[] | FakeBrainHandler,
    options?: FakeBrainOptions
  ) {
    this.defaultUsage = options?.usage ?? ZERO_BRAIN_USAGE;
  }

  async complete(messages: BrainMessage[], opts?: CompleteOptions): Promise<BrainResult> {
    const call: FakeBrainCall = opts !== undefined ? { messages, opts } : { messages };
    this.calls.push(call);

    if (typeof this.script === "function") {
      return toResult(await this.script(messages, opts), this.defaultUsage);
    }

    if (this.scriptIndex >= this.script.length) {
      return Promise.reject(
        new BrainError(
          `FakeBrain script exhausted after ${this.script.length} response(s); no more scripted replies`,
          "provider"
        )
      );
    }

    const response = this.script[this.scriptIndex];
    if (response === undefined) {
      return Promise.reject(
        new BrainError(
          `FakeBrain script exhausted after ${this.script.length} response(s); no more scripted replies`,
          "provider"
        )
      );
    }
    this.scriptIndex += 1;
    return Promise.resolve(toResult(response, this.defaultUsage));
  }
}
