import { describe, it, expect } from 'vitest';
import { mapState } from './state-mapper';
import type { MammotionState } from './types';

const base: MammotionState = {
  name: 'Yuka', online: true, battery: 80, chargeState: 0, sysStatus: 0,
  modeName: 'unknown', areaProgress: 0, hasError: false,
  serviceAreas: [], selectedAreaIds: [], currentAreaId: null,
};
const opt = { offlineConfirmed: false, errorIncludesOffline: true };

describe('mapState', () => {
  it('mowing when sysStatus=13', () => {
    const d = mapState({ ...base, sysStatus: 13 }, opt);
    expect(d).toMatchObject({ mowing: true, docked: false, error: false, active: true });
  });
  it('docked when charging on dock', () => {
    const d = mapState({ ...base, chargeState: 1, sysStatus: 15 }, opt);
    expect(d).toMatchObject({ docked: true, mowing: false, error: false });
  });
  it('MODE_CHARGING_PAUSE(39) is NOT docked/finished', () => {
    const d = mapState({ ...base, chargeState: 1, sysStatus: 39 }, opt);
    expect(d.docked).toBe(false);
  });
  it('error from MODE_LOCK(17) and takes precedence over docked', () => {
    const d = mapState({ ...base, chargeState: 1, sysStatus: 17 }, opt);
    expect(d).toMatchObject({ error: true, docked: false, mowing: false });
  });
  it('error from hasError flag', () => {
    expect(mapState({ ...base, hasError: true }, opt).error).toBe(true);
  });
  it('offlineConfirmed raises error only when errorIncludesOffline', () => {
    expect(mapState({ ...base, online: false }, { offlineConfirmed: true, errorIncludesOffline: true }).error).toBe(true);
    expect(mapState({ ...base, online: false }, { offlineConfirmed: true, errorIncludesOffline: false }).error).toBe(false);
  });
  it('all flags false in idle/transitional', () => {
    const d = mapState({ ...base, sysStatus: 0 }, opt);
    expect(d).toMatchObject({ docked: false, mowing: false, error: false });
  });
});
