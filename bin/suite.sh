#!/usr/bin/env bash
# Build + tests. Exit code != 0 on any failure.
set -euo pipefail
cd "$(dirname "$0")/.."

# The postinstall hook would provision Python (network, minutes); tests don't need it.
export HOMEBRIDGE_MAMMOTION_SKIP_PY_BOOTSTRAP=1

if [ ! -d node_modules ] || [ "${SUITE_FORCE_CI:-0}" = "1" ]; then
  npm ci
fi
npm run build
npm test
