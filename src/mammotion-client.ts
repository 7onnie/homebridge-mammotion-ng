import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';

import type { Logger } from 'homebridge';

import type {
  MammotionBridgeResponse,
  MammotionDeviceInfo,
  MammotionPlatformConfig,
  MammotionState,
} from './types';
import {
  bootstrapManagedPython,
  managedVenvPythonPath,
  probePython,
  versionIsSupported,
  versionLabel,
} from './python-env';

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

export class MammotionClient extends EventEmitter {
  private process?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private timeouts = new Map<number, NodeJS.Timeout>();
  private buffer = '';
  private pythonPath: string;
  private readonly userConfiguredPythonPath: boolean;

  constructor(
    private readonly log: Logger,
    private readonly config: MammotionPlatformConfig,
  ) {
    super();
    this.userConfiguredPythonPath = Boolean(config.pythonPath);
    this.pythonPath = config.pythonPath ?? managedVenvPythonPath();
  }

  async start(): Promise<void> {
    if (this.process) {
      return;
    }

    await this.verifyPythonEnvironment();

    const bridgePath = join(__dirname, 'python', 'bridge.py');
    // Tune pymammotion's built-in mqtt_activity_loop cadence (read from these env
    // vars at import time, per device mode) so an externally-started mow is
    // detected within ~cloudRefreshSeconds instead of the library default
    // (15-60 min). The loop is rate-limit-aware and backs off on cloud 429s.
    const cloudSecs = String(Math.max(15, this.config.cloudRefreshSeconds ?? 120));
    this.process = spawn(this.pythonPath, [bridgePath], {
      stdio: 'pipe',
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1',
        MAMMOTION_POLL_ACTIVE_SECS: cloudSecs,
        MAMMOTION_POLL_DOCKED_CHARGING_SECS: cloudSecs,
        MAMMOTION_POLL_DOCKED_FULL_SECS: cloudSecs,
        MAMMOTION_POLL_IDLE_SECS: cloudSecs,
      },
    });

