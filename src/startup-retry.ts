// Retry-with-backoff for the first platform start (issue #5).
//
// A failed first start (Python bootstrap, cloud login, bridge init) used to be
// logged once and then nothing ever ran again: no polling, no recovery. This
// runs `attempt` until it succeeds. Delay doubles per failure up to `maxDelayMs`
// (the upper bound), then stays there — retrying never stops on its own, so
// there is no state in which the platform silently does nothing. Every failure
// is logged at error level.

export type RetryLogger = {
  error(message: string): void;
  info(message: string): void;
};

export type StartupRetryOptions = {
  attempt: () => Promise<void>;
  log: RetryLogger;
  initialDelayMs?: number;
  maxDelayMs?: number;
  // Injectable for tests.
  setTimer?: (fn: () => void, ms: number) => { unref?: () => void };
  clearTimer?: (handle: unknown) => void;
};

export class StartupRetry {
  private failures = 0;
  private stopped = false;
  private running = false;
  private timer?: unknown;
  private readonly initialDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly setTimer: NonNullable<StartupRetryOptions['setTimer']>;
  private readonly clearTimer: NonNullable<StartupRetryOptions['clearTimer']>;

  constructor(private readonly opts: StartupRetryOptions) {
    this.initialDelayMs = opts.initialDelayMs ?? 15_000;
    this.maxDelayMs = opts.maxDelayMs ?? 600_000;
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? (h => clearTimeout(h as NodeJS.Timeout));
  }

  get failureCount(): number {
    return this.failures;
  }

  delayForFailure(failureNumber: number): number {
    return Math.min(this.initialDelayMs * 2 ** Math.max(0, failureNumber - 1), this.maxDelayMs);
  }

  async run(): Promise<boolean> {
    if (this.stopped || this.running) {
      return false;
    }
    this.running = true;
    try {
      await this.opts.attempt();
    } catch (error) {
      this.failures += 1;
      const delay = this.delayForFailure(this.failures);
      this.opts.log.error(
        `Mammotion startup failed (attempt ${this.failures}): ${(error as Error).message} — retrying in ${Math.round(delay / 1000)}s`,
      );
      if (!this.stopped) {
        const handle = this.setTimer(() => {
          this.timer = undefined;
          void this.run();
        }, delay);
        handle.unref?.();
        this.timer = handle;
      }
      return false;
    } finally {
      this.running = false;
    }
    if (this.failures > 0) {
      this.opts.log.info(`Mammotion startup succeeded after ${this.failures} failed attempt(s)`);
    }
    this.failures = 0;
    return true;
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) {
      this.clearTimer(this.timer);
      this.timer = undefined;
    }
  }
}
