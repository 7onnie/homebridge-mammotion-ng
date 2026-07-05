import type { DerivedState, MammotionState } from './types';

// pymammotion device_mode integers (verify against the installed
// pymammotion/utility/constant/device_constant.py before relying on these).
export const MODE_WORKING = 13;
export const MODE_RETURNING = 14;
export const MODE_CHARGING = 15;
export const MODE_LOCK = 17;
export const MODE_PAUSE = 19;
export const MODE_OTA_UPGRADE_FAIL = 23;
export const MODE_LOCATION_ERROR = 37;
export const MODE_CHARGING_PAUSE = 39;

const ERROR_MODES = new Set<number>([MODE_LOCK, MODE_OTA_UPGRADE_FAIL, MODE_LOCATION_ERROR]);

export function mapState(
  state: MammotionState,
  opts: { offlineConfirmed: boolean; errorIncludesOffline: boolean; errorIncludesSensorFaults?: boolean },
): DerivedState {
  const online = Boolean(state.online);
  const sys = Number(state.sysStatus ?? 0);
  const charge = Number(state.chargeState ?? 0);

  const returning = sys === MODE_RETURNING;
  const mowing = online && sys === MODE_WORKING;

  const error =
    Boolean(state.hasError) ||
    ERROR_MODES.has(sys) ||
    (opts.errorIncludesOffline && opts.offlineConfirmed) ||
    Boolean(opts.errorIncludesSensorFaults && state.sensorFault && online);

  // Precedence: ERROR > DOCKED > MOWING. Charging-pause(39) is mid-job, not docked.
  const docked =
    online && !error && !mowing && !returning &&
    (charge !== 0 || sys === MODE_CHARGING) && sys !== MODE_CHARGING_PAUSE;

  return {
    online,
    error,
    docked: error ? false : docked,
    mowing: error ? false : mowing,
    active: error ? false : (mowing || returning),
    bladeWorn: Boolean(state.bladeWorn),
    mowPercent: Math.max(0, Math.min(100, Number(state.mowPercent ?? 0))),
  };
}
