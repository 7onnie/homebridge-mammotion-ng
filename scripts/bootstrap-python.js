#!/usr/bin/env node
'use strict';

// Provisions the managed Python runtime for the PyMammotion bridge.
//
// pymammotion 0.8.8 requires Python 3.13, which most Homebridge hosts (DietPi,
// Raspberry Pi OS, Debian) do not ship and cannot apt-install. So, in order of
// preference, this script:
//   1. reuses the managed venv if it's already good;
//   2. uses any Python >= 3.13 already on the system;
//   3. otherwise downloads a standalone CPython 3.13 (astral-sh
//      python-build-standalone) for this OS/arch — enabling a true 1-click
//      GUI install with no manual Python setup.
// Then it creates a venv and installs pymammotion (+ packaging, + the
// betterproto2 pin).
//
// It runs at npm-install time (postinstall) AND is re-invoked at runtime by
// src/python-env.ts, so it is the single source of provisioning truth.
// Failures here are non-fatal (warn + exit 0): the runtime bootstrap retries.

const { existsSync, mkdirSync, createWriteStream, rmSync } = require('node:fs');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
const https = require('node:https');
const os = require('node:os');

const REQUIRED_MAJOR = 3;
const REQUIRED_MINOR = 13;
const PIP_SPECS = ['pymammotion==0.8.8', 'packaging', 'betterproto2>=0.9,<0.10'];
const PBS_LATEST_API = 'https://api.github.com/repos/astral-sh/python-build-standalone/releases/latest';

const root = join(__dirname, '..');
const venvDir = join(root, '.python-bridge-venv');
const standaloneDir = join(root, '.python-standalone');
const isWin = process.platform === 'win32';
const venvPython = isWin ? join(venvDir, 'Scripts', 'python.exe') : join(venvDir, 'bin', 'python');
const standalonePython = isWin ? join(standaloneDir, 'python.exe') : join(standaloneDir, 'bin', 'python3');

const log = (m) => console.log(`[homebridge-mammotion-ng] ${m}`);
const warn = (m) => console.warn(`[homebridge-mammotion-ng] ${m}`);

function probe(python) {
  const script = 'import importlib.util,json,sys;print(json.dumps({"v":[sys.version_info[0],sys.version_info[1]],"pm":bool(importlib.util.find_spec("pymammotion"))}))';
  const r = spawnSync(python, ['-c', script], { encoding: 'utf8' });
  if (r.status !== 0 || !r.stdout) {
    return null;
  }
  try {
    const p = JSON.parse(r.stdout.trim());
    return { major: p.v[0], minor: p.v[1], hasPyMammotion: !!p.pm };
  } catch {
    return null;
  }
}

const supported = (p) => !!p && p.major === REQUIRED_MAJOR && p.minor >= REQUIRED_MINOR;

function run(cmd, args, step) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.status === 0) {
    return true;
  }
  warn(`${step} failed: ${(r.stderr || r.stdout || '').trim() || 'unknown error'}`);
  return false;
}

function targetTriple() {
  const arch = process.arch === 'x64' ? 'x86_64' : process.arch === 'arm64' ? 'aarch64' : null;
  if (!arch) {
    return null;
  }
  if (process.platform === 'darwin') {
    return `${arch}-apple-darwin`;
  }
  if (process.platform === 'linux') {
    const musl = existsSync('/etc/alpine-release');
    return `${arch}-unknown-linux-${musl ? 'musl' : 'gnu'}`;
  }
  if (process.platform === 'win32') {
    return `${arch}-pc-windows-msvc`;
  }
  return null;
}

function fetchUrl(url, asJson, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { 'User-Agent': 'homebridge-mammotion-ng', Accept: asJson ? 'application/vnd.github+json' : '*/*' } },
      (res) => {
        if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          if (redirectsLeft <= 0) {
            reject(new Error('too many redirects'));
            return;
          }
          resolve(fetchUrl(res.headers.location, asJson, redirectsLeft - 1));
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          try {
            resolve(asJson ? JSON.parse(buf.toString('utf8')) : buf);
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('request timed out')));
  });
}

