import { spawn } from 'node:child_process';
import { join } from 'node:path';

import type { Logger } from 'homebridge';

const REQUIRED_MAJOR = 3;
const REQUIRED_MINOR = 13;

// Single source of truth is PIP_SPECS in scripts/bootstrap-python.js; a test
// asserts both stay identical.
export const PINNED_PYMAMMOTION_VERSION = '0.10.15';

export type PythonProbe = {
  available: boolean;
  executable?: string;
  hasPyMammotion: boolean;
  pymammotionVersion?: string;
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

// pymammotion present AND exactly the pinned version. A present-but-different
// version must never be accepted silently (issue #4).
export function pymammotionMatchesPin(probe: PythonProbe): boolean {
  return probe.hasPyMammotion && probe.pymammotionVersion === PINNED_PYMAMMOTION_VERSION;
}

export function pymammotionPinProblem(probe: PythonProbe): string {
  if (!probe.hasPyMammotion) {
    return 'module "pymammotion" is missing';
  }
  return `pymammotion ${probe.pymammotionVersion ?? '(unknown version)'} is installed but this plugin requires exactly ${PINNED_PYMAMMOTION_VERSION}`;
}

export function versionLabel(probe: PythonProbe): string {
  return `${probe.major ?? '?'}.${probe.minor ?? '?'}.${probe.patch ?? '?'}`;
}

export async function probePython(pythonPath: string): Promise<PythonProbe> {
  const script = [
    'import importlib.util, importlib.metadata as m, json, sys',
    'has = bool(importlib.util.find_spec("pymammotion"))',
    'try: pv = m.version("pymammotion") if has else None',
    'except Exception: pv = None',
    'print(json.dumps({"executable": sys.executable, "version": [sys.version_info[0], sys.version_info[1], sys.version_info[2]], "has_pymammotion": has, "pymammotion_version": pv}))',
  ].join('\n');

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
      pymammotion_version?: string | null;
    };

    return {
      available: true,
      executable: parsed.executable,
      major: parsed.version[0],
      minor: parsed.version[1],
      patch: parsed.version[2],
      hasPyMammotion: parsed.has_pymammotion,
      pymammotionVersion: parsed.pymammotion_version ?? undefined,
    };
  } catch {
    return { available: false, hasPyMammotion: false, error: 'failed to parse python probe output' };
  }
}

// Runtime bootstrap. Delegates to scripts/bootstrap-python.js (the single
// provisioning implementation, shared with the install-time postinstall):
// it finds or downloads a standalone Python 3.13 and builds the managed venv.
export async function bootstrapManagedPython(log: Logger): Promise<string> {
  const managedPython = managedVenvPythonPath();
  const existingProbe = await probePython(managedPython);
  if (existingProbe.available && versionIsSupported(existingProbe) && pymammotionMatchesPin(existingProbe)) {
    return managedPython;
  }
  if (existingProbe.available && existingProbe.hasPyMammotion) {
    log.warn(`Managed environment: ${pymammotionPinProblem(existingProbe)} — reinstalling the pinned version.`);
  }

  log.info('Preparing the managed Python 3.13 runtime for the Mammotion bridge (first run may download Python and take a few minutes).');
  const script = join(__dirname, '..', 'scripts', 'bootstrap-python.js');
  const result = await runCommand(process.execPath, [script]);
  if (result.code !== 0) {
    throw new Error(`Python bootstrap failed: ${(result.stderr || result.stdout).trim() || 'unknown error'}`);
  }

  const finalProbe = await probePython(managedPython);
  if (!finalProbe.available || !pymammotionMatchesPin(finalProbe)) {
    throw new Error(
      [
        `Managed Python bootstrap ran but the pinned pymammotion is not usable at ${managedPython} (${finalProbe.available ? pymammotionPinProblem(finalProbe) : 'interpreter not executable'}).`,
        `Bootstrap output: ${(result.stdout || result.stderr).trim() || '(none)'}`,
      ].join(' '),
    );
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
