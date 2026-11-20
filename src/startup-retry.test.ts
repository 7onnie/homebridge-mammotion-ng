import { describe, expect, it, vi } from 'vitest';

import { StartupRetry } from './startup-retry';

function harness(attempt: () => Promise<void>, extra: Partial<ConstructorParameters<typeof StartupRetry>[0]> = {}) {
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const log = { error: vi.fn(), info: vi.fn() };
  const retry = new StartupRetry({
    attempt,
    log,
    initialDelayMs: 1000,
    maxDelayMs: 8000,
    setTimer: (fn, ms) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return {};
    },
    clearTimer: () => {
      timers[timers.length - 1].cleared = true;
    },
    ...extra,
  });
  return { retry, timers, log };
}

describe('StartupRetry (issue #5)', () => {
  it('schedules a retry after a failed first start and logs the error loudly', async () => {
    const attempt = vi.fn().mockRejectedValueOnce(new Error('login refused')).mockResolvedValue(undefined);
    const { retry, timers, log } = harness(attempt);

    expect(await retry.run()).toBe(false);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error.mock.calls[0][0]).toContain('login refused');
    expect(timers).toHaveLength(1);
    expect(timers[0].ms).toBe(1000);

    timers[0].fn();
    await vi.waitFor(() => expect(attempt).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(log.info).toHaveBeenCalled());
    expect(timers).toHaveLength(1); // success => nothing further scheduled
  });

  it('backs off exponentially and caps the delay, never giving up', async () => {
    const attempt = vi.fn().mockRejectedValue(new Error('boom'));
    const { retry, timers } = harness(attempt);

    await retry.run();
    for (let i = 0; i < 6; i++) {
      timers[timers.length - 1].fn();
      await vi.waitFor(() => expect(timers).toHaveLength(i + 2));
    }
    expect(timers.map(t => t.ms)).toEqual([1000, 2000, 4000, 8000, 8000, 8000, 8000]);
  });

  it('stop() cancels the pending retry and prevents further attempts', async () => {
    const attempt = vi.fn().mockRejectedValue(new Error('boom'));
    const { retry, timers } = harness(attempt);
    await retry.run();
    retry.stop();
    expect(timers[0].cleared).toBe(true);
    expect(await retry.run()).toBe(false);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('does not schedule again when stopped during a running attempt', async () => {
    let fail!: (e: Error) => void;
    const attempt = vi.fn(() => new Promise<void>((_, rej) => { fail = rej; }));
    const { retry, timers } = harness(attempt);
    const p = retry.run();
    retry.stop();
    fail(new Error('late'));
    await p;
    expect(timers).toHaveLength(0);
  });
});
