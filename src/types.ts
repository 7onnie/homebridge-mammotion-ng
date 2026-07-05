export interface MammotionPlatformConfig {
  platform: string;
  name?: string;
  email: string;
  password: string;
  areaNameFallbacks?: Record<string, string[]>;
  pythonPath?: string;
  pollIntervalSeconds?: number;
  // Cloud one-shot poll cadence (seconds) driving pymammotion's mqtt_activity_loop.
  // Lower = faster detection of externally-started mows, but more cloud traffic
  // (rate-limit risk on firmware < 1.30.25.1). Default 120.
  cloudRefreshSeconds?: number;
  deviceFilter?: string[];
  offCommand?: 'pause' | 'dock';
  enableMatterRvc?: boolean;
  // hybrid additions
  enableStateSensors?: boolean;
  sensorDocked?: boolean;
  sensorMowing?: boolean;
  sensorError?: boolean;
  errorIncludesOffline?: boolean;
  sensorDebounceSeconds?: number;
  offlineGracePolls?: number;
  enableAbortSwitch?: boolean;
  // Battery % on the Matter RVC via the Power Source cluster. Default on.
  exposeBattery?: boolean;
  // Blade-service contact sensor (opens when blade wear >= warning threshold).
  sensorBladeWear?: boolean;
  // Mow-progress % as a humidity sensor (shows "%"; Eve gets a native graph).
  sensorProgress?: boolean;
  // Also trip the Problem sensor on bumper/ultrasonic ERROR (obstacle/stuck).
  errorIncludesSensorFaults?: boolean;
  // Eve (fakegato) open/close history on the contact sensors. Default on.
  enableEveHistory?: boolean;
  // Per-plan momentary "Run <plan>" switches (one per saved plan), opt-in.
  enablePlanSwitches?: boolean;
  // Name of the saved plan the RVC ▶ Play button runs when several exist.
  // Falls back to the first plan (name-sorted) when unset or not found.
  defaultPlan?: string;
  // Optional display-name override per device (keyed by the device id, e.g.
  // "Yuka-MLX9UF6N"). Overrides the auto-derived name for the HomeKit tiles.
  deviceNames?: Record<string, string>;
}

export interface MammotionDeviceInfo {
  name: string;
  iotId: string;
  model?: string;
  serialNumber?: string;
  nickName?: string;
}

export interface MammotionServiceArea {
  id: number;
  name: string;
}

export interface MammotionPlan {
  id: string;
  name: string;
}

export interface MammotionState {
  name: string;
  online: boolean;
  battery: number;
  chargeState: number;
  sysStatus: number;
  modeName: string;
  areaProgress: number;
  hasError: boolean;
  serviceAreas: MammotionServiceArea[];
  selectedAreaIds: number[];
  currentAreaId: number | null;
  plans?: MammotionPlan[];
  mowPercent?: number;
  bladeWorn?: boolean;
  sensorFault?: boolean;
}

export interface MammotionBridgeResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

export interface DerivedState {
  online: boolean;
  docked: boolean;
  mowing: boolean;
  error: boolean;
  active: boolean; // mowing || returning
  bladeWorn: boolean;
  mowPercent: number; // 0-100
}
