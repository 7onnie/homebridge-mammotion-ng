# homebridge-mammotion-ng — Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `homebridge-mammotion` into the hybrid fork `homebridge-mammotion-ng`: the Matter RVC and HAP trigger-sensors + an Abort switch coexist in one platform instance.

**Architecture:** Remove the single `usingMatterRvc` either/or gate in `platform.ts`; register the Matter RVC (via `api.matter`) *and* HAP accessories (via `api.registerPlatformAccessories`) from the same instance. A pure `mapState()` derives one state model from each poll; sensors are debounced ContactSensors; the Abort switch fires an augmented `cancel` (cancel_job → return_to_dock) in `bridge.py`.

**Tech Stack:** TypeScript (commonjs, strict), Homebridge 2.x Platform API + `api.matter`, a Python 3.13 / pymammotion 0.8.8 bridge over JSON-RPC/stdio, Vitest for unit tests.

## Global Constraints

- **PLATFORM_NAME stays exactly `"Mammotion"`** (settings.ts + package.json `homebridge.platform`/`pluginAlias`) — the live config binds the child bridge to it; changing it orphans accessories. Only `PLUGIN_NAME` changes.
- **PLUGIN_NAME = `"homebridge-mammotion-ng"`** and must equal `package.json` `name`.
- **Homebridge 2.x required for the Matter feature**; on HB 1.x `getMatterApi()` returns null → graceful HAP-only mode (sensors still work).
- **Preserve the modernization, do not regress:** pinned `pymammotion==0.8.8`, Python **3.13** managed venv, `betterproto2>=0.9,<0.10` (auto-pins 0.9.1), the resilience/crash-safety behavior, the `single_schedule` start fix.
- **Plaintext `email`/`password` in user config are intentional — never remove or warn to remove.**
- **`bridge.py` JSON-RPC contract is unchanged** except the body of `_cancel`. Methods stay `init|list_devices|poll|command|shutdown`; actions stay `start|pause|dock|cancel`.
- **`enableAbortSwitch` defaults `false`** (destructive → opt-in).
- **Before the Abort switch ships:** a `gemini_consensus` review of the augmented `_cancel` AND a guarded live hardware test on the real mower are mandatory (project policy for destructive command paths).
- Every code step ends green: `npm run build` (tsc) passes; `npx vitest run` passes; `python3 -m py_compile src/python/bridge.py` passes for Python changes.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `package.json` | modify | Rename to `homebridge-mammotion-ng`, metadata, vitest devDep, test script, HB2 engine |
| `src/settings.ts` | modify | `PLUGIN_NAME` → `homebridge-mammotion-ng` (PLATFORM_NAME unchanged) |
| `src/types.ts` | modify | Add config fields + `DerivedState` interface |
| `config.schema.json` | modify | Remove the `pythonPath` default (regression), add sensor/switch keys |
| `src/state-mapper.ts` | create | Pure `mapState()` — single source of state truth |
| `src/debouncer.ts` | create | Pure time-based min-dwell debouncer |
| `src/sensor-accessory.ts` | create | Three HAP ContactSensors (Docked/Mowing/Error) |
| `src/abort-switch.ts` | create | Momentary HAP "Abort Mowing" switch |
| `src/matter-accessory.ts` | modify | Consume the shared derived error |
| `src/mammotion-client.ts` | modify | Per-request timeout |
| `src/platform.ts` | modify | Capability flags + dual registration + fan-out |
| `src/python/bridge.py` | modify | `single_schedule` start fix (clean) + augmented `_cancel` |
| `README.md` | modify | Fork notes, attribution, divergences |

CI (`.github/workflows/release.yml`) and the release-day migration are a separate follow-up plan (`2026-06-28-hybrid-fork-ci-plan.md`), since they're devops, not plugin code.

---

## Task 1: Foundation — rename + test runner

**Files:**
- Modify: `package.json`
- Modify: `src/settings.ts:2`

**Interfaces:**
- Produces: `PLUGIN_NAME = "homebridge-mammotion-ng"`, `PLATFORM_NAME = "Mammotion"`; a working `npx vitest run`.

- [ ] **Step 1: Rename + metadata + test wiring in `package.json`**

Change these fields (leave `postinstall`, `build`, `copy:bridge`, `files`, `peerDependencies` intact):

```jsonc
{
  "displayName": "Homebridge Mammotion NG",
  "name": "homebridge-mammotion-ng",
  "version": "0.2.0",
  "description": "Hybrid Homebridge plugin for Mammotion mowers (Luba, Yuka): Matter RVC + HomeKit trigger sensors + Abort switch, via PyMammotion",
  // scripts: replace the test line
  "scripts": {
    "postinstall": "node ./scripts/bootstrap-python.js",
    "build": "rimraf dist && tsc && npm run copy:bridge",
    "copy:bridge": "mkdir -p dist/python && cp src/python/bridge.py dist/python/bridge.py",
    "watch": "tsc -w",
    "lint": "eslint src --ext .ts",
    "test": "vitest run",
    "prepare": "npm run build",
    "prepublishOnly": "npm run build && vitest run"
  },
  "engines": { "homebridge": ">=2.0.0", "node": ">=20.0.0" },
  "keywords": ["homebridge-plugin","mammotion","luba","yuka","matter","rvc","lawn-mower"],
  "author": "Tom Willmot <tom@willmot.co.uk>",
  "contributors": ["7onnie"],
  "license": "MIT",
  "repository": { "type": "git", "url": "git+https://github.com/7onnie/homebridge-mammotion-ng.git" },
  "bugs": { "url": "https://github.com/7onnie/homebridge-mammotion-ng/issues" },
  "homepage": "https://github.com/7onnie/homebridge-mammotion-ng#readme",
  "homebridge": { "pluginAlias": "Mammotion", "platform": "Mammotion" }
}
```

