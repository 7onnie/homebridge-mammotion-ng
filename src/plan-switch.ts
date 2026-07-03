import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';
import type { MammotionClient } from './mammotion-client';
import type { MammotionPlatform } from './platform';

type Ctx = { deviceName: string; planId?: string };

// One momentary switch per saved plan. Tapping it runs that specific plan via
// single_schedule(planId). Auto-resets like the Abort switch, so it also works
// as an automation trigger ("run the Front Lawn plan when I leave").
export class MammotionPlanSwitch {
  private readonly service: Service;
  private inFlight = false;

  constructor(
    private readonly platform: MammotionPlatform,
    accessory: PlatformAccessory<Ctx>,
    private readonly deviceName: string,
    displayName: string,
    private readonly planId: string,
    private readonly planName: string,
    private readonly client: MammotionClient,
  ) {
    accessory.context.deviceName = deviceName;
    accessory.context.planId = planId;
    const C = this.platform.Characteristic;
    const S = this.platform.Service;
    const info = accessory.getService(S.AccessoryInformation) ?? accessory.addService(S.AccessoryInformation);
    info.setCharacteristic(C.Manufacturer, 'Mammotion').setCharacteristic(C.Model, 'Plan')
      .setCharacteristic(C.SerialNumber, `${deviceName}-plan-${planId}`);

    this.service = accessory.getService(S.Switch) ?? accessory.addService(S.Switch, `${displayName} Run ${planName}`);
    this.service.setCharacteristic(C.Name, `${displayName} Run ${planName}`);
    this.service.getCharacteristic(C.On).onGet(() => false).onSet(this.onSet.bind(this));
    this.service.updateCharacteristic(C.On, false);
  }

  get deviceNameKey(): string { return this.deviceName; }

  get planIdKey(): string { return this.planId; }

  private async onSet(value: CharacteristicValue): Promise<void> {
    if (!value) { return; }            // ignore the auto-reset write
    if (this.inFlight) { return; }     // double-press guard
    this.inFlight = true;
    const C = this.platform.Characteristic;
    const reset = setTimeout(() => this.service.updateCharacteristic(C.On, false), 500);
    reset.unref?.();
    try {
      await this.client.startPlan(this.deviceName, this.planId);
    } catch (e) {
      this.platform.log.warn(`Run plan '${this.planName}' failed for ${this.deviceName}: ${(e as Error).message}`);
    } finally {
      this.inFlight = false;
      this.service.updateCharacteristic(C.On, false);
    }
  }
}
