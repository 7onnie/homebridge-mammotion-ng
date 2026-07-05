import { describe, it, expect } from 'vitest';
import { Debouncer } from './debouncer';
import { contactValue, CONTACT_DETECTED, CONTACT_NOT_DETECTED } from './sensor-accessory';
import type { DerivedState } from './types';

const D = (o: Partial<DerivedState>): DerivedState =>
  ({ online: true, docked: false, mowing: false, error: false, active: false, bladeWorn: false, mowPercent: 0, ...o });

// New polarity: CONTACT_NOT_DETECTED (open) = the named event is happening,
// CONTACT_DETECTED (closed) = resting/normal. Events: docked->undocked,
// mowing->mowing, error->problem, bladewear->worn.
describe('contactValue', () => {
  it('mowing event maps to CONTACT_NOT_DETECTED (open); commits immediately', () => {
    const deb = new Debouncer();
    expect(contactValue('mowing', D({ mowing: true }), deb, 1000, 'Yuka', 0)).toBe(CONTACT_NOT_DETECTED);
  });

  it('docked (resting) maps to CONTACT_DETECTED (closed) — the Undocked sensor stays closed while docked', () => {
    const deb = new Debouncer();
    expect(contactValue('docked', D({ docked: true }), deb, 1000, 'Yuka', 0)).toBe(CONTACT_DETECTED);
  });

  it('undocked maps to CONTACT_NOT_DETECTED (open)', () => {
    const deb = new Debouncer();
    expect(contactValue('docked', D({ docked: false }), deb, 1000, 'Yuka', 0)).toBe(CONTACT_NOT_DETECTED);
  });

  it('bladewear: worn -> open, ok -> closed', () => {
    expect(contactValue('bladewear', D({ bladeWorn: true }), new Debouncer(), 1000, 'Yuka', 0)).toBe(CONTACT_NOT_DETECTED);
    expect(contactValue('bladewear', D({ bladeWorn: false }), new Debouncer(), 1000, 'Yuka', 0)).toBe(CONTACT_DETECTED);
  });

  it('error rises immediately (dwell 0) even with a large debounce', () => {
    const deb = new Debouncer();
    contactValue('error', D({ error: false }), deb, 1000, 'Yuka', 0);
    expect(contactValue('error', D({ error: true }), deb, 1000, 'Yuka', 1)).toBe(CONTACT_NOT_DETECTED);
  });

  it('error fall is sticky (stays open until a full dwell after the change is first seen)', () => {
    const deb = new Debouncer();
    contactValue('error', D({ error: true }), deb, 1000, 'Yuka', 0);               // committed open (problem)
    expect(contactValue('error', D({ error: false }), deb, 1000, 'Yuka', 500)).toBe(CONTACT_NOT_DETECTED);  // fall seen @500, still latched open
    expect(contactValue('error', D({ error: false }), deb, 1000, 'Yuka', 1500)).toBe(CONTACT_DETECTED);     // held 1000ms -> clears to closed
  });

  it('docked uses symmetric debounce (a change holds until the dwell elapses)', () => {
    const deb = new Debouncer();
    contactValue('docked', D({ docked: false }), deb, 1000, 'Yuka', 0);            // undocked -> commit open
    expect(contactValue('docked', D({ docked: true }), deb, 1000, 'Yuka', 500)).toBe(CONTACT_NOT_DETECTED);  // docked seen @500, pending -> still open
    expect(contactValue('docked', D({ docked: true }), deb, 1000, 'Yuka', 1500)).toBe(CONTACT_DETECTED);     // dwell met -> closed (docked)
  });

  it('keys are independent per (device, kind)', () => {
    const deb = new Debouncer();
    contactValue('docked', D({ docked: false }), deb, 1000, 'Yuka', 0);
    contactValue('mowing', D({ mowing: false }), deb, 1000, 'Yuka', 0);
    expect(contactValue('docked', D({ docked: false }), deb, 1000, 'Yuka', 10)).toBe(CONTACT_NOT_DETECTED); // undocked = open
    expect(contactValue('mowing', D({ mowing: false }), deb, 1000, 'Yuka', 10)).toBe(CONTACT_DETECTED);     // not mowing = closed
  });
});