`homebridge.pluginAlias`/`platform` stay `"Mammotion"` (Global Constraint). `peerDependencies` keep `^1.8.0 || ^2.0.0-beta.75` so install doesn't hard-fail on HB1; the HB2 engine is advisory + the runtime degrades gracefully.

- [ ] **Step 2: Add vitest devDep**

Run: `npm install -D vitest@^2`
Expected: `vitest` appears in `devDependencies`, `package-lock.json` updated.

- [ ] **Step 3: Update `src/settings.ts`**

```typescript
export const PLATFORM_NAME = 'Mammotion';
export const PLUGIN_NAME = 'homebridge-mammotion-ng';
```

- [ ] **Step 4: Verify build + empty test run**

Run: `npm run build && npx vitest run`
Expected: tsc succeeds; vitest reports "No test files found" (exit 0) — acceptable at this step.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json src/settings.ts
git commit -m "chore: fork to homebridge-mammotion-ng + add vitest"
```

---

## Task 2: Config surface — types + schema

**Files:**
- Modify: `src/types.ts:1-12`
- Modify: `config.schema.json`

**Interfaces:**
- Produces: `MammotionPlatformConfig` extended with `enableStateSensors?, sensorDocked?, sensorMowing?, sensorError?, errorIncludesOffline?, sensorDebounceSeconds?, enableAbortSwitch?, offlineGracePolls?`; new `DerivedState` interface (consumed by Tasks 3,5,6,7).

- [ ] **Step 1: Extend `MammotionPlatformConfig` and add `DerivedState` in `src/types.ts`**

Add the new optional fields to `MammotionPlatformConfig` (after `enableMatterRvc?`):

```typescript
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
  // hybrid additions
  enableStateSensors?: boolean;
  sensorDocked?: boolean;
  sensorMowing?: boolean;
  sensorError?: boolean;
  errorIncludesOffline?: boolean;
  sensorDebounceSeconds?: number;
  offlineGracePolls?: number;
  enableAbortSwitch?: boolean;
}
```

Append the derived-state interface at the end of the file:

```typescript
export interface DerivedState {
  online: boolean;
  docked: boolean;
  mowing: boolean;
  error: boolean;
  active: boolean; // mowing || returning
}
```

- [ ] **Step 2: Update `config.schema.json`**

Two changes. (a) **Remove the `pythonPath` `"default": "python3"`** (it caused the Python-3.11 regression on the box — the HB-UI re-injects the default and overrides the managed 3.13 venv). The property stays but with no default:

```jsonc
"pythonPath": {
  "title": "Python path",
  "type": "string",
  "description": "Optional. Leave EMPTY to use the managed Python 3.13 venv. Only set this to override with your own interpreter."
}
```

(b) Add the hybrid keys inside `schema.properties` (after `deviceFilter`):

```jsonc
"enableStateSensors": {
  "title": "Expose HomeKit state sensors (for automations)",
  "type": "boolean", "default": true,
  "description": "Adds Docked / Mowing / Problem contact sensors you can trigger automations on (Apple Home cannot trigger on the Matter vacuum's state directly)."
},
"sensorDocked":  { "title": "  • Docked / finished sensor", "type": "boolean", "default": true,
  "condition": { "functionBody": "return model.enableStateSensors !== false;" } },
"sensorMowing":  { "title": "  • Mowing / active sensor", "type": "boolean", "default": true,
  "condition": { "functionBody": "return model.enableStateSensors !== false;" } },
"sensorError":   { "title": "  • Problem / stuck sensor", "type": "boolean", "default": true,
  "condition": { "functionBody": "return model.enableStateSensors !== false;" } },
"errorIncludesOffline": { "title": "Treat 'offline' as a problem", "type": "boolean", "default": true,
  "condition": { "functionBody": "return model.sensorError !== false;" } },
"sensorDebounceSeconds": {
  "title": "Sensor debounce (seconds)", "type": "integer", "default": 30, "minimum": 0, "maximum": 300,
  "description": "Minimum time a state must hold before a sensor flips. 0 disables. Problems are reported immediately."
},
"enableAbortSwitch": {
  "title": "Expose momentary 'Abort Mowing' switch", "type": "boolean", "default": false,
  "description": "ENDS the current job and returns the mower to its dock. Auto-resets. Off by default (destructive)."
}
```

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: tsc succeeds (config.schema.json is not compiled, but a JSON typo would break HB-UI; validate with `node -e "JSON.parse(require('fs').readFileSync('config.schema.json','utf8'))"` → no output = valid).

- [ ] **Step 4: Commit**

```bash
git add src/types.ts config.schema.json
git commit -m "feat: config surface for hybrid sensors + abort switch; drop pythonPath default"
```

---

## Task 3: `state-mapper.ts` (pure, TDD)

**Files:**
- Create: `src/state-mapper.ts`
- Test: `src/state-mapper.test.ts`

**Interfaces:**
- Consumes: `MammotionState`, `DerivedState` (Task 2).
- Produces: `mapState(state: MammotionState, opts: { offlineConfirmed: boolean; errorIncludesOffline: boolean }): DerivedState`; exported mode constants.

- [ ] **Step 1: Write the failing test** — `src/state-mapper.test.ts`

```typescript
import { describe, it, expect } from 'vitest';
import { mapState } from './state-mapper';
import type { MammotionState } from './types';

