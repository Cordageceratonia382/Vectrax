import { spawn } from 'node:child_process';
import { chmod, rename, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

import { VectraxError, ExitCode, errorMessage } from '../errors.js';
import type { HttpClient } from '../http/client.js';
import { ensureDir, removeQuietly } from '../util/fs.js';
import { architecture, findExecutable, isWindows, platform, toolsDirectory } from '../util/platform.js';

const RELEASE_BASE = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download';
const CHECKSUMS = `${RELEASE_BASE}/SHA2-256SUMS`;
const INSTALL_TIMEOUT_MS = 10 * 60_000;
const MAX_BINARY_BYTES = 64 * 1024 * 1024;

export type InstallKind = 'manager' | 'download';

export interface ManagerPlan {
  readonly kind: 'manager';
  readonly id: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly description: string;
  readonly manual: string;
}

export interface DownloadPlan {
  readonly kind: 'download';
  readonly id: 'standalone';
  readonly asset: string;
  readonly url: string;
  readonly checksumUrl: string;
  readonly destination: string;
  readonly description: string;
  readonly manual: string;
}

export type InstallPlan = ManagerPlan | DownloadPlan;

interface ManagerCandidate {
  readonly id: string;
  readonly binary: string;
  readonly args: readonly string[];
  readonly platforms: readonly ReturnType<typeof platform>[];
  readonly describe: (binary: string) => string;
}

const MANAGERS: readonly ManagerCandidate[] = [
  {
    id: 'pipx',
    binary: 'pipx',
    args: ['install', 'yt-dlp'],
    platforms: ['linux', 'macos', 'windows'],
    describe: () => 'pipx install yt-dlp',
  },
  {
    id: 'winget',
    binary: 'winget',
    args: ['install', '--id', 'yt-dlp.yt-dlp', '--source', 'winget', '--accept-package-agreements', '--accept-source-agreements'],
    platforms: ['windows'],
    describe: () => 'winget install yt-dlp.yt-dlp',
  },
  {
    id: 'scoop',
    binary: 'scoop',
    args: ['install', 'yt-dlp'],
    platforms: ['windows'],
    describe: () => 'scoop install yt-dlp',
  },
  {
    id: 'brew',
    binary: 'brew',
    args: ['install', 'yt-dlp'],
    platforms: ['macos', 'linux'],
    describe: () => 'brew install yt-dlp',
  },
];

export function standaloneAsset(): string | undefined {
  const arch = architecture();
  switch (platform()) {
    case 'windows':
      return arch === 'x64' || arch === 'ia32' ? 'yt-dlp.exe' : undefined;
    case 'macos':
      return 'yt-dlp_macos';
    case 'linux':
      if (arch === 'x64') return 'yt-dlp_linux';
      if (arch === 'arm64') return 'yt-dlp_linux_aarch64';
      if (arch === 'arm') return 'yt-dlp_linux_armv7l';
      return undefined;
    default:
      return undefined;
  }
}

export function manualInstruction(): string {
  switch (platform()) {
    case 'windows':
      return 'winget install yt-dlp.yt-dlp';
    case 'macos':
      return 'brew install yt-dlp';
    default:
      return 'pipx install yt-dlp';
  }
}

export async function planInstall(): Promise<InstallPlan | undefined> {
  const current = platform();

  for (const manager of MANAGERS) {
    if (!manager.platforms.includes(current)) continue;
    const binary = await findExecutable(manager.binary);
    if (binary === undefined) continue;
    return {
      kind: 'manager',
      id: manager.id,
      command: binary,
      args: manager.args,
      description: manager.describe(binary),
      manual: manager.describe(binary),
    };
  }

  const asset = standaloneAsset();
  if (asset === undefined) return undefined;

  const destination = path.join(toolsDirectory(), isWindows() ? 'yt-dlp.exe' : 'yt-dlp');
  return {
    kind: 'download',
    id: 'standalone',
    asset,
    url: `${RELEASE_BASE}/${asset}`,
    checksumUrl: CHECKSUMS,
    destination,
    description: `download the official yt-dlp binary to ${destination}`,
    manual: manualInstruction(),
  };
}

function runCommand(
  command: string,
  args: readonly string[],
  signal: AbortSignal | undefined,
  onOutput?: (line: string) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stderr = '';
    let settled = false;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn();
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(() => reject(new VectraxError('The installer timed out.', { code: 'E_TIMEOUT' })));
    }, INSTALL_TIMEOUT_MS);

    const onAbort = (): void => {
      child.kill('SIGTERM');
      finish(() => reject(signal?.reason ?? new Error('Aborted')));
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    const forward = (chunk: Buffer): void => {
      const text = chunk.toString('utf8');
      for (const line of text.split(/\r?\n/)) {
        if (line.trim() !== '') onOutput?.(line.trim());
      }
    };
    child.stdout.on('data', forward);
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
      forward(chunk);
    });

    child.on('error', (error) => {
      finish(() =>
        reject(new VectraxError(`Could not run ${path.basename(command)}: ${error.message}`)),
      );
    });
    child.on('close', (code) => {
      finish(() => {
        if (code === 0) resolve();
        else
          reject(
            new VectraxError(`${path.basename(command)} exited with code ${code}.`, {
              hint: lastMeaningfulLine(stderr),
            }),
          );
      });
    });
  });
}

