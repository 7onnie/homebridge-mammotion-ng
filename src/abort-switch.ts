import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';
import type { MammotionClient } from './mammotion-client';
import type { MammotionPlatform } from './platform';

type Ctx = { deviceName: string };

export class MammotionAbortSwitch {
  private readonly service: Service;
  private inFlight = false;

  constructor(
    private readonly platform: MammotionPlatform,
    accessory: PlatformAccessory<Ctx>,
    private readonly deviceName: string,
    displayName: string,
    private readonly client: MammotionClient,
  ) {
    accessory.context.deviceName = deviceName;
    const C = this.platform.Characteristic;
    const S = this.platform.Service;
    const info = accessory.getService(S.AccessoryInformation) ?? accessory.addService(S.AccessoryInformation);
    info.setCharacteristic(C.Manufacturer, 'Mammotion').setCharacteristic(C.Model, 'Abort')
      .setCharacteristic(C.SerialNumber, `${deviceName}-abort`);

    this.service = accessory.getService(S.Switch) ?? accessory.addService(S.Switch, `${displayName} Abort Mowing`);
    this.service.getCharacteristic(C.On).onGet(() => false).onSet(this.onSet.bind(this));
    this.service.updateCharacteristic(C.On, false);
  }

  get deviceNameKey(): string { return this.deviceName; }

  private async onSet(value: CharacteristicValue): Promise<void> {
    if (!value) { return; }            // ignore the auto-reset write
    if (this.inFlight) { return; }     // double-press guard
    this.inFlight = true;
    const C = this.platform.Characteristic;
    const reset = setTimeout(() => this.service.updateCharacteristic(C.On, false), 500);
    reset.unref?.();
    try {
      await this.client.command(this.deviceName, 'cancel');
    } catch (e) {
      this.platform.log.warn(`Abort failed for ${this.deviceName}: ${(e as Error).message}`);
    } finally {
      this.inFlight = false;
      this.service.updateCharacteristic(C.On, false);
    }
  }
}
