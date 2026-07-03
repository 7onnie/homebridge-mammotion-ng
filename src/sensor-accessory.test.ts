import { describe, it, expect } from 'vitest';
import { Debouncer } from './debouncer';
import { contactValue, CONTACT_DETECTED, CONTACT_NOT_DETECTED } from './sensor-accessory';
import type { DerivedState } from './types';

const D = (o: Partial<DerivedState>): DerivedState =>
  ({ online: true, docked: false, mowing: false, error: false, active: false, ...o });

describe('contactValue', () => {
  it('maps a true flag to CONTACT_DETECTED (first observation commits immediately)', () => {
    const deb = new Debouncer();
    expect(contactValue('mowing', D({ mowing: true }), deb, 1000, 'Yuka', 0)).toBe(CONTACT_DETECTED);
  });

  it('maps a false flag to CONTACT_NOT_DETECTED', () => {
    const deb = new Debouncer();
    expect(contactValue('docked', D({ docked: false }), deb, 1000, 'Yuka', 0)).toBe(CONTACT_NOT_DETECTED);
  });

  it('error rises immediately (dwell 0) even with a large debounce', () => {
    const deb = new Debouncer();
    contactValue('error', D({ error: false }), deb, 1000, 'Yuka', 0);
    expect(contactValue('error', D({ error: true }), deb, 1000, 'Yuka', 1)).toBe(CONTACT_DETECTED);
  });

  it('error fall is sticky (stays detected until a full dwell after the change is first seen)', () => {
    const deb = new Debouncer();
    contactValue('error', D({ error: true }), deb, 1000, 'Yuka', 0);              // committed detected
    expect(contactValue('error', D({ error: false }), deb, 1000, 'Yuka', 500)).toBe(CONTACT_DETECTED);    // fall seen @500, still latched
    expect(contactValue('error', D({ error: false }), deb, 1000, 'Yuka', 1500)).toBe(CONTACT_NOT_DETECTED); // held 1000ms -> clears
  });

  it('docked uses symmetric debounce (a change holds until the dwell elapses)', () => {
    const deb = new Debouncer();
    contactValue('docked', D({ docked: true }), deb, 1000, 'Yuka', 0);            // commit detected
    expect(contactValue('docked', D({ docked: false }), deb, 1000, 'Yuka', 500)).toBe(CONTACT_DETECTED);    // pending
    expect(contactValue('docked', D({ docked: false }), deb, 1000, 'Yuka', 1500)).toBe(CONTACT_NOT_DETECTED); // dwell met
  });

  it('keys are independent per (device, kind)', () => {
    const deb = new Debouncer();
    contactValue('docked', D({ docked: true }), deb, 1000, 'Yuka', 0);
    contactValue('mowing', D({ mowing: false }), deb, 1000, 'Yuka', 0);
    expect(contactValue('docked', D({ docked: true }), deb, 1000, 'Yuka', 10)).toBe(CONTACT_DETECTED);
    expect(contactValue('mowing', D({ mowing: false }), deb, 1000, 'Yuka', 10)).toBe(CONTACT_NOT_DETECTED);
  });
});
