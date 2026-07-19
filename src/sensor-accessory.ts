import type { PlatformAccessory, Service } from 'homebridge';
import type { Debouncer } from './debouncer';
import type { MammotionPlatform } from './platform';
import type { DerivedState } from './types';

// HAP ContactSensorState: 0 = contact detected (closed / resting),
// 1 = not detected (open / the "alerting" state Apple Home flags yellow).
export const CONTACT_DETECTED = 0;
export const CONTACT_NOT_DETECTED = 1;

// Internal kind IDs are kept stable for UUIDs/pairing. 'docked' is LABELLED
// "Undocked" because the alerting (open) state is "away from dock" — the mower
// is docked ~90% of the time, so resting must read CLOSED (no persistent
// warning). See eventFor(): closed = resting, open = the named event.
export type SensorKind = 'docked' | 'mowing' | 'error' | 'returning' | 'bladewear';

export const SENSOR_LABEL: Record<SensorKind, string> = {
  docked: 'Undocked',
  mowing: 'Mowing',
  error: 'Problem',
  returning: 'Returning'
  bladewear: 'Blade Service',
};

// The "event" (open/alert) condition per sensor. Closed = NOT this condition.
function eventFor(kind: SensorKind, d: DerivedState): boolean {
  switch (kind) {
    case 'docked': return !d.docked;   // open = undocked / away
    case 'mowing': return d.mowing;    // open = mowing
    case 'error': return d.error;      // open = problem
    case 'returning': return d.returning; // open = returning to dock
    case 'bladewear': return d.bladeWorn; // open = blade needs service
  }
}

// Minimal shape of a fakegato-history 'door' logging service.
export interface HistoryLogger {
  addEntry(entry: { time: number; status: number }): void;
}

/**
 * Pure: the debounced contact value for one sensor kind.
 * Returns CONTACT_NOT_DETECTED (open) while the named event holds, else
 * CONTACT_DETECTED (closed). Docked/Mowing/BladeWear use the configured dwell
 * both ways; Error (a problem) rises immediately (dwell 0) and falls sticky
 * (full dwell), so a single-poll fault stays visible long enough to fire a
 * HomeKit automation.
 */
export function contactValue(
  kind: SensorKind,
  d: DerivedState,
  deb: Debouncer,
  debounceMs: number,
  key: string,
  now: number,
): number {
  const event = eventFor(kind, d);
  const dwell = kind === 'error' && event ? 0 : debounceMs;
  const committed = deb.push(`${key}:${kind}`, event, dwell, now);
  return committed ? CONTACT_NOT_DETECTED : CONTACT_DETECTED;
}

type Ctx = { deviceName: string };

// One ContactSensor per accessory. Apple Home shows generic/identical names
// for multiple same-type services on a single accessory, so each sensor is its
// own PlatformAccessory with a distinct name the Home app displays reliably.
export class MammotionSensorAccessory {
  private readonly service: Service;
  private lastContact?: number;

  constructor(
    private readonly platform: MammotionPlatform,
    accessory: PlatformAccessory<Ctx>,
    private readonly deviceName: string,
    displayName: string,
    private readonly kind: SensorKind,
    private readonly deb: Debouncer,
    private readonly debounceMs: number,
    private readonly history?: HistoryLogger,
  ) {
    accessory.context.deviceName = deviceName;
    const C = this.platform.Characteristic;
    const S = this.platform.Service;
    const label = `${displayName} ${SENSOR_LABEL[kind]}`;

    const info = accessory.getService(S.AccessoryInformation) ?? accessory.addService(S.AccessoryInformation);
    info.setCharacteristic(C.Manufacturer, 'Mammotion')
      .setCharacteristic(C.Model, `Mower ${SENSOR_LABEL[kind]} Sensor`)
      .setCharacteristic(C.SerialNumber, `${deviceName}-${kind}`);

    this.service = accessory.getService(S.ContactSensor) ?? accessory.addService(S.ContactSensor, label);
    this.service.setCharacteristic(C.Name, label);
  }

  get deviceNameKey(): string { return this.deviceName; }

  updateState(d: DerivedState, now: number): void {
    const C = this.platform.Characteristic;
    const contact = contactValue(this.kind, d, this.deb, this.debounceMs, this.deviceName, now);
    this.service.updateCharacteristic(C.ContactSensorState, contact);
    this.service.updateCharacteristic(C.StatusActive, d.online);
    this.service.updateCharacteristic(
      C.StatusFault,
      d.error ? C.StatusFault.GENERAL_FAULT : C.StatusFault.NO_FAULT,
    );

    // Eve history: log only on a state change (fakegato 'door' timeline).
    if (this.history && contact !== this.lastContact) {
      this.lastContact = contact;
      this.history.addEntry({ time: Math.round(now / 1000), status: contact });
    }
  }
}
