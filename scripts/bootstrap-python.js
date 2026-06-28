#!/usr/bin/env node

const { existsSync } = require('node:fs');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');

const REQUIRED_MAJOR = 3;
const REQUIRED_MINOR = 10;
const PYMAMMOTION_SPEC = 'pymammotion==0.5.75';
const root = join(__dirname, '..');
const venvDir = join(root, '.python-bridge-venv');
const venvPython = process.platform === 'win32'
  ? join(venvDir, 'Scripts', 'python.exe')
  : join(venvDir, 'bin', 'python');

if (process.env.HOMEBRIDGE_MAMMOTION_SKIP_PY_BOOTSTRAP === '1') {
  console.log('[homebridge-mammotion] Skipping python bootstrap via HOMEBRIDGE_MAMMOTION_SKIP_PY_BOOTSTRAP=1');
  process.exit(0);
}

function probePython(pythonPath) {
  const script = 'import importlib.util, json, sys; print(json.dumps({"version": [sys.version_info[0], sys.version_info[1], sys.version_info[2]], "has_pymammotion": bool(importlib.util.find_spec("pymammotion"))}))';

  const result = spawnSync(pythonPath, ['-c', script], { encoding: 'utf8' });
  if (result.status !== 0 || !result.stdout) {
    return null;
  }

  try {
    const parsed = JSON.parse(result.stdout.trim());
    return {
      major: parsed.version[0],
      minor: parsed.version[1],
      patch: parsed.version[2],
      hasPyMammotion: !!parsed.has_pymammotion,
    };
  } catch {
    return null;
  }
}

function supported(probe) {
  return probe && probe.major === REQUIRED_MAJOR && probe.minor >= REQUIRED_MINOR;
}

function runOrWarn(command, args, step) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status === 0) {
    return true;
  }

  const details = (result.stderr || result.stdout || '').trim();
  console.warn(`[homebridge-mammotion] ${step} failed: ${details || 'unknown error'}`);
  return false;
}

const existing = probePython(venvPython);
if (supported(existing) && existing.hasPyMammotion) {
  console.log('[homebridge-mammotion] Managed Python environment already ready.');
  process.exit(0);
}

const candidates = [
  process.env.PYTHON,
  'python3.14',
  'python3.13',
  'python3.12',
  'python3.11',
  'python3.10',
  'python3',
  'python',
  '/opt/homebrew/bin/python3.14',
  '/opt/homebrew/bin/python3.13',
  '/opt/homebrew/bin/python3.12',
  '/usr/local/bin/python3.14',
  '/usr/local/bin/python3.13',
  '/Library/Frameworks/Python.framework/Versions/3.14/bin/python3',
  '/Library/Frameworks/Python.framework/Versions/3.13/bin/python3',
].filter(Boolean);
let selected = null;
for (const candidate of candidates) {
  const probe = probePython(candidate);
  if (supported(probe)) {
    selected = candidate;
    break;
  }
}

if (!selected) {
  console.warn('[homebridge-mammotion] No Python 3.10+ interpreter found during install. Runtime bootstrap will retry on first start.');
  process.exit(0);
}

if (!existsSync(venvPython)) {
  console.log(`[homebridge-mammotion] Creating managed Python environment at ${venvDir}`);
  if (!runOrWarn(selected, ['-m', 'venv', venvDir], 'python -m venv')) {
    process.exit(0);
  }
}

console.log('[homebridge-mammotion] Installing PyMammotion into managed environment...');
if (!runOrWarn(venvPython, ['-m', 'pip', 'install', '--upgrade', 'pip'], 'pip upgrade')) {
  process.exit(0);
}

if (!runOrWarn(venvPython, ['-m', 'pip', 'install', '--upgrade', PYMAMMOTION_SPEC], `pip install ${PYMAMMOTION_SPEC}`)) {
  process.exit(0);
}

console.log('[homebridge-mammotion] Python bootstrap complete.');
process.exit(0);
