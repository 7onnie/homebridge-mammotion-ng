import type { PlatformAccessory, Service } from 'homebridge';
import type { Debouncer } from './debouncer';
import type { MammotionPlatform } from './platform';
import type { DerivedState } from './types';

export const CONTACT_DETECTED = 1;      // HAP ContactSensorState.CONTACT_DETECTED
export const CONTACT_NOT_DETECTED = 0;  // HAP ContactSensorState.CONTACT_NOT_DETECTED

export type SensorKind = 'docked' | 'mowing' | 'error';

export const SENSOR_LABEL: Record<SensorKind, string> = {
  docked: 'Docked',
  mowing: 'Mowing',
  error: 'Problem',
};

/**
 * Pure: the debounced contact value for one sensor kind.
 * Docked/Mowing use the configured dwell both ways; Error rises immediately
 * (dwell 0) and falls sticky (full dwell), so a single-poll fault still stays
 * visible long enough to fire a HomeKit automation.
 */
export function contactValue(
  kind: SensorKind,
  d: DerivedState,
  deb: Debouncer,
  debounceMs: number,
  key: string,
  now: number,
): number {
  const raw = kind === 'docked' ? d.docked : kind === 'mowing' ? d.mowing : d.error;
  const dwell = kind === 'error' && raw ? 0 : debounceMs;
  const committed = deb.push(`${key}:${kind}`, raw, dwell, now);
  return committed ? CONTACT_DETECTED : CONTACT_NOT_DETECTED;
}

type Ctx = { deviceName: string };

// One ContactSensor per accessory. Apple Home shows generic/identical names
// for multiple same-type services on a single accessory, so each sensor is its
// own PlatformAccessory with a distinct name the Home app displays reliably.
export class MammotionSensorAccessory {
  private readonly service: Service;

  constructor(
    private readonly platform: MammotionPlatform,
    accessory: PlatformAccessory<Ctx>,
    private readonly deviceName: string,
    private readonly kind: SensorKind,
    private readonly deb: Debouncer,
    private readonly debounceMs: number,
  ) {
    accessory.context.deviceName = deviceName;
    const C = this.platform.Characteristic;
    const S = this.platform.Service;
    const displayName = `${deviceName} ${SENSOR_LABEL[kind]}`;

    const info = accessory.getService(S.AccessoryInformation) ?? accessory.addService(S.AccessoryInformation);
    info.setCharacteristic(C.Manufacturer, 'Mammotion')
      .setCharacteristic(C.Model, `Mower ${SENSOR_LABEL[kind]} Sensor`)
      .setCharacteristic(C.SerialNumber, `${deviceName}-${kind}`);

    this.service = accessory.getService(S.ContactSensor) ?? accessory.addService(S.ContactSensor, displayName);
    this.service.setCharacteristic(C.Name, displayName);
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
  }
}
