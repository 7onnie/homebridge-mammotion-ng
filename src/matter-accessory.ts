import type { Logger } from 'homebridge';

import type { MammotionClient } from './mammotion-client';
import type { DerivedState, MammotionDeviceInfo, MammotionState } from './types';

type MatterApi = {
  uuid: { generate: (input: string) => string };
  deviceTypes: { RoboticVacuumCleaner: unknown };
  updateAccessoryState: (
    uuid: string,
    cluster: string,
    attributes: Record<string, unknown>,
    partId?: string,
  ) => Promise<void>;
};

type MatterAccessoryLike = {
  UUID: string;
  displayName: string;
  deviceType: unknown;
  serialNumber: string;
  manufacturer: string;
  model: string;
  firmwareRevision: string;
  hardwareRevision: string;
  context: Record<string, unknown>;
  clusters: Record<string, unknown>;
  handlers: Record<string, unknown>;
};

export class MammotionMatterVacuum {
  private state: MammotionState;

  private readonly accessory: MatterAccessoryLike;

  constructor(
    private readonly matterApi: MatterApi,
    private readonly log: Logger,
    private readonly device: MammotionDeviceInfo,
    private readonly client: MammotionClient,
    uuidSeed: string,
    displayName: string,
    private readonly exposeBattery: boolean,
  ) {
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

    const serial = device.serialNumber ?? device.name;
    const uuid = matterApi.uuid.generate(`mammotion-rvc:${uuidSeed}:${device.name}`);

    this.accessory = {
      UUID: uuid,
      displayName,
      deviceType: matterApi.deviceTypes.RoboticVacuumCleaner,
      serialNumber: serial,
      manufacturer: 'Mammotion',
      model: device.model ?? 'Mower',
      firmwareRevision: 'via PyMammotion',
      hardwareRevision: '1.0',
      context: {
        deviceName: device.name,
      },
      clusters: {
        rvcRunMode: {
          supportedModes: [
            { label: 'Idle', mode: 0, modeTags: [{ value: 16384 }] },
            { label: 'Cleaning', mode: 1, modeTags: [{ value: 16385 }] },
          ],
          currentMode: 0,
        },
        rvcCleanMode: {
          supportedModes: [
            { label: 'Vacuum', mode: 0, modeTags: [{ value: 16385 }] },
          ],
          currentMode: 0,
        },
        rvcOperationalState: {
          operationalStateList: [
            { operationalStateId: 0 },
            { operationalStateId: 1 },
            { operationalStateId: 2 },
            { operationalStateId: 3 },
            { operationalStateId: 64 },
            { operationalStateId: 65 },
            { operationalStateId: 66 },
          ],
          operationalState: 66,
        },
      },
      handlers: {
        rvcRunMode: {
          changeToMode: async (request: { newMode: number }) => {
            if (request.newMode === 1) {
              await this.client.command(this.device.name, 'start');
            } else {
              await this.client.command(this.device.name, 'dock');
            }
          },
        },
        rvcOperationalState: {
          pause: async () => {
            await this.client.command(this.device.name, 'pause');
          },
          resume: async () => {
            await this.client.command(this.device.name, 'start');
          },
          goHome: async () => {
            await this.client.command(this.device.name, 'dock');
          },
        },
      },
    };

    // Battery on the RVC tile via the Matter Power Source cluster. Declaring it
    // with batPercentRemaining + batChargeState makes Homebridge attach a
    // Battery+Rechargeable PowerSourceServer. Updated live in updateState().
    if (this.exposeBattery) {
      (this.accessory.clusters as Record<string, unknown>).powerSource = {
        status: 1,               // Active
        batPresent: true,
        batChargeLevel: 0,       // Ok
        batPercentRemaining: 0,  // Matter encodes % as *2; set on first poll
        batChargeState: 0,       // Unknown
      };
    }
  }

  toAccessory(): MatterAccessoryLike {
    return this.accessory;
  }

  get uuid(): string {
    return this.accessory.UUID;
  }

  get deviceName(): string {
    return this.device.name;
  }

  async updateState(nextState: MammotionState, derived: DerivedState): Promise<void> {
    this.state = nextState;

    const runMode = this.isWorking(nextState) ? 1 : 0;
    const operationalState = this.toOperationalState(nextState, derived);

    await this.matterApi.updateAccessoryState(this.uuid, 'rvcRunMode', {
      currentMode: runMode,
    });

    await this.matterApi.updateAccessoryState(this.uuid, 'rvcOperationalState', {
      operationalState,
    });

    if (this.exposeBattery) {
      const pct = Math.max(0, Math.min(100, Math.round(Number(nextState.battery ?? 0))));
      const charge = Number(nextState.chargeState ?? 0);
      // Matter batChargeState: 1=IsCharging, 2=IsAtFullCharge, 3=IsNotCharging.
      const batChargeState = charge !== 0 ? (pct >= 100 ? 2 : 1) : 3;
      // Matter batChargeLevel: 0=Ok, 1=Warning, 2=Critical.
      const batChargeLevel = pct <= 10 ? 2 : pct <= 20 ? 1 : 0;
      await this.matterApi.updateAccessoryState(this.uuid, 'powerSource', {
        batPercentRemaining: pct * 2, // Matter encodes % as double (0-200)
        batChargeState,
        batChargeLevel,
      }).catch(() => undefined);
    }
  }

  private toOperationalState(state: MammotionState, derived: DerivedState): number {
    if (derived.error) {
      return 3; // Error
    }
    if (!state.online) {
      return 3;
    }

    if (this.isWorking(state)) {
      return 1;
    }

    if (this.isPaused(state)) {
      return 2;
    }

    if (this.isReturning(state)) {
      return 64;
    }

    if (state.chargeState !== 0) {
      return 65;
    }

    return 0;
  }

  logReady(): void {
    this.log.info(`Matter RVC ready for ${this.device.name}`);
  }

  private isWorking(state: MammotionState): boolean {
    return state.sysStatus === 13
      || state.modeName === 'MODE_WORKING'
      || state.modeName.endsWith('WORKING');
  }

  private isPaused(state: MammotionState): boolean {
    return state.sysStatus === 19
      || state.modeName === 'MODE_PAUSE'
      || state.modeName.endsWith('PAUSE');
  }

  private isReturning(state: MammotionState): boolean {
    return state.sysStatus === 14
      || state.modeName === 'MODE_RETURNING'
      || state.modeName.endsWith('RETURNING');
  }
}
