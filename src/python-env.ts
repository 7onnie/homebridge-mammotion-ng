import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { Logger } from 'homebridge';

const REQUIRED_MAJOR = 3;
const REQUIRED_MINOR = 10;
const PYMAMMOTION_SPEC = 'pymammotion==0.5.75';

export type PythonProbe = {
  available: boolean;
  executable?: string;
  hasPyMammotion: boolean;
  major?: number;
  minor?: number;
  patch?: number;
  error?: string;
};

export function managedVenvDir(): string {
  return join(__dirname, '..', '.python-bridge-venv');
}

export function managedVenvPythonPath(): string {
  const venv = managedVenvDir();
  if (process.platform === 'win32') {
    return join(venv, 'Scripts', 'python.exe');
  }
  return join(venv, 'bin', 'python');
}

export function versionIsSupported(probe: PythonProbe): boolean {
  if (probe.major !== REQUIRED_MAJOR || typeof probe.minor !== 'number') {
    return false;
  }

  return probe.minor >= REQUIRED_MINOR;
}

export function versionLabel(probe: PythonProbe): string {
  return `${probe.major ?? '?'}.${probe.minor ?? '?'}.${probe.patch ?? '?'}`;
}

export async function probePython(pythonPath: string): Promise<PythonProbe> {
  const script = 'import importlib.util, json, sys; print(json.dumps({"executable": sys.executable, "version": [sys.version_info[0], sys.version_info[1], sys.version_info[2]], "has_pymammotion": bool(importlib.util.find_spec("pymammotion"))}))';

  const result = await runCommand(pythonPath, ['-c', script]);
  if (result.code !== 0) {
    return {
      available: false,
      hasPyMammotion: false,
      error: (result.stderr || result.stdout).trim() || `failed to execute ${pythonPath}`,
    };
  }

  try {
    const parsed = JSON.parse(result.stdout.trim()) as {
      executable: string;
      version: [number, number, number];
      has_pymammotion: boolean;
    };

    return {
      available: true,
      executable: parsed.executable,
      major: parsed.version[0],
      minor: parsed.version[1],
      patch: parsed.version[2],
      hasPyMammotion: parsed.has_pymammotion,
    };
  } catch {
    return { available: false, hasPyMammotion: false, error: 'failed to parse python probe output' };
  }
}

export async function bootstrapManagedPython(log: Logger): Promise<string> {
  const managedPython = managedVenvPythonPath();
  const existingProbe = await probePython(managedPython);
  if (existingProbe.available && versionIsSupported(existingProbe) && existingProbe.hasPyMammotion) {
    return managedPython;
  }

  const candidates = uniqueStrings([
    process.env.PYTHON,
    // PATH-based lookups
    'python3.13',
    'python3.12',
    'python3.11',
    'python3.10',
    'python3',
    'python',
    // Common macOS absolute locations
    '/opt/homebrew/bin/python3.13',
    '/opt/homebrew/bin/python3.14',
    '/opt/homebrew/bin/python3.12',
    '/opt/homebrew/bin/python3.11',
    '/opt/homebrew/bin/python3.10',
    '/usr/local/bin/python3.13',
    '/usr/local/bin/python3.14',
    '/usr/local/bin/python3.12',
    '/usr/local/bin/python3.11',
    '/usr/local/bin/python3.10',
    '/Library/Frameworks/Python.framework/Versions/3.14/bin/python3',
    '/Library/Frameworks/Python.framework/Versions/3.13/bin/python3',
    '/Library/Frameworks/Python.framework/Versions/3.12/bin/python3',
    '/Library/Frameworks/Python.framework/Versions/3.11/bin/python3',
    '/Library/Frameworks/Python.framework/Versions/3.10/bin/python3',
  ]);

  let selectedPython: string | null = null;
  const failures: string[] = [];
  for (const candidate of candidates) {
    const probe = await probePython(candidate);
    if (probe.available && versionIsSupported(probe)) {
      selectedPython = candidate;
      break;
    }
    failures.push(`${candidate}: ${probe.error ?? 'not available'}`);
  }

  if (!selectedPython) {
    throw new Error(
      [
        'No compatible Python 3.10+ interpreter found to bootstrap managed PyMammotion runtime.',
        `Candidates checked: ${candidates.join(', ')}`,
        `Probe failures: ${failures.join(' | ')}`,
      ].join(' '),
    );
  }

  const venvDir = managedVenvDir();
  if (!existsSync(managedPython)) {
    log.info(`Creating managed Python environment at ${venvDir}`);
    await ensureSuccess(await runCommand(selectedPython, ['-m', 'venv', venvDir]), 'python -m venv');
  }

  log.info('Installing PyMammotion into managed environment (first run may take a minute).');
  await ensureSuccess(await runCommand(managedPython, ['-m', 'pip', 'install', '--upgrade', 'pip']), 'pip upgrade');
  await ensureSuccess(
    await runCommand(managedPython, ['-m', 'pip', 'install', '--upgrade', PYMAMMOTION_SPEC]),
    `pip install ${PYMAMMOTION_SPEC}`,
  );

  const finalProbe = await probePython(managedPython);
  if (!finalProbe.available || !finalProbe.hasPyMammotion) {
    throw new Error('Managed Python bootstrap completed but pymammotion import still failed.');
  }

  return managedPython;
}

type CommandResult = {
  code: number;
  stdout: string;
  stderr: string;
};

async function runCommand(command: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (error: Error) => {
      resolve({
        code: 1,
        stdout,
        stderr: `${stderr}\n${error.message}`,
      });
    });

    child.on('exit', (code: number | null) => {
      resolve({
        code: code ?? 1,
        stdout,
        stderr,
      });
    });
  });
}

async function ensureSuccess(result: CommandResult, step: string): Promise<void> {
  if (result.code === 0) {
    return;
  }

  const errorOutput = (result.stderr || result.stdout).trim();
  throw new Error(`${step} failed: ${errorOutput || 'unknown error'}`);
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (!value) {
      continue;
    }
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    out.push(value);
  }
  return out;
}
