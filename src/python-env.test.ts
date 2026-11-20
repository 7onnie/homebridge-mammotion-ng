import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Scripted fake of node:child_process.spawn: the python probe (-c) returns the
// next queued probe JSON, the bootstrap script run returns exit 0.
const probes: string[] = [];
const spawned: Array<{ cmd: string; args: string[] }> = [];

vi.mock('node:child_process', () => ({
  spawn: (cmd: string, args: string[]) => {
    spawned.push({ cmd, args });
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(() => {
      if (args[0] === '-c') {
        child.stdout.emit('data', Buffer.from(probes.shift() ?? ''));
      } else {
        child.stdout.emit('data', Buffer.from('bootstrap ran'));
      }
      child.emit('exit', args[0] === '-c' && probes.length < 0 ? 1 : 0);
    });
    return child;
  },
}));

import {
  PINNED_PYMAMMOTION_VERSION,
  bootstrapManagedPython,
  pymammotionMatchesPin,
  pymammotionPinProblem,
} from './python-env';

const probeJson = (pv: string | null) =>
  JSON.stringify({ executable: '/venv/bin/python', version: [3, 13, 1], has_pymammotion: pv !== null, pymammotion_version: pv });

const log = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) as never;
const bootstrapRuns = () => spawned.filter(s => s.args[0] !== '-c').length;

beforeEach(() => {
  probes.length = 0;
  spawned.length = 0;
});

describe('pymammotion pin (issue #4)', () => {
  it('pin in python-env.ts equals the pin in scripts/bootstrap-python.js', () => {
    const script = readFileSync(join(__dirname, '..', 'scripts', 'bootstrap-python.js'), 'utf8');
    expect(script).toContain(`'pymammotion==${PINNED_PYMAMMOTION_VERSION}'`);
  });

  it('matches only the exact pinned version', () => {
    const base = { available: true, hasPyMammotion: true };
    expect(pymammotionMatchesPin({ ...base, pymammotionVersion: PINNED_PYMAMMOTION_VERSION })).toBe(true);
    expect(pymammotionMatchesPin({ ...base, pymammotionVersion: '0.9.9' })).toBe(false);
    expect(pymammotionMatchesPin({ ...base, pymammotionVersion: undefined })).toBe(false);
    expect(pymammotionMatchesPin({ available: true, hasPyMammotion: false })).toBe(false);
    expect(pymammotionPinProblem({ ...base, pymammotionVersion: '0.9.9' })).toContain('0.9.9');
  });

  it('accepts an existing managed env with the pinned version without re-provisioning', async () => {
    probes.push(probeJson(PINNED_PYMAMMOTION_VERSION));
    await expect(bootstrapManagedPython(log())).resolves.toContain('python');
    expect(bootstrapRuns()).toBe(0);
  });

  it('does NOT silently accept a drifted pymammotion: re-runs the bootstrap and verifies afterwards', async () => {
    probes.push(probeJson('0.9.9'), probeJson(PINNED_PYMAMMOTION_VERSION));
    const l = log();
    await expect(bootstrapManagedPython(l)).resolves.toContain('python');
    expect(bootstrapRuns()).toBe(1);
    expect((l as unknown as { warn: { mock: { calls: string[][] } } }).warn.mock.calls[0][0]).toContain('0.9.9');
  });

  it('throws a clear error if the version is still wrong after the bootstrap', async () => {
    probes.push(probeJson('0.9.9'), probeJson('0.9.9'));
    await expect(bootstrapManagedPython(log())).rejects.toThrow(/0\.9\.9.*requires exactly/);
  });
});

describe('bootstrap-python.js ready()', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const script = require('../scripts/bootstrap-python.js') as {
    PINNED_VERSION: string;
    ready: (p: unknown) => boolean;
  };
  const p = (v: string | null) => ({ major: 3, minor: 13, hasPyMammotion: v !== null, pymammotionVersion: v });

  it('is ready only for the pinned version', () => {
    expect(script.PINNED_VERSION).toBe(PINNED_PYMAMMOTION_VERSION);
    expect(script.ready(p(PINNED_PYMAMMOTION_VERSION))).toBe(true);
    expect(script.ready(p('0.9.9'))).toBe(false);
    expect(script.ready(p(null))).toBe(false);
  });
});
