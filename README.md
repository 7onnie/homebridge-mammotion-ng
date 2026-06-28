# homebridge-mammotion-ng

[![license-mit](https://badgen.net/static/license/mit/blue)](./LICENSE)

Homebridge plugin for Mammotion mowers — hybrid Matter Robot Vacuum + HomeKit trigger sensors + Abort switch, via PyMammotion.

## Features

- **Matter Robot Vacuum** (Homebridge 2.x): Start, Pause, Resume, Dock, and battery status as a standard Matter RVC accessory. Falls back to a HomeKit Switch on Homebridge 1.x.
- **HomeKit trigger sensors**: Three contact sensors (Docked/finished, Mowing/active, Problem/stuck) that you can use in Apple Home automations. Apple Home cannot trigger automations directly on a Matter vacuum's state — the sensors bridge that gap.
- **Abort Mowing switch** (opt-in): A momentary switch that immediately ends the current job and returns the mower to its dock. Off by default because it is destructive.

## Requirements

- **Homebridge 2.x** — required for the Matter RVC accessory. On Homebridge 1.x the plugin falls back to HomeKit-only; the trigger sensors still work.
- **Python 3.13** — required by the bundled PyMammotion bridge. The plugin bootstraps a managed venv automatically; no manual Python setup needed unless you want to override the interpreter.
- **A dedicated Mammotion cloud account** shared to your mower(s).
- Node.js 20+.

## Install

```bash
npm i -g homebridge-mammotion-ng
```

> **Migration note:** if you are switching from the original `homebridge-mammotion` plugin, the Homebridge *platform name* stays `Mammotion`. Existing pairings survive the switch because Homebridge identifies accessories by platform name, not npm package name.

## Configure

Minimal config:

```json
{
  "platforms": [
    {
      "platform": "Mammotion",
      "name": "Mammotion",
      "email": "your-mammotion-email@example.com",
      "password": "your-password"
    }
  ]
}
```

### Config options

| Key | Type | Default | Description |
|---|---|---|---|
| `email` | string | — | Mammotion account email (or account number). |
| `password` | string | — | Mammotion account password. |
| `enableMatterRvc` | boolean | `true` | Expose the mower as a Matter RVC accessory (requires Homebridge 2.x with Matter enabled). |
| `enableStateSensors` | boolean | `true` | Expose the three HomeKit trigger sensors for use in automations. |
| `sensorDocked` | boolean | `true` | Include the Docked/finished sensor (visible when `enableStateSensors` is on). |
| `sensorMowing` | boolean | `true` | Include the Mowing/active sensor. |
| `sensorError` | boolean | `true` | Include the Problem/stuck sensor. |
| `errorIncludesOffline` | boolean | `true` | Treat mower offline as a problem state (triggers the Problem sensor). |
| `sensorDebounceSeconds` | integer | `30` | How long a state must hold before a sensor flips (0–300 s). Problem states are reported immediately. |
| `enableAbortSwitch` | boolean | `false` | Expose a momentary Abort Mowing switch. Ends the current job and returns to dock. **Destructive — off by default.** |
| `pollIntervalSeconds` | integer | `15` | Poll interval in seconds (5–120). |
| `deviceFilter` | string[] | — | Optional allow-list of exact device names to expose, e.g. `["Luba-12345678"]`. |
| `areaNameFallbacks` | object | — | Fallback area names when Mammotion does not return map/plan metadata. Use device name as key or `"*"` for default. |
| `pythonPath` | string | — | Leave empty to use the managed venv. Set only if you need a specific interpreter. |

### Area name fallbacks

```json
{
  "areaNameFallbacks": {
    "Luba-VAFFT58A": ["Front Lawn", "Back Lawn"],
    "*": ["Zone 1", "Zone 2"]
  }
}
```

## Development

```bash
npm install
npm run build
npx vitest run
```

## Differences from upstream

Compared to [`willmot/homebridge-mammotion`](https://github.com/willmot/homebridge-mammotion):

- **Matter + HAP coexistence**: the Matter RVC accessory and the HomeKit trigger sensors are registered in the same Homebridge session without conflicting.
- **Trigger sensors**: the three Docked / Mowing / Problem contact sensors are new to this fork. They exist specifically because Apple Home cannot trigger automations on a Matter vacuum's state directly.
- **Abort Mowing switch**: opt-in momentary switch that ends the active job and returns the mower to dock.
- **pymammotion 0.8.x / Python 3.13**: updated and pinned dependency stack; the managed venv targets Python 3.13.
- **Saved-plan start fix**: starting a job by saved plan ID works correctly (upstream had a mapping bug).

## Notes

- BLE-only control is not supported; cloud connectivity is required.
- A dedicated Mammotion account (rather than your primary account) is the safest setup.

## Credits

Forked from [`willmot/homebridge-mammotion`](https://github.com/willmot/homebridge-mammotion) by Tom Willmot (MIT).

Built on the PyMammotion library by [`mikey0000`](https://github.com/mikey0000/PyMammotion), which also powers the [Mammotion Home Assistant integration](https://github.com/mikey0000/Mammotion-HA).

## License

MIT — see [LICENSE](./LICENSE).