function downloadToFile(url, dest, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'homebridge-mammotion-ng' } }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) {
          reject(new Error('too many redirects'));
          return;
        }
        resolve(downloadToFile(res.headers.location, dest, redirectsLeft - 1));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} downloading ${url}`));
        return;
      }
      const file = createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve()));
      file.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(300000, () => req.destroy(new Error('download timed out')));
  });
}

async function provisionStandalone() {
  const triple = targetTriple();
  if (!triple) {
    warn(`No standalone Python is available for this platform/arch (${process.platform}/${process.arch}); install Python 3.13 manually.`);
    return null;
  }
  log(`No Python 3.13 found on the system — downloading a standalone build for ${triple} (this happens once).`);

  let release;
  try {
    release = await fetchUrl(PBS_LATEST_API, true);
  } catch (e) {
    warn(`Could not query python-build-standalone releases: ${e.message}`);
    return null;
  }

  const assets = Array.isArray(release && release.assets) ? release.assets : [];
  const re = new RegExp(`^cpython-3\\.13\\.\\d+\\+\\d+-${triple.replace(/[-.]/g, (m) => `\\${m}`)}-install_only\\.tar\\.gz$`);
  const name = assets.map((a) => a.name).filter((n) => re.test(n)).sort().pop();
  const asset = assets.find((a) => a.name === name);
  if (!asset) {
    warn(`No CPython 3.13 install_only asset for ${triple} in the latest python-build-standalone release.`);
    return null;
  }

  const tmp = join(os.tmpdir(), asset.name);
  try {
    log(`Downloading ${asset.name} …`);
    await downloadToFile(asset.browser_download_url, tmp);
  } catch (e) {
    warn(`Download failed: ${e.message}`);
    rmSync(tmp, { force: true });
    return null;
  }

  try {
    rmSync(standaloneDir, { recursive: true, force: true });
    mkdirSync(standaloneDir, { recursive: true });
  } catch {
    /* best effort */
  }
  const extracted = run('tar', ['-xzf', tmp, '--strip-components=1', '-C', standaloneDir], 'tar extract');
  rmSync(tmp, { force: true });
  if (!extracted) {
    return null;
  }

  return supported(probe(standalonePython)) ? standalonePython : null;
}

async function main() {
  if (process.env.HOMEBRIDGE_MAMMOTION_SKIP_PY_BOOTSTRAP === '1') {
    log('Skipping Python bootstrap (HOMEBRIDGE_MAMMOTION_SKIP_PY_BOOTSTRAP=1).');
    return;
  }

  const existing = probe(venvPython);
  if (supported(existing) && existing.hasPyMammotion) {
    log('Managed Python environment already ready.');
    return;
  }

  const candidates = [
    process.env.PYTHON,
    standalonePython,
    'python3.13',
    'python3',
    'python',
    '/opt/homebrew/bin/python3.13',
    '/usr/local/bin/python3.13',
    '/Library/Frameworks/Python.framework/Versions/3.13/bin/python3',
  ].filter(Boolean);

  let python = null;
  for (const candidate of candidates) {
    if (supported(probe(candidate))) {
      python = candidate;
      break;
    }
  }

  if (!python) {
    python = await provisionStandalone();
  }

  if (!python) {
    warn('No Python 3.13 interpreter available (auto-download unavailable). The runtime will retry on first start.');
    return;
  }

  if (!existsSync(venvPython)) {
    log(`Creating managed Python environment at ${venvDir}`);
    if (!run(python, ['-m', 'venv', venvDir], 'python -m venv')) {
      return;
    }
  }

  log('Installing PyMammotion into the managed environment (first run may take a minute)…');
  if (!run(venvPython, ['-m', 'pip', 'install', '--upgrade', 'pip'], 'pip upgrade')) {
    return;
  }
  if (!run(venvPython, ['-m', 'pip', 'install', '--upgrade', ...PIP_SPECS], 'pip install pymammotion')) {
    return;
  }

  const final = probe(venvPython);
  if (supported(final) && final.hasPyMammotion) {
    log('Python bootstrap complete.');
  } else {
    warn('Bootstrap finished but the pymammotion import check did not pass; the runtime will retry.');
  }
}

main().catch((e) => {
  warn(`Python bootstrap error: ${e && e.message ? e.message : e}`);
  process.exit(0);
});