    this.process.stdout.on('data', (chunk: Buffer) => this.handleStdout(chunk));
    this.process.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim();
      if (text.length > 0) {
        // Python logging WARNING/ERROR lines (rate-limit quota, re-login circuit
        // breaker, availability changes) must be visible in the Homebridge log —
        // these are exactly the silent-degradation modes we went blind on.
        if (/^(WARNING|ERROR|CRITICAL)\b/m.test(text)) {
          this.log.warn(`[bridge] ${text}`);
        } else if (text.includes('map areas=') || text.includes('get_area_name_list') || text.includes('start_map_sync')) {
          this.log.info(`[bridge] ${text}`);
        } else {
          this.log.debug(`[bridge] ${text}`);
        }
      }
    });

    const proc = this.process;
    proc.on('exit', (code, signal) => {
      const error = new Error(`Bridge exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`);
      for (const [, request] of this.pending) {
        request.reject(error);
      }
      this.pending.clear();
      for (const t of this.timeouts.values()) { clearTimeout(t); }
      this.timeouts.clear();
      // Emit 'exit' only for unexpected deaths. stop()/restart() clear
      // this.process synchronously before the (async) exit event lands, so an
      // identity check is race-free — a flag reset in stop()'s finally was not
      // (live-seen 2026-07-11: watchdog restart also triggered the respawn).
      if (this.process === proc) {
        this.process = undefined;
        this.emit('exit', error);
      }
    });

    await this.request('init', {
      email: this.config.email,
      password: this.config.password,
      areaNameFallbacks: this.config.areaNameFallbacks ?? {},
      defaultPlan: this.config.defaultPlan ?? '',
    });
  }

  async stop(): Promise<void> {
    if (!this.process) {
      return;
    }

    const proc = this.process;
    await this.request('shutdown', {}).catch(() => undefined);
    // Detach before kill: the exit handler treats a death of the still-attached
    // process as unexpected, and this synchronous block runs before the (async)
    // exit event can land.
    this.process = undefined;
    proc.kill();
  }

  // Full bridge recycle: kills the Python process and spawns a fresh one
  // (fresh cloud login, fresh MQTT session, empty send-quota window). Used by
  // the platform watchdog to recover from pymammotion's wedged-transport
  // states, which have no in-process recovery path.
  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  async discoverDevices(): Promise<MammotionDeviceInfo[]> {
    return this.request<MammotionDeviceInfo[]>('list_devices', {});
  }

  async pollStates(): Promise<MammotionState[]> {
    return this.request<MammotionState[]>('poll', {});
  }

  async command(deviceName: string, action: 'start' | 'pause' | 'dock' | 'cancel'): Promise<MammotionState> {
    return this.request<MammotionState>('command', {
      name: deviceName,
      action,
    });
  }

  async startPlan(deviceName: string, planId: string): Promise<MammotionState> {
    return this.request<MammotionState>('command', {
      name: deviceName,
      action: 'start_plan',
      planId,
    });
  }

  private async request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    if (!this.process) {
      throw new Error('Bridge is not running');
    }

    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    const timeoutMs = ({ init: 120000, command: 60000, poll: 30000, shutdown: 5000 } as Record<string, number>)[method] ?? 30000;

    const responsePromise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value: unknown) => resolve(value as T),
        reject,
      });
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          this.timeouts.delete(id);
          reject(new Error(`Bridge request '${method}' timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
      timer.unref?.();
      this.timeouts.set(id, timer);
    });

    this.process.stdin.write(`${payload}\n`);
    return responsePromise;
  }

  private handleStdout(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8');

    while (true) {
      const lineEnd = this.buffer.indexOf('\n');
      if (lineEnd < 0) {
        return;
      }

      const line = this.buffer.slice(0, lineEnd).trim();
      this.buffer = this.buffer.slice(lineEnd + 1);

      if (line.length === 0) {
        continue;
      }

      let message: { id?: number } & MammotionBridgeResponse;
      try {
        message = JSON.parse(line) as { id?: number } & MammotionBridgeResponse;
      } catch (error) {
        this.log.warn(`Failed to parse bridge message: ${line}`);
        continue;
      }

      if (typeof message.id !== 'number') {
        continue;
      }

      const request = this.pending.get(message.id);
      if (!request) {
        continue;
      }

      this.pending.delete(message.id);
      const timer = this.timeouts.get(message.id);
      if (timer) { clearTimeout(timer); this.timeouts.delete(message.id); }

      if (!message.ok) {
        request.reject(new Error(message.error ?? 'Unknown bridge error'));
        continue;
      }

      request.resolve(message.data);
    }
  }

  private async verifyPythonEnvironment(): Promise<void> {
    let probe = await probePython(this.pythonPath);
    if (!probe.available || !versionIsSupported(probe) || !probe.hasPyMammotion) {
      if (!this.userConfiguredPythonPath) {
        this.log.info('Preparing managed Python environment for Mammotion bridge...');
        this.pythonPath = await bootstrapManagedPython(this.log);
        probe = await probePython(this.pythonPath);
      } else if (!probe.available) {
        this.log.warn(
          `Configured pythonPath "${this.pythonPath}" is not executable in Homebridge runtime (${probe.error ?? 'unknown reason'}). Falling back to managed runtime.`,
        );
        this.pythonPath = await bootstrapManagedPython(this.log);
        probe = await probePython(this.pythonPath);
      }
    }

    if (!probe.available) {
      throw new Error(
        `Cannot execute python interpreter "${this.pythonPath}" (${probe.error ?? 'unknown reason'}).`,
      );
    }

    if (!versionIsSupported(probe)) {
      throw new Error(
        `Python ${versionLabel(probe)} at ${probe.executable ?? this.pythonPath} is unsupported. Use Python 3.13+ or remove "pythonPath" to use the managed runtime.`,
      );
    }

    if (!probe.hasPyMammotion) {
      if (this.userConfiguredPythonPath) {
        const installHint = `${this.pythonPath} -m pip install --upgrade pip pymammotion==0.8.8 packaging "betterproto2>=0.9,<0.10"`;
        throw new Error(
          [
            `Python found at ${probe.executable ?? this.pythonPath} but module "pymammotion" is missing.`,
            `Install it with: ${installHint}`,
            'Or remove "pythonPath" to use managed runtime.',
          ].join(' '),
        );
      }

      throw new Error('Managed runtime bootstrap completed but pymammotion is still unavailable.');
    }
  }
}
