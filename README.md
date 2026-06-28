# Homebridge Mammotion

[![license-mit](https://badgen.net/static/license/mit/blue)](https://github.com/willmot/homebridge-mammotion/blob/main/LICENSE)

Provides Homebridge control for Mammotion mowers using the `PyMammotion` stack used by the Home Assistant integration.

This plugin was heavily informed by the Mammotion Home Assistant work from `mikey0000` and by the Reddit guide showing Mammotion Yuka zone selection in Apple Home.

## Features

- Discovers Mammotion mower devices from your account
- Exposes each mower as a Matter robotic vacuum when Matter is available and enabled in Homebridge
- Falls back to a HomeKit `Switch` when Matter is unavailable
- Supports start, pause, dock, and cancel actions
- Exposes battery status, charging state, and low-battery state

## Requirements

- Node.js 20+
- Homebridge 1.8+
- Python 3.10+

The plugin creates a managed virtual environment at `.python-bridge-venv` and installs a pinned `pymammotion` dependency automatically.

## Install

```bash
npm i -g homebridge-mammotion
```

## Configure

```json
{
  "platforms": [
    {
      "platform": "Mammotion",
      "name": "Mammotion",
      "email": "your-mammotion-email@example.com",
      "password": "your-password",
      "pollIntervalSeconds": 15,
      "enableMatterRvc": true,
      "offCommand": "pause",
      "deviceFilter": ["Luba-12345678"]
    }
  ]
}
```

- `email` / `password`: Mammotion account credentials. Some accounts use an account number instead of an email address.
- `pollIntervalSeconds`: Poll interval in seconds. Supported range: `5` to `120`.
- `enableMatterRvc`: Enable Matter robotic vacuum accessories when your Homebridge runtime supports Matter.
- `offCommand`: Action used when the fallback switch turns off. Allowed values: `pause`, `dock`, `cancel`.
- `deviceFilter`: Optional allow-list of exact device names to expose.

Optional Python override:

```json
{
  "pythonPath": "/opt/homebrew/bin/python3.12"
}
```

Optional area-name fallbacks when Mammotion does not return area metadata:

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
```

## Notes

- A dedicated Mammotion account shared to your mower devices is the safest setup.
- BLE-only control is not implemented.
- Matter robotic vacuum mode depends on a Matter-capable Homebridge runtime with Matter enabled.

## Credits

- Built on ideas and behavior from the [Mammotion Home Assistant integration](https://github.com/mikey0000/Mammotion-HA) by `mikey0000`.
- Also inspired by the Reddit post [Mammotion Yuka in Apple Home with zone selection - Full working guide (HAMH Alpha)](https://www.reddit.com/r/HomeKit/comments/1rkvbyu/mammotion_yuka_in_apple_home_with_zone_selection/), which explicitly credits the Mammotion HA integration as the basis for that setup.

## License

Licensed under the MIT License. See [LICENSE](./LICENSE) for details.
