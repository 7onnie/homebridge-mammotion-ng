import { describe, it, expect } from 'vitest';
import { Debouncer } from './debouncer';

describe('Debouncer', () => {
  it('commits the first observed value immediately', () => {
    const d = new Debouncer();
    expect(d.push('k', true, 1000, 0)).toBe(true);
  });
  it('holds a change until the dwell elapses', () => {
    const d = new Debouncer();
    d.push('k', true, 1000, 0);          // committed true
    expect(d.push('k', false, 1000, 500)).toBe(true);  // pending, dwell not met
    expect(d.push('k', false, 500, 1000)).toBe(false); // dwell met -> commit false
  });
  it('cancels a pending change if value reverts', () => {
    const d = new Debouncer();
    d.push('k', true, 1000, 0);
    d.push('k', false, 1000, 500);       // pending false
    expect(d.push('k', true, 1000, 700)).toBe(true);   // back to committed -> clear pending
    expect(d.push('k', false, 1000, 800)).toBe(true);  // dwell restarts; not yet
  });
  it('dwell 0 commits instantly (immediate error rise)', () => {
    const d = new Debouncer();
    d.push('e', false, 1000, 0);
    expect(d.push('e', true, 0, 100)).toBe(true);
  });
  it('keys are independent', () => {
    const d = new Debouncer();
    d.push('a', true, 1000, 0);
    d.push('b', false, 1000, 0);
    expect(d.push('a', true, 1000, 10)).toBe(true);
    expect(d.push('b', false, 1000, 10)).toBe(false);
  });
});
