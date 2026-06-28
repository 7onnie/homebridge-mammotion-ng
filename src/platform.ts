import type {
  API,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
} from 'homebridge';

import { MammotionAccessory } from './accessory';
import { MammotionClient } from './mammotion-client';
import { MammotionMatterVacuum } from './matter-accessory';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import type { MammotionDeviceInfo, MammotionPlatformConfig } from './types';

type AccessoryContext = {
  deviceName: string;
};

export class MammotionPlatform implements DynamicPlatformPlugin {
  public get Service() {
    return this.api.hap.Service;
  }

  public get Characteristic() {
    return this.api.hap.Characteristic;
  }

  public readonly accessories: PlatformAccessory<AccessoryContext>[] = [];

  private readonly handlers = new Map<string, MammotionAccessory>();
  private readonly matterHandlers = new Map<string, MammotionMatterVacuum>();
  private readonly cachedMatterAccessories = new Map<string, unknown>();
  private readonly pollingSeconds: number;
  private pollTimer?: NodeJS.Timeout;
  private started = false;
  private readonly client: MammotionClient;
  private readonly usingMatterRvc: boolean;
  private readonly uuidNamespace: string;

  constructor(
    public readonly log: Logger,
    public readonly config: MammotionPlatformConfig,
    public readonly api: API,
  ) {
    const typedConfig = config as MammotionPlatformConfig;
    this.config = typedConfig;
    this.pollingSeconds = Math.max(5, typedConfig.pollIntervalSeconds ?? 15);
    this.client = new MammotionClient(log, typedConfig);
    this.usingMatterRvc = this.shouldUseMatterRvc();
    this.uuidNamespace = this.buildUuidNamespace();

    if (!this.config.email || !this.config.password) {
      this.log.error('Mammotion: set both email and password in config.');
      return;
    }

    this.api.on('didFinishLaunching', async () => {
      await this.startup();
    });

    this.api.on('shutdown', async () => {
      await this.shutdown();
    });
  }

  configureAccessory(accessory: PlatformAccessory<AccessoryContext>): void {
    this.accessories.push(accessory);
  }

  configureMatterAccessory(accessory: unknown): void {
    const uuid = (accessory as { UUID?: string }).UUID;
    if (typeof uuid === 'string') {
      this.cachedMatterAccessories.set(uuid, accessory);
    }
  }

  private async startup(): Promise<void> {
    if (this.started) {
      return;
    }

    this.started = true;

    try {
      await this.client.start();
      if (this.usingMatterRvc) {
        await this.discoverAndSyncMatterAccessories();
      } else {
        await this.discoverAndSyncAccessories();
      }
      await this.pollOnce();

      this.pollTimer = setInterval(() => {
        void this.pollOnce().catch((error: Error) => {
          this.log.warn(`Polling failed: ${error.message}`);
        });
      }, this.pollingSeconds * 1000);

      this.log.info(`Mammotion polling every ${this.pollingSeconds}s`);
    } catch (error) {
      this.log.error(`Mammotion startup failed: ${(error as Error).message}`);
    }
  }

  private async shutdown(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }

