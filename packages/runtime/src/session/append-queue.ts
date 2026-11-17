/**
 * Serializes async jobs so each starts only after the previous one settles.
 *
 * The tail promise never rejects: a failed job rejects only the promise
 * {@link AppendQueue.enqueue} returned for it, and the next job still runs.
 * This is the append-chain and inbound-chain pattern Session used inline.
 */
export class AppendQueue {
  private chain: Promise<unknown> = Promise.resolve();

  /**
   * Schedule `fn` after every job already on this queue.
   * `fn` runs even when the previous job rejected.
   */
  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  /**
   * Fulfills when every job enqueued so far has settled.
   * Does not reject when a job failed, and does not include jobs enqueued later.
   */
  settled(): Promise<unknown> {
    return this.chain;
  }
}
