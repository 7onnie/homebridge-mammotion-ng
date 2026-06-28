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
    this.process = spawn(this.pythonPath, [bridgePath], {
      stdio: 'pipe',
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1',
      },
    });

    this.process.stdout.on('data', (chunk: Buffer) => this.handleStdout(chunk));
    this.process.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim();
      if (text.length > 0) {
        if (text.includes('map areas=') || text.includes('get_area_name_list') || text.includes('start_map_sync')) {
          this.log.info(`[bridge] ${text}`);
        } else {
          this.log.debug(`[bridge] ${text}`);
        }
      }
    });

    this.process.on('exit', (code, signal) => {
      const error = new Error(`Bridge exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`);
      for (const [, request] of this.pending) {
        request.reject(error);
      }
      this.pending.clear();
      this.process = undefined;
      this.emit('exit', error);
    });

    await this.request('init', {
      email: this.config.email,
      password: this.config.password,
      areaNameFallbacks: this.config.areaNameFallbacks ?? {},
    });
  }

  async stop(): Promise<void> {
    if (!this.process) {
      return;
    }

    await this.request('shutdown', {}).catch(() => undefined);
    this.process.kill();
    this.process = undefined;
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

  private async request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    if (!this.process) {
      throw new Error('Bridge is not running');
    }

    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });

    const responsePromise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value: unknown) => resolve(value as T),
        reject,
      });
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
        `Python ${versionLabel(probe)} at ${probe.executable ?? this.pythonPath} is unsupported. Use Python 3.10+ or remove "pythonPath" to use managed runtime.`,
      );
    }

    if (!probe.hasPyMammotion) {
      if (this.userConfiguredPythonPath) {
        const installHint = `${this.pythonPath} -m pip install --upgrade pip pymammotion==0.5.75`;
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
