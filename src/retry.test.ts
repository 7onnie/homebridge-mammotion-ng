import { describe, expect, it } from 'vitest';
import { retryUntilSuccess } from './retry';

describe('retryUntilSuccess', () => {
  it('returns true without waiting when the first attempt succeeds', async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const ok = await retryUntilSuccess(async () => { calls++; }, {
      initialMs: 10, maxMs: 100, isStopped: () => false, onFailure: () => {},
      sleep: async (ms) => { sleeps.push(ms); },
    });
    expect(ok).toBe(true);
    expect(calls).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it('retries after a failure with doubling delay capped at maxMs', async () => {
    const sleeps: number[] = [];
    const failures: string[] = [];
    let calls = 0;
    const ok = await retryUntilSuccess(async () => {
      calls++;
      if (calls < 5) { throw new Error(`boom${calls}`); }
    }, {
      initialMs: 10, maxMs: 30, isStopped: () => false,
      onFailure: (e, d) => failures.push(`${(e as Error).message}@${d}`),
      sleep: async (ms) => { sleeps.push(ms); },
    });
    expect(ok).toBe(true);
    expect(calls).toBe(5);
    expect(sleeps).toEqual([10, 20, 30, 30]);
    expect(failures[0]).toBe('boom1@10');
  });

  it('stops retrying once isStopped() turns true and returns false', async () => {
    let stopped = false;
    let calls = 0;
    const ok = await retryUntilSuccess(async () => { calls++; throw new Error('x'); }, {
      initialMs: 10, maxMs: 100, isStopped: () => stopped, onFailure: () => {},
      sleep: async () => { stopped = true; },
    });
    expect(ok).toBe(false);
    expect(calls).toBe(1);
  });
});
