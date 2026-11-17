/**
 * Await every teardown step.
 *
 * A rejection does not skip later steps. After all steps have settled, the first
 * rejection is rethrown, including a rejection whose reason is `undefined`.
 *
 * @param steps - Resource stops, in the order they should be attempted.
 */
export async function stopAll(steps: readonly (() => Promise<void>)[]): Promise<void> {
  const errors: unknown[] = [];
  for (const step of steps) {
    try {
      await step();
    } catch (error: unknown) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw errors[0];
  }
}

/**
 * Run `stop` on SIGINT/SIGTERM.
 *
 * A rejection is logged and does not skip process exit. `exit` is always called
 * with `0` so a failed teardown cannot leave the process stuck.
 *
 * @param stop - Releases listeners and sockets.
 * @param exit - Process exit. Tests inject this; production passes `process.exit`.
 * @param log - Receives the rejection from `stop`. A throw here is swallowed.
 */
export function exitAfterStop(
  stop: () => Promise<void>,
  exit: (code: number) => void,
  log: (error: unknown) => void
): void {
  void stop()
    .catch((error: unknown) => {
      try {
        log(error);
      } catch {
        // A broken logger must not skip process exit.
      }
    })
    .finally(() => {
      exit(0);
    });
}