function lastMeaningfulLine(text: string): string | undefined {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  return lines[lines.length - 1];
}

export function parseChecksums(body: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of body.split(/\r?\n/)) {
    const match = /^([0-9a-f]{64})\s+\*?(\S+)$/i.exec(line.trim());
    if (match?.[1] !== undefined && match[2] !== undefined) {
      out.set(match[2], match[1].toLowerCase());
    }
  }
  return out;
}

async function expectedChecksum(
  http: HttpClient,
  plan: DownloadPlan,
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  try {
    const { body } = await http.text(plan.checksumUrl, { ...(signal !== undefined ? { signal } : {}) });
    return parseChecksums(body).get(plan.asset);
  } catch {
    return undefined;
  }
}

export interface InstallProgress {
  readonly onStep?: ((message: string) => void) | undefined;
  readonly onProgress?: ((ratio: number) => void) | undefined;
  readonly signal?: AbortSignal | undefined;
}

async function installStandalone(
  http: HttpClient,
  plan: DownloadPlan,
  progress: InstallProgress,
): Promise<void> {
  progress.onStep?.('verifying the published checksum');
  const expected = await expectedChecksum(http, plan, progress.signal);

  progress.onStep?.(`downloading ${plan.asset}`);
  const { data } = await http.buffer(plan.url, {
    maxBytes: MAX_BINARY_BYTES,
    ...(progress.signal !== undefined ? { signal: progress.signal } : {}),
    onProgress: (received, total) => {
      if (total !== undefined) progress.onProgress?.(received / total);
    },
  });

  const actual = createHash('sha256').update(data).digest('hex');
  if (expected !== undefined && actual !== expected) {
    throw new VectraxError('The downloaded yt-dlp binary failed its checksum check.', {
      code: 'E_NETWORK',
      hint: 'Vectrax refused to install it. This can mean a corrupted download or a tampered mirror.',
      details: { expected, actual },
    });
  }
  if (expected === undefined) {
    progress.onStep?.('published checksums unavailable, continuing without verification');
  }

  await ensureDir(path.dirname(plan.destination));
  const staging = `${plan.destination}.partial`;
  try {
    await writeFile(staging, data);
    if (!isWindows()) await chmod(staging, 0o755);
    await rename(staging, plan.destination);
  } catch (error) {
    await removeQuietly(staging);
    throw new VectraxError(`Could not write ${plan.destination}: ${errorMessage(error)}`, {
      code: 'E_FS',
      exitCode: ExitCode.FilesystemError,
    });
  }
}

export async function performInstall(
  http: HttpClient,
  plan: InstallPlan,
  progress: InstallProgress = {},
): Promise<void> {
  if (plan.kind === 'download') {
    await installStandalone(http, plan, progress);
    return;
  }

  progress.onStep?.(`running ${plan.description}`);
  await runCommand(plan.command, plan.args, progress.signal, (line) => progress.onStep?.(line));
}
