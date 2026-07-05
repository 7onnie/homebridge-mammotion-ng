declare module 'fakegato-history' {
  import type { API, PlatformAccessory } from 'homebridge';

  interface FakeGatoOptions {
    storage?: 'fs' | 'googleDrive' | 'memory';
    path?: string;
    size?: number;
    disableTimer?: boolean;
    log?: unknown;
  }

  interface FakeGatoEntry {
    time: number;
    status?: number;
    temp?: number;
    humidity?: number;
    pressure?: number;
    power?: number;
    [key: string]: number | undefined;
  }

  class FakeGatoHistoryService {
    constructor(type: string, accessory: PlatformAccessory, options?: FakeGatoOptions);
    addEntry(entry: FakeGatoEntry): void;
  }

  function factory(api: API): typeof FakeGatoHistoryService;
  export = factory;
}
