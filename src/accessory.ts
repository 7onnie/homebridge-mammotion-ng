import type {
  CharacteristicValue,
  PlatformAccessory,
  Service,
} from 'homebridge';

import type { MammotionClient } from './mammotion-client';
import type { MammotionDeviceInfo, MammotionState } from './types';
import type { MammotionPlatform } from './platform';

type MowerContext = {
  deviceName: string;
};

export class MammotionAccessory {
  private readonly switchService: Service;
  private readonly batteryService: Service;
  private state: MammotionState;

  constructor(
    private readonly platform: MammotionPlatform,
    private readonly accessory: PlatformAccessory<MowerContext>,
    private readonly device: MammotionDeviceInfo,
    private readonly client: MammotionClient,
  ) {
    accessory.context.deviceName = device.name;
    this.state = {
      name: this.device.name,
      online: false,
      battery: 0,
      chargeState: 0,
      sysStatus: 0,
      modeName: 'unknown',
      areaProgress: 0,
      hasError: false,
      serviceAreas: [],
      selectedAreaIds: [],
      currentAreaId: null,
    };

    const information = accessory.getService(this.platform.Service.AccessoryInformation)
      ?? accessory.addService(this.platform.Service.AccessoryInformation);

    information
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Mammotion')
      .setCharacteristic(this.platform.Characteristic.Model, device.model ?? 'Mower')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, device.serialNumber ?? device.name)
      .setCharacteristic(this.platform.Characteristic.Name, device.name)
      .setCharacteristic(this.platform.Characteristic.FirmwareRevision, 'via PyMammotion');

    this.switchService = accessory.getService(this.platform.Service.Switch)
      ?? accessory.addService(this.platform.Service.Switch);

    this.switchService.setCharacteristic(this.platform.Characteristic.Name, device.name);
    this.switchService.getCharacteristic(this.platform.Characteristic.On)
      .onGet(this.handleOnGet.bind(this))
      .onSet(this.handleOnSet.bind(this));

    this.batteryService = accessory.getService(this.platform.Service.Battery)
      ?? accessory.addService(this.platform.Service.Battery);

    this.updateState(this.state);
  }

  get deviceName(): string {
    return this.device.name;
  }

  updateState(nextState: MammotionState): void {
    this.state = nextState;

    const on = this.isMowing(nextState);
    const battery = Math.max(0, Math.min(100, Math.round(nextState.battery)));

    this.switchService.updateCharacteristic(this.platform.Characteristic.On, on);
    this.switchService.updateCharacteristic(this.platform.Characteristic.StatusActive, nextState.online);
    this.switchService.updateCharacteristic(
      this.platform.Characteristic.StatusFault,
      nextState.hasError
        ? this.platform.Characteristic.StatusFault.GENERAL_FAULT
        : this.platform.Characteristic.StatusFault.NO_FAULT,
    );

    this.batteryService.updateCharacteristic(this.platform.Characteristic.BatteryLevel, battery);
    this.batteryService.updateCharacteristic(
      this.platform.Characteristic.StatusLowBattery,
      battery <= 20
        ? this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
        : this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL,
    );
    this.batteryService.updateCharacteristic(
      this.platform.Characteristic.ChargingState,
      nextState.chargeState !== 0
        ? this.platform.Characteristic.ChargingState.CHARGING
        : this.platform.Characteristic.ChargingState.NOT_CHARGING,
    );
  }

  private handleOnGet(): CharacteristicValue {
    return this.isMowing(this.state);
  }

  private async handleOnSet(value: CharacteristicValue): Promise<void> {
    const turnOn = Boolean(value);

    const action: 'start' | 'pause' | 'dock' | 'cancel' = turnOn
      ? 'start'
      : (this.platform.config.offCommand ?? 'pause');

    const updated = await this.client.command(this.device.name, action);
    this.updateState(updated);
  }

  private isMowing(state: MammotionState): boolean {
    return state.modeName === 'MODE_WORKING';
  }
}