    await this.client.stop().catch((error: Error) => {
      this.log.warn(`Bridge shutdown failed: ${error.message}`);
    });
  }

  private async discoverAndSyncAccessories(): Promise<void> {
    const allDevices = await this.client.discoverDevices();
    const devices = this.filterDevices(allDevices);
    const liveNames = new Set(devices.map(device => device.name));

    for (const device of devices) {
      const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:${this.uuidNamespace}:${device.name}`);
      const existing = this.accessories.find(item => item.UUID === uuid);

      if (existing) {
        existing.displayName = device.name;
        const handler = new MammotionAccessory(this, existing, device, this.client);
        this.handlers.set(device.name, handler);
        this.api.updatePlatformAccessories([existing]);
        continue;
      }

      const accessory = new this.api.platformAccessory<AccessoryContext>(device.name, uuid);
      const handler = new MammotionAccessory(this, accessory, device, this.client);
      this.handlers.set(device.name, handler);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.push(accessory);
      this.log.info(`Added accessory for ${device.name}`);
    }

    const stale = this.accessories.filter(item => !liveNames.has(item.context.deviceName));
    if (stale.length > 0) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
      for (const accessory of stale) {
        this.handlers.delete(accessory.context.deviceName);
        const index = this.accessories.findIndex(item => item.UUID === accessory.UUID);
        if (index >= 0) {
          this.accessories.splice(index, 1);
        }
      }
      this.log.info(`Removed ${stale.length} stale Mammotion accessories`);
    }
  }

  private async discoverAndSyncMatterAccessories(): Promise<void> {
    const matter = this.getMatterApi();
    if (!matter) {
      this.log.warn('Matter API became unavailable; falling back to HAP switch mode.');
      await this.discoverAndSyncAccessories();
      return;
    }

    const allDevices = await this.client.discoverDevices();
    const devices = this.filterDevices(allDevices);
    const liveUuids = new Set<string>();
    const toRegister: unknown[] = [];

    this.matterHandlers.clear();

    for (const device of devices) {
      const handler = new MammotionMatterVacuum(
        matter,
        this.log,
        device,
        this.client,
        this.uuidNamespace,
      );
      this.matterHandlers.set(device.name, handler);
      liveUuids.add(handler.uuid);
      handler.logReady();

      if (!this.cachedMatterAccessories.has(handler.uuid)) {
        toRegister.push(handler.toAccessory());
      }
    }

    if (toRegister.length > 0) {
      await matter.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, toRegister);
      this.log.info(`Registered ${toRegister.length} Matter robotic vacuum accessory(s)`);
    }

    const stale = Array.from(this.cachedMatterAccessories.entries())
      .filter(([uuid]) => !liveUuids.has(uuid))
      .map(([, accessory]) => accessory);

    if (stale.length > 0) {
      await matter.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
      this.log.info(`Removed ${stale.length} stale Matter accessory(s)`);
    }
  }

  private async pollOnce(): Promise<void> {
    const states = await this.client.pollStates();
    if (this.usingMatterRvc) {
      await Promise.all(states.map(async state => {
        const handler = this.matterHandlers.get(state.name);
        if (handler) {
          await handler.updateState(state);
        }
      }));
      return;
    }

    for (const state of states) {
      const handler = this.handlers.get(state.name);
      if (handler) {
        handler.updateState(state);
      }
    }
  }

  private filterDevices(devices: MammotionDeviceInfo[]): MammotionDeviceInfo[] {
    const configured = this.config.deviceFilter;
    if (!configured || configured.length === 0) {
      return devices;
    }

    const allowed = new Set(configured);
    return devices.filter(device => allowed.has(device.name));
  }

  private shouldUseMatterRvc(): boolean {
    if (this.config.enableMatterRvc === false) {
      this.log.info('Matter RVC disabled in config; using HomeKit switch mode.');
      return false;
    }

    const api = this.api as unknown as {
      isMatterAvailable?: () => boolean;
      isMatterEnabled?: () => boolean;
      matter?: unknown;
    };

    const available = api.isMatterAvailable?.() ?? Boolean(api.matter);
    const enabled = api.isMatterEnabled?.() ?? Boolean(api.matter);

    if (!available || !enabled) {
      this.log.info('Matter is unavailable or disabled; using HomeKit switch fallback.');
      return false;
    }

    this.log.info('Matter API detected and enabled; using Matter robotic vacuum mode.');
    return true;
  }

  private getMatterApi(): null | {
    uuid: { generate: (input: string) => string };
    deviceTypes: { RoboticVacuumCleaner: unknown };
    registerPlatformAccessories: (pluginName: string, platformName: string, accessories: unknown[]) => Promise<void>;
    unregisterPlatformAccessories: (pluginName: string, platformName: string, accessories: unknown[]) => Promise<void>;
    updateAccessoryState: (
      uuid: string,
      cluster: string,
      attributes: Record<string, unknown>,
      partId?: string,
    ) => Promise<void>;
  } {
    const api = this.api as unknown as { matter?: unknown };
    if (!api.matter) {
      return null;
    }

    return api.matter as {
      uuid: { generate: (input: string) => string };
      deviceTypes: { RoboticVacuumCleaner: unknown };
      registerPlatformAccessories: (pluginName: string, platformName: string, accessories: unknown[]) => Promise<void>;
      unregisterPlatformAccessories: (pluginName: string, platformName: string, accessories: unknown[]) => Promise<void>;
      updateAccessoryState: (
        uuid: string,
        cluster: string,
        attributes: Record<string, unknown>,
        partId?: string,
      ) => Promise<void>;
    };
  }

  private buildUuidNamespace(): string {
    const identity = [
      this.config.name ?? '',
      this.config.email ?? '',
      this.config.platform ?? '',
    ].join('|');

    return identity.trim() || 'default';
  }
}
