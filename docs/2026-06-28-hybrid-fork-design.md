# homebridge-mammotion-ng — Hybrid Fork Design Spec

Date: 2026-06-28
Status: Approved design → implementation spec (pending user spec-review)
Upstream: `willmot/homebridge-mammotion` (MIT, author Tom Willmot)

## 1. Overview & goals

Fork of `homebridge-mammotion` that exposes the **Matter RVC** *and* **HAP accessories**
simultaneously from one dynamic-platform instance inside the existing child bridge. The
change is purely **additive**: remove a single either/or boolean gate and add four small,
independently testable units plus one augmented Python bridge action.

Goals (priority order):
1. Keep the working Matter RVC (Start already fixed via `single_schedule`) and the existing
   control set (Pause / Resume / Dock).
2. Add HAP sensors usable as Apple Home automation **triggers** — the headline feature; Apple
   Home cannot trigger automations on Matter RVC operational state (verified).
3. Add a momentary **"Abort Mowing"** switch that ends the job and returns to dock.
4. **One source of truth:** every surface is driven by the existing `poll → updateState` flow.
5. Preserve all modernization (pymammotion 0.8.8, Python 3.13 standalone runtime,
   resilience/crash-safety work, `betterproto2==0.9.1`, plaintext creds — intentional).

Non-goals: rewriting the bridge protocol; multi-mower scaling beyond the single Yuka;
preserving the Matter commissioning across the package rename (user accepts a one-time
re-pair if it happens — it is convenience only).

## 2. Architecture — coexistence mechanism (verified against source)

Today `platform.ts` sets `this.usingMatterRvc = this.shouldUseMatterRvc()` (line 48) and
hard-branches in exactly two places:
- `startup()` (85–89): calls *either* `discoverAndSyncMatterAccessories()` *or* `discoverAndSyncAccessories()`.
- `pollOnce()` (203–218): fans state to *either* `matterHandlers` *or* `handlers`.

That boolean is the **only** reason the surfaces are mutually exclusive. The two registration
paths target independent APIs on the same instance:
- HAP: `this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [acc])` (135).
- Matter: `getMatterApi()` → `this.api.matter` (267) → `matter.registerPlatformAccessories(...)` (187).

`api.matter` does not consume or disable `api.registerPlatformAccessories`. The user's running
child bridge already runs **both** servers in one process (HAP 54218 + Matter 5531). UUIDs are
already namespace-segregated: HAP `homebridge-mammotion:<ns>:<name>` (121) vs Matter
`mammotion-rvc:<ns>:<name>` (matter-accessory.ts:58).

**Change:** replace the single `usingMatterRvc` gate with two independent capability flags —
`matterEnabled` (Matter RVC) and `hapSurfacesEnabled` (sensors + abort switch). `startup()`
becomes additive (register Matter RVC if available, then HAP surfaces, then first poll).
`pollOnce()` fans state to all handler maps with **per-handler try/catch** (replacing
`Promise.all`, so a Matter `updateAccessoryState` stall cannot freeze the automation sensors).

### UUID / username allocation (governing invariant)

Coexistence fails only on UUID/username collision, never on "exclusive mode." Each logical
accessory gets a distinct, stable UUID; the Matter external's username must differ from the
child-bridge `_bridge.username`.

| Accessory | Generator | Seed |
|---|---|---|
| Matter RVC (external) | `matterApi.uuid.generate` | `mammotion-rvc:<ns>:<name>` (unchanged) |
| Docked sensor | `this.api.hap.uuid.generate` | `<PLUGIN_NAME>:<ns>:<name>:sensor:docked` |
| Mowing sensor | `this.api.hap.uuid.generate` | `<PLUGIN_NAME>:<ns>:<name>:sensor:mowing` |
| Error sensor | `this.api.hap.uuid.generate` | `<PLUGIN_NAME>:<ns>:<name>:sensor:error` |
| Abort switch | `this.api.hap.uuid.generate` | `<PLUGIN_NAME>:<ns>:<name>:switch:abort` |

`configureAccessory()` only ever receives HAP accessories. The Matter external is **not**
persisted by Homebridge core and is re-registered every launch keyed by its stable UUID; the
Matter fabric (not a HB cache) preserves any pairing. `configureMatterAccessory`/
`cachedMatterAccessories` are an unused stub today — treat Matter stale-removal as driven by
the **live UUID set produced this run**, not a persisted cache.

