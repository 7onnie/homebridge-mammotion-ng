export interface MammotionPlatformConfig {
  platform: string;
  name?: string;
  email: string;
  password: string;
  areaNameFallbacks?: Record<string, string[]>;
  pythonPath?: string;
  pollIntervalSeconds?: number;
  deviceFilter?: string[];
  offCommand?: 'pause' | 'dock' | 'cancel';
  enableMatterRvc?: boolean;
}

export interface MammotionDeviceInfo {
  name: string;
  iotId: string;
  model?: string;
  serialNumber?: string;
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
