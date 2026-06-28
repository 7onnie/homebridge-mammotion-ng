import type { PlatformAccessory, Service } from 'homebridge';
import type { Debouncer } from './debouncer';
import type { MammotionPlatform } from './platform';
import type { DerivedState } from './types';

export const CONTACT_DETECTED = 1;      // HAP ContactSensorState.CONTACT_DETECTED
export const CONTACT_NOT_DETECTED = 0;  // HAP ContactSensorState.CONTACT_NOT_DETECTED

export interface SensorCfg { debounceMs: number; key: string }

/** Pure: derive the three contact-sensor values, applying debounce + sticky error. */
export function sensorContactValues(
  d: DerivedState,
  deb: Debouncer,
  cfg: SensorCfg,
  now: number,
): { docked: number; mowing: number; error: number } {
  const docked = deb.push(`${cfg.key}:docked`, d.docked, cfg.debounceMs, now);
  const mowing = deb.push(`${cfg.key}:mowing`, d.mowing, cfg.debounceMs, now);
  // error rises immediately (dwell 0), falls sticky (full debounce)
  const errDwell = d.error ? 0 : cfg.debounceMs;
  const error = deb.push(`${cfg.key}:error`, d.error, errDwell, now);
  return {
    docked: docked ? CONTACT_DETECTED : CONTACT_NOT_DETECTED,
    mowing: mowing ? CONTACT_DETECTED : CONTACT_NOT_DETECTED,
    error: error ? CONTACT_DETECTED : CONTACT_NOT_DETECTED,
  };
}

type Ctx = { deviceName: string };

export class MammotionSensorAccessory {
  private readonly docked?: Service;
  private readonly mowing?: Service;
  private readonly error?: Service;

  constructor(
    private readonly platform: MammotionPlatform,
    accessory: PlatformAccessory<Ctx>,
    private readonly deviceName: string,
    private readonly deb: Debouncer,
    private readonly debounceMs: number,
    enable: { docked: boolean; mowing: boolean; error: boolean },
  ) {
    accessory.context.deviceName = deviceName;
    const C = this.platform.Characteristic;
    const S = this.platform.Service;

    const info = accessory.getService(S.AccessoryInformation) ?? accessory.addService(S.AccessoryInformation);
    info.setCharacteristic(C.Manufacturer, 'Mammotion').setCharacteristic(C.Model, 'Mower Sensors')
      .setCharacteristic(C.SerialNumber, `${deviceName}-sensors`);

    const mk = (subtype: string, name: string): Service =>
      accessory.getServiceById(S.ContactSensor, subtype)
        ?? accessory.addService(S.ContactSensor, name, subtype);

    if (enable.docked) { this.docked = mk('docked', `${deviceName} Docked`); }
    if (enable.mowing) { this.mowing = mk('mowing', `${deviceName} Mowing`); }
    if (enable.error)  { this.error  = mk('error',  `${deviceName} Problem`); }
  }

  get deviceNameKey(): string { return this.deviceName; }

  updateState(d: DerivedState, now: number): void {
    const C = this.platform.Characteristic;
    const v = sensorContactValues(d, this.deb, { debounceMs: this.debounceMs, key: this.deviceName }, now);
    const apply = (svc: Service | undefined, contact: number) => {
      if (!svc) { return; }
      svc.updateCharacteristic(C.ContactSensorState, contact);
      svc.updateCharacteristic(C.StatusActive, d.online);
      svc.updateCharacteristic(
        C.StatusFault,
        d.error ? C.StatusFault.GENERAL_FAULT : C.StatusFault.NO_FAULT,
      );
    };
    apply(this.docked, v.docked);
    apply(this.mowing, v.mowing);
    apply(this.error, v.error);
  }
}
