import type {
  API,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
} from 'homebridge';

import { MammotionAccessory } from './accessory';
import { Debouncer } from './debouncer';
import { MammotionClient } from './mammotion-client';
import { MammotionMatterVacuum } from './matter-accessory';
import { MammotionAbortSwitch } from './abort-switch';
import { MammotionPlanSwitch } from './plan-switch';
import { MammotionSensorAccessory, SENSOR_LABEL, type SensorKind, type HistoryLogger } from './sensor-accessory';
import { MammotionProgressAccessory } from './progress-accessory';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { mapState } from './state-mapper';
import type { DerivedState, MammotionDeviceInfo, MammotionPlan, MammotionPlatformConfig, MammotionState } from './types';
import FakeGatoHistoryServiceFactory = require('fakegato-history');

type AccessoryContext = {
  deviceName: string;
  kind?: 'sensors' | 'abort' | 'plan' | 'progress';
  planId?: string;
  // Persisted plan name so cached plan switches can be re-armed with a working
  // handler on startup, before (or without) the first non-empty plan sync.
  planName?: string;
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
  private readonly matterEnabled: boolean;
  private readonly sensorHandlers = new Map<string, MammotionSensorAccessory[]>();
  private readonly abortHandlers = new Map<string, MammotionAbortSwitch>();
  private readonly planHandlers = new Map<string, MammotionPlanSwitch[]>();
  private readonly lastPlanKey = new Map<string, string>();
  private readonly progressHandlers = new Map<string, MammotionProgressAccessory>();
  private readonly deviceInfo = new Map<string, MammotionDeviceInfo>();
  private fakeGatoFactory?: ReturnType<typeof FakeGatoHistoryServiceFactory>;
  private readonly debouncer = new Debouncer();
  private readonly offlineCounts = new Map<string, number>();
  private readonly uuidNamespace: string;
  // Wedged-transport watchdog + crash-respawn state.
  private readonly staleThresholdSeconds: number;
  private watchdogRestarts = 0;
  private watchdogNextRestartAt = 0;
  private restartInFlight = false;
  private respawnDelayMs = 10_000;
  private shuttingDown = false;

  constructor(
    public readonly log: Logger,
    public readonly config: MammotionPlatformConfig,
    public readonly api: API,
  ) {
    const typedConfig = config as MammotionPlatformConfig;
    this.config = typedConfig;
    this.pollingSeconds = Math.max(5, typedConfig.pollIntervalSeconds ?? 15);
    this.client = new MammotionClient(log, typedConfig);
    // Wedged = no inbound cloud frame for 3 activity-loop cycles (min 10 min).
    this.staleThresholdSeconds = Math.max(3 * (typedConfig.cloudRefreshSeconds ?? 120), 600);
    this.matterEnabled = this.shouldUseMatterRvc();
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

    // Auto-respawn: without this, an unexpected bridge death left the plugin
    // permanently dead (nothing listened for 'exit'). Doubling backoff so a
    // crash-looping bridge can't hammer the Mammotion cloud with logins.
    this.client.on('exit', (error: Error) => {
      if (this.shuttingDown) {
        return;
      }
      this.log.error(`${error.message} — respawning in ${Math.round(this.respawnDelayMs / 1000)}s`);
      const delay = this.respawnDelayMs;
      this.respawnDelayMs = Math.min(this.respawnDelayMs * 2, 600_000);
      const timer = setTimeout(() => {
        void this.client.start()
          .then(() => {
            this.log.info('Mammotion bridge respawned');
            this.respawnDelayMs = 10_000;
          })
          .catch((e: Error) => this.log.error(`Bridge respawn failed: ${e.message}`));
      }, delay);
      timer.unref?.();
    });

    try {
      await this.client.start();
      if (this.matterEnabled) {
        await this.discoverAndSyncMatterAccessories();
      } else {
        await this.discoverAndSyncAccessories(); // legacy HAP switch fallback
      }
      await this.syncSensors();
      await this.syncAbortSwitch();
      await this.syncProgress();
      this.cleanupDisabledPlanSwitches();
      this.armCachedPlanSwitches();
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
    this.shuttingDown = true;
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
      this.deviceInfo.set(device.name, device);
      const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:${this.uuidNamespace}:${device.name}`);
      const existing = this.accessories.find(item => item.UUID === uuid);

      const dName = this.displayNameFor(device);
      if (existing) {
        existing.displayName = dName;
        const handler = new MammotionAccessory(this, existing, device, this.client);
        this.handlers.set(device.name, handler);
        this.api.updatePlatformAccessories([existing]);
        continue;
      }

      const accessory = new this.api.platformAccessory<AccessoryContext>(dName, uuid);
      const handler = new MammotionAccessory(this, accessory, device, this.client);
      this.handlers.set(device.name, handler);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.push(accessory);
      this.log.info(`Added accessory for ${device.name}`);
    }

    const stale = this.accessories.filter(item => !item.context.kind && !liveNames.has(item.context.deviceName));
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
      this.deviceInfo.set(device.name, device);
      const handler = new MammotionMatterVacuum(
        matter,
        this.log,
        device,
        this.client,
        this.uuidNamespace,
        this.displayNameFor(device),
        this.config.exposeBattery !== false,
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

  private async syncSensors(): Promise<void> {
    const enabled = this.config.enableStateSensors !== false;
    const devices = enabled ? this.filterDevices(await this.client.discoverDevices()) : [];
    const debounceMs = Math.max(0, (this.config.sensorDebounceSeconds ?? 30) * 1000);
    const kinds: Array<{ kind: SensorKind; on: boolean }> = [
      { kind: 'docked', on: this.config.sensorDocked !== false },
      { kind: 'mowing', on: this.config.sensorMowing !== false },
      { kind: 'error', on: this.config.sensorError !== false },
      { kind: 'returning', on: this.config.sensorReturning !== false },
      { kind: 'bladewear', on: this.config.sensorBladeWear === true },
    ];

    // One accessory per sensor kind (distinct names in Apple Home).
    const liveUuids = new Set<string>();
    this.sensorHandlers.clear();

    for (const device of devices) {
      const handlers: MammotionSensorAccessory[] = [];
      const dName = this.displayNameFor(device);
      for (const { kind, on } of kinds) {
        if (!on) {
          continue;
        }
        const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:${this.uuidNamespace}:${device.name}:sensor:${kind}`);
        liveUuids.add(uuid);
        const existing = this.accessories.find(item => item.UUID === uuid);
        const accessory = existing ?? new this.api.platformAccessory<AccessoryContext>(`${dName} ${SENSOR_LABEL[kind]}`, uuid);
        accessory.context.deviceName = device.name;
        accessory.context.kind = 'sensors';
        accessory.displayName = `${dName} ${SENSOR_LABEL[kind]}`;
        const history = this.makeDoorHistory(accessory);
        handlers.push(new MammotionSensorAccessory(this, accessory, device.name, dName, kind, this.debouncer, debounceMs, history));
        if (existing) {
          this.api.updatePlatformAccessories([existing]);
        } else {
          this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
          this.accessories.push(accessory);
          this.log.info(`Added ${SENSOR_LABEL[kind]} sensor for ${device.name}`);
        }
      }
      this.sensorHandlers.set(device.name, handlers);
    }

    // Remove sensor accessories no longer live: device dropped, sensors
    // disabled, a kind turned off, or the old combined ":sensors" accessory.
    const stale = this.accessories.filter(item => item.context.kind === 'sensors' && !liveUuids.has(item.UUID));
    if (stale.length > 0) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
      for (const acc of stale) {
        const index = this.accessories.findIndex(item => item.UUID === acc.UUID);
        if (index >= 0) {
          this.accessories.splice(index, 1);
        }
      }
      this.log.info(`Removed ${stale.length} stale sensor accessory(s)`);
    }
  }

  private async syncAbortSwitch(): Promise<void> {
    const enabled = this.config.enableAbortSwitch === true;
    const devices = enabled ? this.filterDevices(await this.client.discoverDevices()) : [];
    const liveNames = new Set(devices.map(device => device.name));

    for (const device of devices) {
      const dName = this.displayNameFor(device);
      const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:${this.uuidNamespace}:${device.name}:switch:abort`);
      const existing = this.accessories.find(item => item.UUID === uuid);
      const accessory = existing ?? new this.api.platformAccessory<AccessoryContext>(`${dName} Abort`, uuid);
      accessory.context.deviceName = device.name;
      accessory.context.kind = 'abort';
      accessory.displayName = `${dName} Abort`;
      const handler = new MammotionAbortSwitch(this, accessory, device.name, dName, this.client);
      this.abortHandlers.set(device.name, handler);
      if (existing) {
        this.api.updatePlatformAccessories([existing]);
      } else {
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.push(accessory);
        this.log.info(`Added Abort switch for ${device.name}`);
      }
    }

    const stale = this.accessories.filter(
      item => item.context.kind === 'abort' && !liveNames.has(item.context.deviceName),
    );
    if (stale.length > 0) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
      for (const acc of stale) {
        this.abortHandlers.delete(acc.context.deviceName);
        const index = this.accessories.findIndex(item => item.UUID === acc.UUID);
        if (index >= 0) {
          this.accessories.splice(index, 1);
        }
      }
      this.log.info(`Removed ${stale.length} stale Abort switch(es)`);
    }
  }

  // fakegato 'door' history for a contact-sensor accessory (Eve open/close
  // timeline). HAP-only; Apple Home ignores the Eve service. Returns undefined
  // when disabled or if the library can't init.
  private makeDoorHistory(accessory: PlatformAccessory<AccessoryContext>): HistoryLogger | undefined {
    if (this.config.enableEveHistory === false) {
      return undefined;
    }
    try {
      if (!this.fakeGatoFactory) {
        this.fakeGatoFactory = FakeGatoHistoryServiceFactory(this.api);
      }
      const service = new this.fakeGatoFactory('door', accessory, {
        storage: 'fs',
        path: this.api.user.persistPath(),
        size: 4096,
      });
      return service as unknown as HistoryLogger;
    } catch (e) {
      this.log.debug(`Eve history unavailable: ${(e as Error).message}`);
      return undefined;
    }
  }

  // Mow-progress % as a HumiditySensor (opt-in). Same stable-UUID + stale-remove
  // pattern as the other sensors.
  private async syncProgress(): Promise<void> {
    const enabled = this.config.sensorProgress === true;
    const devices = enabled ? this.filterDevices(await this.client.discoverDevices()) : [];
    const liveNames = new Set(devices.map(device => device.name));

    for (const device of devices) {
      const dName = this.displayNameFor(device);
      const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:${this.uuidNamespace}:${device.name}:sensor:progress`);
      const existing = this.accessories.find(item => item.UUID === uuid);
      const accessory = existing ?? new this.api.platformAccessory<AccessoryContext>(`${dName} Progress`, uuid);
      accessory.context.deviceName = device.name;
      accessory.context.kind = 'progress';
      accessory.displayName = `${dName} Progress`;
      const handler = new MammotionProgressAccessory(this, accessory, device.name, dName);
      this.progressHandlers.set(device.name, handler);
      if (existing) {
        this.api.updatePlatformAccessories([existing]);
      } else {
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.push(accessory);
        this.log.info(`Added progress sensor for ${device.name}`);
      }
    }

    const stale = this.accessories.filter(
      item => item.context.kind === 'progress' && !liveNames.has(item.context.deviceName),
    );
    if (stale.length > 0) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
      for (const acc of stale) {
        this.progressHandlers.delete(acc.context.deviceName);
        const index = this.accessories.findIndex(item => item.UUID === acc.UUID);
        if (index >= 0) {
          this.accessories.splice(index, 1);
        }
      }
      this.log.info(`Removed ${stale.length} stale progress sensor(s)`);
    }
  }

  private async pollOnce(): Promise<void> {
    const states = await this.client.pollStates();
    const gracePolls = Math.max(0, this.config.offlineGracePolls ?? 2);
    const errorIncludesOffline = this.config.errorIncludesOffline !== false;
    const now = Date.now();

    for (const state of states) {
      // offline grace counter
      const prev = this.offlineCounts.get(state.name) ?? 0;
      const count = state.online ? 0 : prev + 1;
      this.offlineCounts.set(state.name, count);
      const offlineConfirmed = count > gracePolls;

      const derived: DerivedState = mapState(state, {
        offlineConfirmed,
        errorIncludesOffline,
        errorIncludesSensorFaults: this.config.errorIncludesSensorFaults === true,
      });

      const matter = this.matterHandlers.get(state.name);
      if (matter) {
        await matter.updateState(state, derived).catch((e: Error) => this.log.debug(`Matter update failed: ${e.message}`));
      }
      const legacy = this.handlers.get(state.name);
      if (legacy) {
        try { legacy.updateState(state); } catch (e) { this.log.debug(`HAP switch update failed: ${(e as Error).message}`); }
      }
      const sensors = this.sensorHandlers.get(state.name);
      if (sensors) {
        for (const sensor of sensors) {
          try { sensor.updateState(derived, now); } catch (e) { this.log.debug(`Sensor update failed: ${(e as Error).message}`); }
        }
      }

      const progress = this.progressHandlers.get(state.name);
      if (progress) {
        try { progress.updateState(derived); } catch (e) { this.log.debug(`Progress update failed: ${(e as Error).message}`); }
      }

      if (this.config.enablePlanSwitches === true) {
        const info = this.deviceInfo.get(state.name);
        const dName = info ? this.displayNameFor(info) : state.name;
        try {
          this.syncPlanSwitches(state.name, dName, state.plans ?? []);
        } catch (e) {
          this.log.debug(`Plan switch sync failed: ${(e as Error).message}`);
        }
      }
    }

    await this.runTransportWatchdog(states);
  }

  // pymammotion (0.8.8) has three states in which it silently stops all
  // outbound cloud sends: the cloud once flagged the device offline (cleared
  // only by an inbound frame — deadlocks when nothing arrives), the re-login
  // circuit breaker tripped, and the self-imposed send quota. HomeKit then
  // freezes on stale data for hours (live-diagnosed 2026-07-10). The only
  // reliable recovery is a full bridge recycle (fresh login + MQTT session).
  // Escalating backoff keeps a genuinely-offline mower (winter storage) from
  // triggering restart loops that hammer the Mammotion login endpoint.
  private async runTransportWatchdog(states: MammotionState[]): Promise<void> {
    const staleValues = states
      .map(state => state.staleSeconds)
      .filter((value): value is number => typeof value === 'number');
    if (staleValues.length === 0) {
      return; // no inbound frame since bridge start: nothing to compare against
    }

    const minStale = Math.min(...staleValues);
    if (minStale <= this.staleThresholdSeconds) {
      if (this.watchdogRestarts > 0) {
        this.log.info('Mammotion cloud data flowing again — watchdog backoff reset');
      }
      this.watchdogRestarts = 0;
      this.watchdogNextRestartAt = 0;
      return;
    }

    const flags = states
      .map(s => `${s.name}: stale=${Math.round(s.staleSeconds ?? -1)}s offline_flag=${s.mqttReportedOffline ?? '?'} rate_limited=${s.rateLimited ?? '?'} auth_failed=${s.authFailed ?? '?'}`)
      .join('; ');

    const now = Date.now();
    if (this.restartInFlight || now < this.watchdogNextRestartAt) {
      this.log.debug(`Watchdog: transport still stale (${flags}), next restart not before ${new Date(this.watchdogNextRestartAt).toISOString()}`);
      return;
    }

    const backoffMinutes = [15, 60, 360];
    const backoff = backoffMinutes[Math.min(this.watchdogRestarts, backoffMinutes.length - 1)];
    this.watchdogRestarts += 1;
    this.watchdogNextRestartAt = now + backoff * 60_000;
    this.log.warn(
      `No inbound cloud data for ${Math.round(minStale)}s (threshold ${this.staleThresholdSeconds}s) — ` +
      `recycling bridge for a fresh cloud session (attempt ${this.watchdogRestarts}, next retry in ${backoff}min if still stale). [${flags}]`,
    );

    this.restartInFlight = true;
    try {
      await this.client.restart();
      this.log.info('Mammotion bridge restarted by watchdog');
    } catch (e) {
      this.log.error(`Watchdog bridge restart failed: ${(e as Error).message}`);
    } finally {
      this.restartInFlight = false;
    }
  }

  // Plan switches are dynamic: driven by the mower's saved plans (from poll),
  // not device discovery. Re-synced only when the plan set changes, so we don't
  // churn accessory registration every poll.
  private syncPlanSwitches(deviceName: string, displayName: string, plans: MammotionPlan[]): void {
    // An empty list is a transient artifact (plan sync pending, mow running,
    // transport wedged), never a user deleting their plans one poll after
    // starting a mow. Deleting the accessories here destroys HomeKit
    // automations/room assignments, so keep the last known switches instead.
    if (plans.length === 0) {
      return;
    }

    const key = plans.map(p => `${p.id}:${p.name}`).sort().join('|');
    if (this.lastPlanKey.get(deviceName) === key) {
      return;
    }
    this.lastPlanKey.set(deviceName, key);

    const liveUuids = new Set<string>();
    const handlers: MammotionPlanSwitch[] = [];
    for (const plan of plans) {
      const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:${this.uuidNamespace}:${deviceName}:planswitch:${plan.id}`);
      liveUuids.add(uuid);
      const existing = this.accessories.find(item => item.UUID === uuid);
      const name = `${displayName} Run ${plan.name}`;
      const accessory = existing ?? new this.api.platformAccessory<AccessoryContext>(name, uuid);
      accessory.context.deviceName = deviceName;
      accessory.context.kind = 'plan';
      accessory.context.planId = plan.id;
      accessory.context.planName = plan.name;
      accessory.displayName = name;
      handlers.push(new MammotionPlanSwitch(this, accessory, deviceName, displayName, plan.id, plan.name, this.client));
      if (existing) {
        this.api.updatePlatformAccessories([existing]);
      } else {
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.push(accessory);
        this.log.info(`Added plan switch '${plan.name}' for ${deviceName}`);
      }
    }
    this.planHandlers.set(deviceName, handlers);

    const stale = this.accessories.filter(
      item => item.context.kind === 'plan' && item.context.deviceName === deviceName && !liveUuids.has(item.UUID),
    );
    if (stale.length > 0) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
      for (const acc of stale) {
        const index = this.accessories.findIndex(item => item.UUID === acc.UUID);
        if (index >= 0) {
          this.accessories.splice(index, 1);
        }
      }
      this.log.info(`Removed ${stale.length} stale plan switch(es) for ${deviceName}`);
    }
  }

  // Attach working handlers to plan switches restored from the accessory cache
  // at startup. Without this, cached tiles sit dead in HomeKit until the first
  // non-empty plan sync happens to run — which never comes while the plan list
  // is empty (mow running / transport wedged).
  private armCachedPlanSwitches(): void {
    if (this.config.enablePlanSwitches !== true) {
      return;
    }
    for (const accessory of this.accessories) {
      if (accessory.context.kind !== 'plan' || !accessory.context.planId) {
        continue;
      }
      const deviceName = accessory.context.deviceName;
      const info = this.deviceInfo.get(deviceName);
      const displayName = info ? this.displayNameFor(info) : deviceName;
      const planName = accessory.context.planName
        ?? accessory.displayName.replace(`${displayName} Run `, '');
      const handlers = this.planHandlers.get(deviceName) ?? [];
      if (handlers.some(h => h.planIdKey === accessory.context.planId)) {
        continue;
      }
      handlers.push(new MammotionPlanSwitch(
        this, accessory, deviceName, displayName, accessory.context.planId, planName, this.client,
      ));
      this.planHandlers.set(deviceName, handlers);
      this.log.info(`Re-armed cached plan switch '${planName}' for ${deviceName}`);
    }
  }

  // Remove any cached plan switches when the feature is disabled (startup).
  private cleanupDisabledPlanSwitches(): void {
    if (this.config.enablePlanSwitches === true) {
      return;
    }
    const stale = this.accessories.filter(item => item.context.kind === 'plan');
    if (stale.length === 0) {
      return;
    }
    this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
    for (const acc of stale) {
      const index = this.accessories.findIndex(item => item.UUID === acc.UUID);
      if (index >= 0) {
        this.accessories.splice(index, 1);
      }
    }
    this.log.info(`Removed ${stale.length} plan switch(es) (disabled)`);
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

  // Friendly display name for HomeKit tiles. Order: explicit config override,
  // then the API-provided nickName, then the model with the "-<serial>" stripped
  // ("Yuka-MLX9UF6N" -> "Yuka"). The internal key stays device.name so UUIDs and
  // pairing are unaffected.
  private displayNameFor(device: MammotionDeviceInfo): string {
    const override = this.config.deviceNames?.[device.name];
    if (override && override.trim()) {
      return override.trim();
    }
    if (device.nickName && device.nickName.trim()) {
      return device.nickName.trim();
    }
    const stripped = device.name.replace(/-[A-Za-z0-9]{6,}$/, '');
    return stripped || device.name;
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