## 3. Components (small, well-bounded units)

- **`state-mapper.ts`** — pure `mapState(s: MammotionState) => DerivedState` where
  `DerivedState = { docked, mowing, error, active, online }`. No HAP/Matter deps. Single owner
  of state precedence. Fixture-testable.
- **`debouncer.ts`** — `class Debouncer` with per-key `{committed, pending, pendingSince}` and
  `push(key, value, dwellMs) => committed`. Time-based (survives `pollIntervalSeconds` changes).
  Fake-clock testable.
- **`sensor-accessory.ts`** — `MammotionSensorAccessory`: owns three `Service.ContactSensor`.
  `updateState(derived)` pushes each through the debouncer, sets `ContactSensorState` +
  `StatusActive` + `StatusFault`.
- **`abort-switch.ts`** — `MammotionAbortSwitch`: one momentary `Service.Switch`. `onSet(true)`
  → `client.command(name,'cancel')`; auto-reset; `inFlight` guard. `updateState` is a no-op.
- **`matter-accessory.ts`** (`MammotionMatterVacuum`) — unchanged except it reads the **shared
  derived error** (§6) instead of only bridge `hasError`.
- **`platform.ts`** — orchestration only: builds the per-device surface set, registers per API,
  fans poll state out with isolation.

## 4. State mapper — precedence and exact mode mapping

One pure function, computed **once per device per poll**, shared by all sensors and the RVC
error mapping. Precedence: **ERROR > DOCKED > MOWING** (at most one of docked/mowing/error
true; all may be false in transitional modes).

pymammotion 0.8.8 `device_mode` ints (from `device_constant.py`):
- `returning` (helper): `sysStatus === 14` (MODE_RETURNING).
- **mowing/active**: `online && sysStatus === 13` (MODE_WORKING only — excludes pause 19 /
  returning 14 / manual 20, so "mowing started/stopped" automations are not noisy).
- **docked/finished**: `online && (chargeState !== 0 || sysStatus === 15 /*MODE_CHARGING*/)
  && !mowing && !returning`. **MODE_CHARGING_PAUSE(39) is NOT docked/finished** — pymammotion's
  `MOWING_ACTIVE_MODES` classifies 39 as a mid-job active state (job pending resume on dock).
  `chargeState !== 0` is the authoritative on-dock signal.
- **error/stuck** (the single shared derived error, also consumed by the RVC, §6):
  `hasError || sysStatus ∈ {17 MODE_LOCK, 23 MODE_OTA_UPGRADE_FAIL, 37 MODE_LOCATION_ERROR}
  || offlineConfirmed`. `offlineConfirmed` contribution gated by config `errorIncludesOffline`
  (default true) and the offline grace counter (§8).

`active` = mowing || returning. `online` = `state.online`. The mapper is defensive: every field
defaulted, an unknown `sysStatus` → all flags false, never throws.

> Mode-int values (15, 17, 23, 37, 39) are taken from the workflow's review of pymammotion
> `device_constant.py`. **Implementation step:** confirm each against the installed
> `device_constant.py` on the box before wiring (one `grep`), since some came via relayed
> reads.

## 5. HAP sensors

