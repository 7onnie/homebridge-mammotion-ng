import { spawn } from 'node:child_process';
import { join } from 'node:path';

import type { Logger } from 'homebridge';

const REQUIRED_MAJOR = 3;
const REQUIRED_MINOR = 13;

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

// Runtime bootstrap. Delegates to scripts/bootstrap-python.js (the single
// provisioning implementation, shared with the install-time postinstall):
// it finds or downloads a standalone Python 3.13 and builds the managed venv.
export async function bootstrapManagedPython(log: Logger): Promise<string> {
  const managedPython = managedVenvPythonPath();
  const existingProbe = await probePython(managedPython);
  if (existingProbe.available && versionIsSupported(existingProbe) && existingProbe.hasPyMammotion) {
    return managedPython;
  }

  log.info('Preparing the managed Python 3.13 runtime for the Mammotion bridge (first run may download Python and take a few minutes).');
  const script = join(__dirname, '..', 'scripts', 'bootstrap-python.js');
  const result = await runCommand(process.execPath, [script]);
  if (result.code !== 0) {
    throw new Error(`Python bootstrap failed: ${(result.stderr || result.stdout).trim() || 'unknown error'}`);
  }

  const finalProbe = await probePython(managedPython);
  if (!finalProbe.available || !finalProbe.hasPyMammotion) {
    throw new Error(
      [
        `Managed Python bootstrap ran but pymammotion is still unavailable at ${managedPython}.`,
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