const base: MammotionState = {
  name: 'Yuka', online: true, battery: 80, chargeState: 0, sysStatus: 0,
  modeName: 'unknown', areaProgress: 0, hasError: false,
  serviceAreas: [], selectedAreaIds: [], currentAreaId: null,
};
const opt = { offlineConfirmed: false, errorIncludesOffline: true };

describe('mapState', () => {
  it('mowing when sysStatus=13', () => {
    const d = mapState({ ...base, sysStatus: 13 }, opt);
    expect(d).toMatchObject({ mowing: true, docked: false, error: false, active: true });
  });
  it('docked when charging on dock', () => {
    const d = mapState({ ...base, chargeState: 1, sysStatus: 15 }, opt);
    expect(d).toMatchObject({ docked: true, mowing: false, error: false });
  });
  it('MODE_CHARGING_PAUSE(39) is NOT docked/finished', () => {
    const d = mapState({ ...base, chargeState: 1, sysStatus: 39 }, opt);
    expect(d.docked).toBe(false);
  });
  it('error from MODE_LOCK(17) and takes precedence over docked', () => {
    const d = mapState({ ...base, chargeState: 1, sysStatus: 17 }, opt);
    expect(d).toMatchObject({ error: true, docked: false, mowing: false });
  });
  it('error from hasError flag', () => {
    expect(mapState({ ...base, hasError: true }, opt).error).toBe(true);
  });
  it('offlineConfirmed raises error only when errorIncludesOffline', () => {
    expect(mapState({ ...base, online: false }, { offlineConfirmed: true, errorIncludesOffline: true }).error).toBe(true);
    expect(mapState({ ...base, online: false }, { offlineConfirmed: true, errorIncludesOffline: false }).error).toBe(false);
  });
  it('all flags false in idle/transitional', () => {
    const d = mapState({ ...base, sysStatus: 0 }, opt);
    expect(d).toMatchObject({ docked: false, mowing: false, error: false });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/state-mapper.test.ts`
Expected: FAIL — "Cannot find module './state-mapper'".

- [ ] **Step 3: Write `src/state-mapper.ts`**

```typescript
import type { DerivedState, MammotionState } from './types';

// pymammotion device_mode integers (verify against the installed
// pymammotion/utility/constant/device_constant.py before relying on these).
export const MODE_WORKING = 13;
export const MODE_RETURNING = 14;
export const MODE_CHARGING = 15;
export const MODE_LOCK = 17;
export const MODE_PAUSE = 19;
export const MODE_OTA_UPGRADE_FAIL = 23;
export const MODE_LOCATION_ERROR = 37;
export const MODE_CHARGING_PAUSE = 39;

const ERROR_MODES = new Set<number>([MODE_LOCK, MODE_OTA_UPGRADE_FAIL, MODE_LOCATION_ERROR]);

export function mapState(
  state: MammotionState,
  opts: { offlineConfirmed: boolean; errorIncludesOffline: boolean },
): DerivedState {
  const online = Boolean(state.online);
  const sys = Number(state.sysStatus ?? 0);
  const charge = Number(state.chargeState ?? 0);

  const returning = sys === MODE_RETURNING;
  const mowing = online && sys === MODE_WORKING;

  const error =
    Boolean(state.hasError) ||
    ERROR_MODES.has(sys) ||
    (opts.errorIncludesOffline && opts.offlineConfirmed);

  // Precedence: ERROR > DOCKED > MOWING. Charging-pause(39) is mid-job, not docked.
  const docked =
    online && !error && !mowing && !returning &&
    (charge !== 0 || sys === MODE_CHARGING) && sys !== MODE_CHARGING_PAUSE;

  return {
    online,
    error,
    docked: error ? false : docked,
    mowing: error ? false : mowing,
    active: mowing || returning,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/state-mapper.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/state-mapper.ts src/state-mapper.test.ts
git commit -m "feat: pure mapState() — single source of derived mower state"
```

---

## Task 4: `debouncer.ts` (pure, TDD)

**Files:**
- Create: `src/debouncer.ts`
- Test: `src/debouncer.test.ts`

**Interfaces:**
- Produces: `class Debouncer { push(key: string, value: boolean, dwellMs: number, now: number): boolean }`.

- [ ] **Step 1: Write the failing test** — `src/debouncer.test.ts`

```typescript
import { describe, it, expect } from 'vitest';
import { Debouncer } from './debouncer';

describe('Debouncer', () => {
  it('commits the first observed value immediately', () => {
    const d = new Debouncer();
    expect(d.push('k', true, 1000, 0)).toBe(true);
  });
  it('holds a change until the dwell elapses', () => {
    const d = new Debouncer();
    d.push('k', true, 1000, 0);          // committed true
    expect(d.push('k', false, 1000, 500)).toBe(true);  // pending, dwell not met
    expect(d.push('k', false, 1000, 1000)).toBe(false); // dwell met -> commit false
  });
  it('cancels a pending change if value reverts', () => {
    const d = new Debouncer();
    d.push('k', true, 1000, 0);
    d.push('k', false, 1000, 500);       // pending false
    expect(d.push('k', true, 1000, 700)).toBe(true);   // back to committed -> clear pending
    expect(d.push('k', false, 1000, 800)).toBe(true);  // dwell restarts; not yet
  });
  it('dwell 0 commits instantly (immediate error rise)', () => {
    const d = new Debouncer();
    d.push('e', false, 1000, 0);
    expect(d.push('e', true, 0, 100)).toBe(true);
  });
  it('keys are independent', () => {
    const d = new Debouncer();
    d.push('a', true, 1000, 0);
    d.push('b', false, 1000, 0);
    expect(d.push('a', true, 1000, 10)).toBe(true);
    expect(d.push('b', false, 1000, 10)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/debouncer.test.ts`
Expected: FAIL — "Cannot find module './debouncer'".

- [ ] **Step 3: Write `src/debouncer.ts`**

```typescript
interface Entry {
  committed: boolean;
  pending: boolean | null;
  pendingSince: number;
}

export class Debouncer {
  private readonly entries = new Map<string, Entry>();

  /** Returns the committed value after applying this observation. */
  push(key: string, value: boolean, dwellMs: number, now: number): boolean {
    const e = this.entries.get(key);
    if (e === undefined) {
      this.entries.set(key, { committed: value, pending: null, pendingSince: now });
      return value;
    }
    if (value === e.committed) {
      e.pending = null; // observation matches committed -> cancel any pending change
      return e.committed;
    }
    // value differs from committed
    if (e.pending !== value) {
      e.pending = value;
      e.pendingSince = now;
    }
    if (now - e.pendingSince >= dwellMs) {
      e.committed = value;
      e.pending = null;
      return value;
    }
    return e.committed;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/debouncer.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/debouncer.ts src/debouncer.test.ts
git commit -m "feat: time-based min-dwell Debouncer for sensor flap suppression"
```

---

## Task 5: `sensor-accessory.ts` — three ContactSensors

**Files:**
- Create: `src/sensor-accessory.ts`
- Test: `src/sensor-accessory.test.ts`

**Interfaces:**
- Consumes: `DerivedState` (Task 2), `Debouncer` (Task 4), `MammotionPlatform` (for `Service`/`Characteristic`), `PlatformAccessory`.
- Produces: `class MammotionSensorAccessory { constructor(platform, accessory, deviceName); updateState(derived: DerivedState, now: number): void }` and the pure helper `sensorContactValues(derived, deb, cfg, now): { docked: number; mowing: number; error: number }`.

Design note: the value logic is a **pure exported function** (`sensorContactValues`) so it's unit-testable without a HAP mock; the class is a thin wrapper that pushes those values onto `ContactSensorState`/`StatusActive`/`StatusFault`.

- [ ] **Step 1: Write the failing test** — `src/sensor-accessory.test.ts`

```typescript
import { describe, it, expect } from 'vitest';
import { Debouncer } from './debouncer';
import { sensorContactValues, CONTACT_DETECTED, CONTACT_NOT_DETECTED } from './sensor-accessory';
import type { DerivedState } from './types';

const cfg = { debounceMs: 1000, key: 'Yuka' };
const D = (o: Partial<DerivedState>): DerivedState =>
  ({ online: true, docked: false, mowing: false, error: false, active: false, ...o });

describe('sensorContactValues', () => {
  it('maps true flags to CONTACT_DETECTED after first observation', () => {
    const deb = new Debouncer();
    const v = sensorContactValues(D({ mowing: true }), deb, cfg, 0);
    expect(v.mowing).toBe(CONTACT_DETECTED);
    expect(v.docked).toBe(CONTACT_NOT_DETECTED);
  });
  it('error rises immediately (dwell 0) even with a large debounce', () => {
    const deb = new Debouncer();
    sensorContactValues(D({ error: false }), deb, cfg, 0);
    const v = sensorContactValues(D({ error: true }), deb, cfg, 1); // 1ms later
    expect(v.error).toBe(CONTACT_DETECTED);
  });
  it('error fall is sticky (does not clear before debounce)', () => {
    const deb = new Debouncer();
    sensorContactValues(D({ error: true }), deb, cfg, 0);
    const v = sensorContactValues(D({ error: false }), deb, cfg, 500); // < debounce
    expect(v.error).toBe(CONTACT_DETECTED); // still latched
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/sensor-accessory.test.ts`
Expected: FAIL — "Cannot find module './sensor-accessory'".

- [ ] **Step 3: Write `src/sensor-accessory.ts`**

```typescript
import type { PlatformAccessory, Service } from 'homebridge';
import type { Debouncer } from './debouncer';
import type { MammotionPlatform } from './platform';
import type { DerivedState } from './types';

export const CONTACT_DETECTED = 1;      // HAP ContactSensorState.CONTACT_DETECTED
export const CONTACT_NOT_DETECTED = 0;  // HAP ContactSensorState.CONTACT_NOT_DETECTED

export interface SensorCfg { debounceMs: number; key: string }

/** Pure: derive the three contact-sensor values, applying debounce + sticky error. */
export function sensorContactValues(
  d: DerivedState,
  deb: Debouncer,
  cfg: SensorCfg,
  now: number,
): { docked: number; mowing: number; error: number } {
  const docked = deb.push(`${cfg.key}:docked`, d.docked, cfg.debounceMs, now);
  const mowing = deb.push(`${cfg.key}:mowing`, d.mowing, cfg.debounceMs, now);
  // error rises immediately (dwell 0), falls sticky (full debounce)
  const errDwell = d.error ? 0 : cfg.debounceMs;
  const error = deb.push(`${cfg.key}:error`, d.error, errDwell, now);
  return {
    docked: docked ? CONTACT_DETECTED : CONTACT_NOT_DETECTED,
    mowing: mowing ? CONTACT_DETECTED : CONTACT_NOT_DETECTED,
    error: error ? CONTACT_DETECTED : CONTACT_NOT_DETECTED,
  };
}

type Ctx = { deviceName: string };

export class MammotionSensorAccessory {
  private readonly docked?: Service;
  private readonly mowing?: Service;
  private readonly error?: Service;

  constructor(
    private readonly platform: MammotionPlatform,
    accessory: PlatformAccessory<Ctx>,
    private readonly deviceName: string,
    private readonly deb: Debouncer,
    private readonly debounceMs: number,
    enable: { docked: boolean; mowing: boolean; error: boolean },
  ) {
    accessory.context.deviceName = deviceName;
    const C = this.platform.Characteristic;
    const S = this.platform.Service;

    const info = accessory.getService(S.AccessoryInformation) ?? accessory.addService(S.AccessoryInformation);
    info.setCharacteristic(C.Manufacturer, 'Mammotion').setCharacteristic(C.Model, 'Mower Sensors')
      .setCharacteristic(C.SerialNumber, `${deviceName}-sensors`);

    const mk = (subtype: string, name: string): Service =>
      accessory.getServiceById(S.ContactSensor, subtype)
        ?? accessory.addService(S.ContactSensor, name, subtype);

    if (enable.docked) { this.docked = mk('docked', `${deviceName} Docked`); }
    if (enable.mowing) { this.mowing = mk('mowing', `${deviceName} Mowing`); }
    if (enable.error)  { this.error  = mk('error',  `${deviceName} Problem`); }
  }

  get deviceNameKey(): string { return this.deviceName; }

  updateState(d: DerivedState, now: number): void {
    const C = this.platform.Characteristic;
    const v = sensorContactValues(d, this.deb, { debounceMs: this.debounceMs, key: this.deviceName }, now);
    const apply = (svc: Service | undefined, contact: number) => {
      if (!svc) { return; }
      svc.updateCharacteristic(C.ContactSensorState, contact);
      svc.updateCharacteristic(C.StatusActive, d.online);
      svc.updateCharacteristic(
        C.StatusFault,
        d.error ? C.StatusFault.GENERAL_FAULT : C.StatusFault.NO_FAULT,
      );
    };
    apply(this.docked, v.docked);
    apply(this.mowing, v.mowing);
    apply(this.error, v.error);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/sensor-accessory.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Build + commit**

Run: `npm run build` (Expected: tsc PASS)

```bash
git add src/sensor-accessory.ts src/sensor-accessory.test.ts
git commit -m "feat: MammotionSensorAccessory (Docked/Mowing/Problem contact sensors)"
```

---

## Task 6: `matter-accessory.ts` — consume shared derived error

**Files:**
- Modify: `src/matter-accessory.ts:136-173`

**Interfaces:**
- Consumes: `DerivedState` (Task 2).
- Produces: `MammotionMatterVacuum.updateState(nextState: MammotionState, derived: DerivedState): Promise<void>` (signature gains a 2nd param).

- [ ] **Step 1: Add the `DerivedState` import**

At the top of `src/matter-accessory.ts`, extend the types import:

```typescript
import type { DerivedState, MammotionDeviceInfo, MammotionState } from './types';
```

- [ ] **Step 2: Change `updateState` to accept and use `derived`**

Replace `updateState` (currently lines 136-149) with:

```typescript
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
  }
```

- [ ] **Step 3: Make `toOperationalState` honor the shared error first**

Replace the start of `toOperationalState` (currently line 151-152) so the shared derived error wins:

```typescript
  private toOperationalState(state: MammotionState, derived: DerivedState): number {
    if (derived.error) {
      return 3; // Error
    }
    if (!state.online) {
      return 3;
    }
    // ... keep the existing isWorking/isPaused/isReturning/chargeState branches unchanged ...
```

(Leave the remaining branches of `toOperationalState` exactly as they are.)

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: FAIL — `platform.ts` still calls `updateState(state)` with one arg. That is fixed in Task 8; this is expected mid-refactor. Proceed.

- [ ] **Step 5: Commit**

```bash
git add src/matter-accessory.ts
git commit -m "feat: Matter RVC consumes shared derived error (one source of truth)"
```

---

## Task 7: `mammotion-client.ts` — per-request timeout

**Files:**
- Modify: `src/mammotion-client.ts:113-130`

**Interfaces:**
- Produces: `request()` rejects after a per-method timeout; `command()` unchanged signature.

- [ ] **Step 1: Add a timeout map field**

In the class fields block (near `private pending = new Map<number, Pending>();`), add:

```typescript
  private timeouts = new Map<number, NodeJS.Timeout>();
```

- [ ] **Step 2: Arm + clear the timeout in `request()`**

Replace `request()` (lines 113-130) with:

```typescript
  private async request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    if (!this.process) {
      throw new Error('Bridge is not running');
    }

    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    const timeoutMs = ({ init: 120000, command: 60000, poll: 30000, shutdown: 5000 } as Record<string, number>)[method] ?? 30000;

    const responsePromise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value: unknown) => resolve(value as T),
        reject,
      });
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          this.timeouts.delete(id);
          reject(new Error(`Bridge request '${method}' timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
      timer.unref?.();
      this.timeouts.set(id, timer);
    });

    this.process.stdin.write(`${payload}\n`);
    return responsePromise;
  }
```

- [ ] **Step 3: Clear the timer wherever a request settles**

In `handleStdout`, immediately after `this.pending.delete(message.id);` add:

```typescript
      const timer = this.timeouts.get(message.id);
      if (timer) { clearTimeout(timer); this.timeouts.delete(message.id); }
```

And in the `'exit'` handler, after `this.pending.clear();` add:

```typescript
      for (const t of this.timeouts.values()) { clearTimeout(t); }
      this.timeouts.clear();
```

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: same `platform.ts` arity error from Task 6 (fixed in Task 8). The client file itself must produce no new tsc errors.

- [ ] **Step 5: Commit**

```bash
git add src/mammotion-client.ts
git commit -m "feat: per-request timeout so a stalled bridge can't hang commands/polls"
```

---

## Task 8: `platform.ts` — capability flags + dual registration + fan-out

**Files:**
- Modify: `src/platform.ts`

**Interfaces:**
- Consumes: `mapState` (T3), `Debouncer` (T4), `MammotionSensorAccessory` (T5), updated `MammotionMatterVacuum.updateState` (T6), `MammotionAbortSwitch` (T10 — guarded behind config; import added now, file created in T10).
- Produces: a platform that registers Matter RVC and HAP sensors together and fans poll state to all handlers.

> NOTE: This task imports `MammotionAbortSwitch` only inside the `enableAbortSwitch` guard added in Task 10. Until Task 10 creates that file, leave the abort wiring commented with `// T10:` markers (shown below) so this task builds standalone.

- [ ] **Step 1: Update imports + fields**

Add imports:

```typescript
import { Debouncer } from './debouncer';
import { MammotionSensorAccessory } from './sensor-accessory';
import { mapState } from './state-mapper';
import type { DerivedState } from './types';
```

Replace the `usingMatterRvc` field (line 36) and add new fields:

```typescript
  private readonly matterEnabled: boolean;
  private readonly sensorHandlers = new Map<string, MammotionSensorAccessory>();
  private readonly debouncer = new Debouncer();
  private readonly offlineCounts = new Map<string, number>();
```

In the constructor, replace `this.usingMatterRvc = this.shouldUseMatterRvc();` with:

```typescript
    this.matterEnabled = this.shouldUseMatterRvc();
```

- [ ] **Step 2: Make `startup()` additive**

Replace the body inside the `try` of `startup()` (lines 83-98) with:

```typescript
      await this.client.start();
      if (this.matterEnabled) {
        await this.discoverAndSyncMatterAccessories();
      } else {
        await this.discoverAndSyncAccessories(); // legacy HAP switch fallback
      }
      if (this.config.enableStateSensors !== false) {
        await this.discoverAndSyncSensors();
      }
      await this.pollOnce();

      this.pollTimer = setInterval(() => {
        void this.pollOnce().catch((error: Error) => {
          this.log.warn(`Polling failed: ${error.message}`);
        });
      }, this.pollingSeconds * 1000);

      this.log.info(`Mammotion polling every ${this.pollingSeconds}s`);
```

- [ ] **Step 3: Add `discoverAndSyncSensors()`**

Add this method (after `discoverAndSyncMatterAccessories`):

```typescript
  private async discoverAndSyncSensors(): Promise<void> {
    const devices = this.filterDevices(await this.client.discoverDevices());
    const enable = {
      docked: this.config.sensorDocked !== false,
      mowing: this.config.sensorMowing !== false,
      error: this.config.sensorError !== false,
    };
    const debounceMs = Math.max(0, (this.config.sensorDebounceSeconds ?? 30) * 1000);

    for (const device of devices) {
      const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:${this.uuidNamespace}:${device.name}:sensors`);
      const existing = this.accessories.find(item => item.UUID === uuid);
      const accessory = existing ?? new this.api.platformAccessory<AccessoryContext>(`${device.name} Sensors`, uuid);
      const handler = new MammotionSensorAccessory(this, accessory, device.name, this.debouncer, debounceMs, enable);
      this.sensorHandlers.set(device.name, handler);
      if (existing) {
        this.api.updatePlatformAccessories([existing]);
      } else {
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.push(accessory);
        this.log.info(`Added state sensors for ${device.name}`);
      }
    }
  }
```

- [ ] **Step 4: Rewrite `pollOnce()` to fan out with isolation**

Replace `pollOnce()` (lines 201-219) with:

```typescript
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

      const derived: DerivedState = mapState(state, { offlineConfirmed, errorIncludesOffline });

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
        try { sensors.updateState(derived, now); } catch (e) { this.log.debug(`Sensor update failed: ${(e as Error).message}`); }
      }
    }
  }
```

- [ ] **Step 5: Build + lint**

Run: `npm run build && npm run lint`
Expected: tsc PASS (the Task 6 arity error is now resolved by the new `pollOnce`). Lint clean.

- [ ] **Step 6: Commit**

```bash
git add src/platform.ts
git commit -m "feat: Matter RVC + HAP sensors coexist; single mapState fan-out with per-handler isolation"
```

---

## Task 9: `bridge.py` — clean single_schedule start fix + augmented `_cancel`

**Files:**
- Modify: `src/python/bridge.py`

**Interfaces:**
- Produces: `_start` uses `single_schedule(plan_id)` for idle/docked/returning; `_resolve_plan_id`; `_cancel` does `cancel_job` → guarded `return_to_dock`.

> The deployed box version carries debug `_cmdlog` instrumentation — this task writes the CLEAN fork version (no `_cmdlog`).

- [ ] **Step 1: Add `_resolve_plan_id` helper** (after `_handle_by_name`)

```python
    @staticmethod
    def _resolve_plan_id(state, prefer_name=None):
        """state.map.plan is dict[plan_id -> Plan]. Return (plan_id, label) for
        the named plan, else the first; (None, None) if none stored."""
        plans = dict(getattr(getattr(state, "map", None), "plan", {}) or {})
        if not plans:
            return (None, None)
        items = list(plans.items())
        if prefer_name:
            for pid, plan in items:
                tn = str(getattr(plan, "task_name", "")).strip()
                jn = str(getattr(plan, "job_name", "")).strip()
                if prefer_name in (tn, jn):
                    return (str(getattr(plan, "plan_id", "") or pid), tn or jn)
        pid, plan = items[0]
        label = str(getattr(plan, "task_name", "")).strip() or str(getattr(plan, "job_name", "")).strip()
        return (str(getattr(plan, "plan_id", "") or pid), label)
```

- [ ] **Step 2: Replace `_start`** (the saved-plan fix, no instrumentation)

```python
    async def _start(self, name: str, mode: int | None) -> None:
        if mode == WorkMode.MODE_WORKING:
            return
        if mode == WorkMode.MODE_PAUSE:
            await self._send_command(name, "resume_execute_task")
            return
        # Idle / docked / returning: a bare start_job is a no-op (no task loaded).
        # Execute the saved plan via single_schedule, like the official app.
        if mode == WorkMode.MODE_RETURNING:
            await self._send_command(name, "cancel_return_to_dock")
        plan_state = self._raw_state(self._handle_by_name(name))
        plan_id, _label = self._resolve_plan_id(plan_state)
        if plan_id:
            await self._send_command(name, "single_schedule", plan_id=plan_id)
            return
        # Fallback when no stored plan exists.
        await self._send_command(name, "query_generate_route_information")
        await self._send_command(name, "start_job")
```

- [ ] **Step 3: Replace `_cancel`** (end task AND return to dock, guarded)

```python
    async def _cancel(self, name: str, mode: int | None) -> dict:
        partial = {"cancelled": False, "docked": False, "dock_error": None}
        if mode == WorkMode.MODE_WORKING:
            await self._send_command(name, "pause_execute_task")
            await self._request_iot_sync(name)
        await self._send_command(name, "cancel_job")
        partial["cancelled"] = True
        # Re-read fresh state AFTER cancel to decide whether to send the mower home.
        await self._request_iot_sync(name)
        dev = self._raw_state(self._handle_by_name(name)).report_data.dev
        if int(getattr(dev, "charge_state", 0) or 0) == 0 and dev.sys_status != WorkMode.MODE_RETURNING:
            try:
                await self._send_command(name, "return_to_dock")
                partial["docked"] = True
            except Exception as ex:  # mower stopped but dock failed -> report, don't raise
                partial["dock_error"] = repr(ex)
        return partial
```

(`_cancel` now returns a dict; the `_command` dispatcher ignores the return — it re-reads state via `_to_state` afterward — so no caller change is required.)

- [ ] **Step 4: Syntax check**

Run: `python3 -m py_compile src/python/bridge.py`
Expected: no output (success).

- [ ] **Step 5: Deploy to the box + restart the Mammotion child bridge**

```bash
sshpass -p toor scp src/python/bridge.py root@10.0.0.12:/var/lib/homebridge/node_modules/homebridge-mammotion/dist/python/bridge.py
sshpass -p toor ssh root@10.0.0.12 "pkill -f 'homebridge: homebridge-mammotion'"
```
Wait ~15s; confirm via `tail` that the child bridge restarted with no Python traceback.

- [ ] **Step 6: GATE — `gemini_consensus` review of the augmented `_cancel`**

Per project policy, run `gemini_consensus` on the cancel→return_to_dock sequence (race conditions, charge_state guard, partial-failure handling) BEFORE the live test. Address consensus points.

- [ ] **Step 7: GATE — guarded live hardware test**

With the mower in view and safe: start a mow, then trigger `cancel` (via the legacy switch's off=cancel, or a temporary manual JSON-RPC `command` with `action:"cancel"`). Confirm the mower stops the job AND returns to the dock. Verify `_start` still works (single_schedule).

- [ ] **Step 8: Commit**

```bash
git add src/python/bridge.py
git commit -m "feat: bridge starts saved plan via single_schedule; abort = cancel_job + guarded return_to_dock"
```

---

## Task 10: `abort-switch.ts` — momentary Abort switch + wiring

**Files:**
- Create: `src/abort-switch.ts`
- Modify: `src/platform.ts` (register + import behind `enableAbortSwitch`)

**Interfaces:**
- Consumes: `MammotionClient.command`, `MammotionPlatform`.
- Produces: `class MammotionAbortSwitch { constructor(platform, accessory, deviceName, client) }`.

- [ ] **Step 1: Write `src/abort-switch.ts`**

```typescript
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
    private readonly client: MammotionClient,
  ) {
    accessory.context.deviceName = deviceName;
    const C = this.platform.Characteristic;
    const S = this.platform.Service;
    const info = accessory.getService(S.AccessoryInformation) ?? accessory.addService(S.AccessoryInformation);
    info.setCharacteristic(C.Manufacturer, 'Mammotion').setCharacteristic(C.Model, 'Abort')
      .setCharacteristic(C.SerialNumber, `${deviceName}-abort`);

    this.service = accessory.getService(S.Switch) ?? accessory.addService(S.Switch, `${deviceName} Abort Mowing`);
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
```

- [ ] **Step 2: Wire into `platform.ts`** — add the import and a registration method

Add import: `import { MammotionAbortSwitch } from './abort-switch';` and field:
`private readonly abortHandlers = new Map<string, MammotionAbortSwitch>();`

In `startup()` after the sensors block:

```typescript
      if (this.config.enableAbortSwitch === true) {
        await this.discoverAndSyncAbortSwitch();
      }
```

Add the method:

```typescript
  private async discoverAndSyncAbortSwitch(): Promise<void> {
    const devices = this.filterDevices(await this.client.discoverDevices());
    for (const device of devices) {
      const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:${this.uuidNamespace}:${device.name}:switch:abort`);
      const existing = this.accessories.find(item => item.UUID === uuid);
      const accessory = existing ?? new this.api.platformAccessory<AccessoryContext>(`${device.name} Abort`, uuid);
      const handler = new MammotionAbortSwitch(this, accessory, device.name, this.client);
      this.abortHandlers.set(device.name, handler);
      if (existing) {
        this.api.updatePlatformAccessories([existing]);
      } else {
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.push(accessory);
        this.log.info(`Added Abort switch for ${device.name}`);
      }
    }
  }
```

(The abort switch is input-only — it is intentionally NOT added to `pollOnce`.)

- [ ] **Step 3: Build + lint**

Run: `npm run build && npm run lint`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/abort-switch.ts src/platform.ts
git commit -m "feat: momentary Abort Mowing switch (opt-in) wired to cancel action"
```

---

## Task 11: README + attribution

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Rewrite the README header + add a Fork + Credits section**

Include: the new name, the hybrid feature list (Matter RVC + Docked/Mowing/Problem sensors + Abort switch), the HB2 requirement, the "platform stays Mammotion" note, a credits block to upstream `willmot/homebridge-mammotion` + pymammotion (mikey0000), MIT, and the divergences list. (Prose — no code.)

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: fork README, feature list, upstream attribution"
```

---

## Self-Review

**Spec coverage:** §2 architecture → T8; §3 components → T3/T4/T5/T10; §4 mapper → T3; §5 sensors → T5; §6 abort+bridge → T9/T10; §7 state-flow → T8 `pollOnce`; §8 error/offline → T8 (grace counter) + T7 (timeout); §9 config → T2; §10 packaging → T1 (+ README T11); §12 testing → T3/T4/T5 unit + T9 live. §11 CI/migration → deferred to the CI plan (noted). ✅

**Placeholder scan:** No TBD/TODO. The README task is prose-only by nature (acceptable — no code). The `device_mode` ints carry an explicit verify-against-source instruction (T3 comment), not a placeholder.

**Type consistency:** `mapState(state, {offlineConfirmed, errorIncludesOffline})` defined T3, called T8 identically. `DerivedState` defined T2, used T3/T5/T6/T8. `Debouncer.push(key,value,dwellMs,now)` defined T4, used T5. `MammotionMatterVacuum.updateState(state, derived)` changed T6, called with both args T8. `MammotionSensorAccessory(platform, accessory, deviceName, deb, debounceMs, enable)` defined T5, constructed T8 with matching args. `MammotionAbortSwitch(platform, accessory, deviceName, client)` defined T10, constructed T10. ✅

**Ordering note:** T6 and T7 intentionally leave the build red (platform arity / unused) until T8 reconciles `pollOnce`; each such step states the expected transient failure. T8 is the first green build after the refactor.