Three separate `Service.ContactSensor` (not OccupancySensor: both fire automations identically,
but ContactSensor renders as neutral Open/Closed and is the idiom for virtual machine-state
mirrors; OccupancySensor implies human presence and pollutes Home's presence grouping).
Convention: `CONTACT_DETECTED (1)` = condition TRUE. Each carries `StatusActive` (false when
offline-confirmed) and `StatusFault` (GENERAL_FAULT on error).

Debounce — symmetric time-based min-dwell, with an error carve-out:
- `sensorDebounceSeconds` default 30 (≈ 2× the 15 s poll); config-overridable; `0` disables.
- **Error rising fires immediately** (dwell 0 on set); **error falling is sticky** (≥ 1 extra
  dwell) so a single-poll fault stays visible long enough to drive an automation and cannot flap.
- Mowing/Docked clears (→ off) require the dwell to elapse, absorbing the 1-poll pause/returning
  blip.

## 6. Abort switch + bridge.py `_cancel` augmentation

`Service.Switch`, momentary, wired to the existing `'cancel'` action — the TS↔Python action
union (`start|pause|dock|cancel`) and the JSON-RPC contract are **unchanged**; only
`bridge.py:_cancel`'s body changes.

Augmented `_cancel` = end the task AND send home:
- `MODE_WORKING`: `pause_execute_task` → sync → `cancel_job` → sync → conditional `return_to_dock`.
- `MODE_PAUSE`: `cancel_job` → sync → conditional `return_to_dock`.
- `MODE_RETURNING`: already homing; `cancel_job` ends the task, no extra dock.
- Guard ordering: do the fresh `charge_state`/`sys_status` re-read **after** an explicit
  `_request_iot_sync`, then send `return_to_dock` only if `charge_state == 0 && sys_status !=
  MODE_RETURNING`. Double-send is a safe no-op.
- Return a **structured partial-failure result** if `cancel_job` succeeds but `return_to_dock`
  errors (mower is at least stopped; switch still resets; next poll shows reality).
- This is the ONLY `bridge.py` change; `_start` (single_schedule), `_dock`, `_pause` untouched.

Momentary reset + revert:
- `onGet` always returns `false`; `onSet(false)` ignored.
- `onSet(true)`: if `inFlight`, ignore; else set `inFlight`, fire `client.command`, schedule
  reset to OFF after ~500 ms, clear `inFlight` in `finally`.
- On failure: log + ensure reset to OFF (reset-only revert; no `HapStatusError` toast by default,
  to avoid a toast/reset race). The poll loop never writes the switch (input-only).

**Per project policy (destructive command path):** a `gemini_consensus` review of the
augmented `_cancel` + a guarded live test on the real mower are **mandatory before shipping**,
and `return_to_dock`-after-`cancel_job` acceptance must be hardware-verified.

## 7. State flow

`pollOnce()` is the sole writer of all state. `MammotionState` (from `bridge.py:_to_state`) is
the one model.

```
client.pollStates() -> [MammotionState]            // unchanged
for each device state s:
    derived = mapState(s)                          // computed ONCE (pure)
    matterHandler?.updateState(s, derived).catch(log)
    hapSensors?.updateState(derived)               // 3 debounced sensors + StatusActive/Fault
    // abort switch NOT in this loop (input-only)
```

`mapState` shared by sensors AND the RVC error mapping → sensors can never disagree, and RVC +
HAP never diverge on faults. `command()` results re-enter the same `mapState`/fan-out. The
existing overlapping-poll guard (`this.polling`) is retained. Per-handler try/catch isolates
Matter from HAP.

## 8. Error / offline handling

- **Offline grace:** track `consecutiveOfflinePolls`; require `offlineGracePolls` (default 2)
  before flipping `StatusActive=false` and (if `errorIncludesOffline`) raising the Problem
  sensor — absorbs momentary cloud blips.
- **On confirmed offline:** do NOT freeze a stale "mowing"; set `StatusActive=false` on all
  three sensors and (if configured) raise Problem, matching the RVC's existing offline →
  operationalState Error mapping so tiles agree.
- **Bridge crash / IPC:** preserved verbatim from the resilience PRs (per-request timeouts,
  bounded auto-respawn, kill-on-failed-init, bounded startup retry). Sensor pushes are
  fire-and-forget and never throw into the poller.
- **`command()` timeout:** add a per-request timeout to `mammotion-client.ts` (today the promise
  resolves only on a matching response id). On timeout, reject the pending request and clear
  `inFlight` in a `finally` — the abort switch can never latch forever if the bridge stalls.

## 9. Config schema (`config.schema.json`)

Existing keys unchanged (`email`/`password` plaintext intentional; `enableMatterRvc` default
true). Added:

```jsonc
"enableStateSensors":   { "type":"boolean", "default":true },        // expose the 3 trigger sensors
"sensorDocked":         { "type":"boolean", "default":true },        // gated on enableStateSensors
"sensorMowing":         { "type":"boolean", "default":true },
"sensorError":          { "type":"boolean", "default":true },
"errorIncludesOffline": { "type":"boolean", "default":true },        // gated on sensorError
"sensorDebounceSeconds":{ "type":"integer", "default":30, "min":0, "max":300 },
"enableAbortSwitch":    { "type":"boolean", "default":false }        // destructive -> opt-in
```

Mirror all as optional in `MammotionPlatformConfig` (`types.ts`); defaults applied in the
platform constructor alongside the existing `pollIntervalSeconds` clamp.

## 10. Packaging / fork

- **npm + repo name:** `homebridge-mammotion-ng` (in the user's GitHub, account `7onnie`).
  Update `package.json` `name`, `displayName`, `repository`/`bugs`/`homepage`, `keywords`
  (+`matter`,`rvc`,`lawn-mower`); fresh `version`. Keep `main`, `postinstall` bootstrap,
  `build`/`copy:bridge`, `files` whitelist (incl. `scripts/**/*`).
- **PLATFORM_NAME stays `Mammotion`** (settings.ts) — the live config binds the child bridge to
  `"platform":"Mammotion"`. Rebrand only `PLUGIN_NAME` (must equal the npm package name). HAP
  sensors are new accessories regardless. Matter re-pair on rename is **acceptable** (user
  decision) — no heroics required, but the migration backup (§11) still makes it painless.
- **Engines/peerDeps:** require Homebridge 2.x for the Matter feature; on HB 1.x `getMatterApi()`
  returns null → graceful HAP-only mode (sensors still work). Log explicitly when `matterEnabled`
  but `api.matter` is absent.
- **Preserve modernization:** pymammotion 0.8.8; Python **3.13** standalone runtime (confirmed on
  box: venv under `python3.13`); the `single_schedule` start fix (byte-for-byte); the
  resilience/crash-safety PRs; `betterproto2==0.9.1` pin. Strip the debug `_cmdlog`
  instrumentation currently on the box before release.
- **Attribution:** keep `author: "Tom Willmot"`, add fork maintainer to `contributors`, MIT
  LICENSE, README credits upstream + pymammotion and lists divergences (Matter+HAP coexistence,
  sensors, abort switch).

## 11. CI / release / migration

- **Release trigger:** version-bump-on-push (mirrors the user's AutoUpdater SCRIPT_VERSION
  pattern). A GitHub Action on push to `main` reads `package.json` `version`, compares to the
  latest git tag; if newer → create the tag + GitHub Release + `npm publish --provenance`.
- **Secret:** npm **Automation** access token as repo secret `NPM_TOKEN` (publishes even with
  2FA on the account). User must create the npm account + token (only blocking item; not needed
  until first release).
- **Workflow file:** `.github/workflows/release.yml` — Node 20, `npm ci`, `npm run build`,
  version-changed gate, tag + release + publish.
- **Release-day migration on the HB box:**
  1. `cp -a /var/lib/homebridge /var/lib/homebridge.bak-<date>` (config + persist + accessories).
  2. Remove the local-patched `homebridge-mammotion`; `npm i homebridge-mammotion-ng` (as user
     `homebridge`, `--ignore-scripts` then run bootstrap, per existing constraints).
  3. Update `config.json` `platform` block: keep `"platform":"Mammotion"` + `_bridge` intact;
     add the new sensor/switch config keys as desired. Sync to Ansible `roles/homebridge/files/config.json`.
  4. Restart. HAP sensors appear new (pair once); Matter RVC re-commissions only if the rename
     drops the fabric (acceptable). Backup is the rollback path.

## 12. Testing strategy

- **Unit (pure):** `state-mapper.ts` — table of `(sysStatus, chargeState, online, hasError)` →
  expected `{docked,mowing,error}`; `debouncer.ts` — fake-clock dwell/sticky-error cases.
- **Integration (box):** deploy to the live Yuka; verify each sensor flips on the real
  transitions (start → mowing on; dock → docked on after charge; induce/observe an error);
  verify the abort switch ends the job + returns to dock (the guarded destructive live test).
- **Build:** `npm run build` (tsc) + `python3 -m py_compile bridge.py` both pass; no secrets in
  the diff (plaintext user creds live only in user config, not source).

## 13. Open risks / decisions

1. **Abort hardware test** (open) — `return_to_dock` after `cancel_job` must be confirmed on the
   real mower; `gemini_consensus` + guarded live test required before the abort switch ships.
   Switch defaults OFF until then.
2. **Matter re-pair on rename** — RESOLVED: user accepts a one-time re-commission if it happens.
3. **Mode-int provenance** — confirm 15/17/23/37/39 against the installed `device_constant.py`
   before wiring the mapper (one grep).
4. **`api.matter` method names** — confirm `registerPlatformAccessories`/`updateAccessoryState`
   exist on the real HB 2.1.0 `api.matter` (they already work in the deployed code, so this is a
   sanity check, not a risk).
```
