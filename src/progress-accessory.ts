import type { PlatformAccessory, Service } from 'homebridge';
import type { MammotionPlatform } from './platform';
import type { DerivedState } from './types';

type Ctx = { deviceName: string };

// Mow progress % exposed as a HumiditySensor — the only native read-only
// percentage in Apple Home (Lightbulb/Fan would look controllable). Apple Home
// labels it "Humidity"; the tile can be renamed. Eve shows a % graph natively.
export class MammotionProgressAccessory {
  private readonly service: Service;

  constructor(
    private readonly platform: MammotionPlatform,
    accessory: PlatformAccessory<Ctx>,
    private readonly deviceName: string,
    displayName: string,
  ) {
    accessory.context.deviceName = deviceName;
    const C = this.platform.Characteristic;
    const S = this.platform.Service;
    const label = `${displayName} Progress`;

    const info = accessory.getService(S.AccessoryInformation) ?? accessory.addService(S.AccessoryInformation);
    info.setCharacteristic(C.Manufacturer, 'Mammotion')
      .setCharacteristic(C.Model, 'Mow Progress')
      .setCharacteristic(C.SerialNumber, `${deviceName}-progress`);

    this.service = accessory.getService(S.HumiditySensor) ?? accessory.addService(S.HumiditySensor, label);
    this.service.setCharacteristic(C.Name, label);
  }

  get deviceNameKey(): string { return this.deviceName; }

  updateState(d: DerivedState): void {
    const C = this.platform.Characteristic;
    const pct = Math.max(0, Math.min(100, Math.round(d.mowPercent ?? 0)));
    this.service.updateCharacteristic(C.CurrentRelativeHumidity, pct);
    this.service.updateCharacteristic(C.StatusActive, d.online);
  }
}
