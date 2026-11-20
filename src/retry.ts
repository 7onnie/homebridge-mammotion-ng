export interface BackoffOptions {
  /** Delay before the first retry. */
  initialMs: number;
  /** Upper bound for the doubling delay. */
  maxMs: number;
  /** Checked after every failure and after every sleep; true aborts the loop. */
  isStopped: () => boolean;
  onFailure: (error: unknown, nextDelayMs: number) => void;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });

/**
 * Runs `fn` until it succeeds, waiting initialMs, 2x, 4x ... (capped at maxMs) between
 * attempts. Returns true on success, false when isStopped() ended the loop first.
 */
export async function retryUntilSuccess(fn: () => Promise<void>, opts: BackoffOptions): Promise<boolean> {
  const sleep = opts.sleep ?? realSleep;
  let delay = opts.initialMs;
  for (;;) {
    try {
      await fn();
      return true;
    } catch (error) {
      if (opts.isStopped()) {
        return false;
      }
      opts.onFailure(error, delay);
      await sleep(delay);
      if (opts.isStopped()) {
        return false;
      }
      delay = Math.min(delay * 2, opts.maxMs);
    }
  }
}
