import { BrainError } from "./errors.js";
import type { Brain, BrainMessage, CompleteOptions } from "./types.js";

export type FakeBrainHandler = (messages: BrainMessage[], opts?: CompleteOptions) => string;

/** Recorded arguments from each `complete` call (for test assertions). */
export type FakeBrainCall = {
  messages: BrainMessage[];
  opts?: CompleteOptions;
};

/**
 * Deterministic Brain for tests. Returns scripted responses in order, or delegates
 * to a handler function. Records every call for inspection.
 */
export class FakeBrain implements Brain {
  readonly calls: FakeBrainCall[] = [];
  private scriptIndex = 0;

  constructor(private readonly script: string[] | FakeBrainHandler) {}

  complete(messages: BrainMessage[], opts?: CompleteOptions): Promise<string> {
    const call: FakeBrainCall = opts !== undefined ? { messages, opts } : { messages };
    this.calls.push(call);

    if (typeof this.script === "function") {
      return Promise.resolve(this.script(messages, opts));
    }

    if (this.scriptIndex >= this.script.length) {
      return Promise.reject(
        new BrainError(
          `FakeBrain script exhausted after ${this.script.length} response(s); no more scripted replies`
        )
      );
    }

    const response = this.script[this.scriptIndex];
    if (response === undefined) {
      return Promise.reject(
        new BrainError(
          `FakeBrain script exhausted after ${this.script.length} response(s); no more scripted replies`
        )
      );
    }
    this.scriptIndex += 1;
    return Promise.resolve(response);
  }
}
