import { describe, expect, it } from 'vitest';
import lib from './bootstrap-lib.js';

describe('parsePins', () => {
  it('extracts only exact == pins and normalises names', () => {
    expect(lib.parsePins(['pymammotion==0.10.15', 'packaging', 'betterproto2==0.10.0', 'foo>=1'])).toEqual({
      pymammotion: '0.10.15',
      betterproto2: '0.10.0',
    });
  });
});

describe('envIsCurrent', () => {
  const pins = { pymammotion: '0.10.15', betterproto2: '0.10.0' };
  it('is true when every pinned package has the pinned version', () => {
    expect(lib.envIsCurrent({ pymammotion: '0.10.15', betterproto2: '0.10.0' }, pins)).toBe(true);
  });
  it('is false when an older pymammotion is present (issue #4)', () => {
    expect(lib.envIsCurrent({ pymammotion: '0.8.8', betterproto2: '0.10.0' }, pins)).toBe(false);
  });
  it('is false when a pinned package is missing', () => {
    expect(lib.envIsCurrent({ pymammotion: '0.10.15' }, pins)).toBe(false);
  });
  it('is false when versions are unknown', () => {
    expect(lib.envIsCurrent(null, pins)).toBe(false);
  });
});
