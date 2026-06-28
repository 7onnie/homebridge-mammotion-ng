import { describe, it, expect } from 'vitest';
import { Debouncer } from './debouncer';
import { sensorContactValues, CONTACT_DETECTED, CONTACT_NOT_DETECTED } from './sensor-accessory';
import type { DerivedState } from './types';

const cfg = { debounceMs: 1000, key: 'Yuka' };
const D = (o: Partial<DerivedState>): DerivedState =>
  ({ online: true, docked: false, mowing: false, error: false, active: false, ...o });

describe('sensorContactValues', () => {
  it('maps true flags to CONTACT_DETECTED after first observation', () => {
    const deb = new Debouncer();
    const v = sensorContactValues(D({ mowing: true }), deb, cfg, 0);
    expect(v.mowing).toBe(CONTACT_DETECTED);
    expect(v.docked).toBe(CONTACT_NOT_DETECTED);
  });
  it('error rises immediately (dwell 0) even with a large debounce', () => {
    const deb = new Debouncer();
    sensorContactValues(D({ error: false }), deb, cfg, 0);
    const v = sensorContactValues(D({ error: true }), deb, cfg, 1); // 1ms later
    expect(v.error).toBe(CONTACT_DETECTED);
  });
  it('error fall is sticky (does not clear before debounce)', () => {
    const deb = new Debouncer();
    sensorContactValues(D({ error: true }), deb, cfg, 0);
    const v = sensorContactValues(D({ error: false }), deb, cfg, 500); // < debounce
    expect(v.error).toBe(CONTACT_DETECTED); // still latched
  });
});
