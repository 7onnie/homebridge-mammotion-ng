export interface MammotionPlatformConfig {
  platform: string;
  name?: string;
  email: string;
  password: string;
  areaNameFallbacks?: Record<string, string[]>;
  pythonPath?: string;
  pollIntervalSeconds?: number;
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
}
