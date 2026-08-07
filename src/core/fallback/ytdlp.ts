import { spawn } from 'node:child_process';
import path from 'node:path';

import { VectraxError, ExitCode, isAbortError } from '../errors.js';
import { MAX, type MediaIntent, type QualityTargets } from '../quality.js';
import { sanitizeFilename } from '../download/filename.js';
import { findExecutable, isWindows, toolsDirectory } from '../util/platform.js';
import { access, constants } from 'node:fs/promises';

const BINARIES = ['yt-dlp', 'yt-dlp_linux', 'yt-dlp_macos', 'youtube-dl'] as const;
const VERSION_TIMEOUT_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 30 * 60_000;

export interface FallbackTool {
  readonly binary: string;
  readonly version: string;
}

let cached: FallbackTool | null | undefined;

function probeVersion(binary: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = spawn(binary, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(undefined);
    }, VERSION_TIMEOUT_MS);

    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve(undefined);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 && out.trim() !== '' ? out.trim().split('\n')[0] : undefined);
    });
  });
}

async function locateTool(binary: string): Promise<string | undefined> {
  const managed = path.join(toolsDirectory(), isWindows() ? `${binary}.exe` : binary);
  try {
    await access(managed, isWindows() ? constants.F_OK : constants.X_OK);
    return managed;
  } catch {}
  return findExecutable(binary);
}

export async function detectFallbackTool(): Promise<FallbackTool | undefined> {
  if (cached !== undefined) return cached ?? undefined;

  for (const binary of BINARIES) {
    const resolved = await locateTool(binary);
    if (resolved === undefined) continue;
    const version = await probeVersion(resolved);
    if (version !== undefined) {
      cached = { binary: resolved, version };
      return cached;
    }
  }

  cached = null;
  return undefined;
}

export function resetFallbackCache(): void {
  cached = undefined;
}

export function formatSelector(
  media: MediaIntent,
  quality: QualityTargets,
  permissive = false,
): string[] {
  if (media === 'video') {
    if (permissive) return ['-f', 'bv*+ba/b'];
    const height = quality.videoHeight;
    const cap = height === MAX ? '' : `[height<=${height}]`;
    return [
      '-f',
      `bv*${cap}+ba/b${cap}/bv*+ba/b`,
      '-S',
      height === MAX ? 'res,vcodec:h264' : `res:${height},vcodec:h264`,
    ];
  }

  if (permissive) return ['-f', 'bestaudio/best'];

  const kbps = quality.audioKbps;
  return [
    '-f',
    'bestaudio[ext=m4a]/bestaudio/best',
    '-S',
    kbps === MAX ? 'aext:m4a,abr' : `abr~${kbps},aext:m4a`,
  ];
}

function outputTemplate(outputDir: string, filename: string): string {
  const stem = sanitizeFilename(filename, 'download').replace(/%/g, '');
  return path.join(outputDir, `${stem}.%(ext)s`);
}

export interface FallbackRequest {
  readonly url: string;
  readonly outputDir: string;
  readonly filename: string;
  readonly media: MediaIntent;
  readonly quality: QualityTargets;
  readonly signal?: AbortSignal | undefined;
  readonly onProgress?: ((percent: number) => void) | undefined;
  readonly onRetry?: (() => void) | undefined;
  readonly timeoutMs?: number | undefined;
}

export interface FallbackResult {
  readonly path: string;
  readonly tool: FallbackTool;
}

const PROGRESS = /\[download\]\s+(\d{1,3}(?:\.\d+)?)%/;

export async function runFallback(
  tool: FallbackTool,
  request: FallbackRequest,
): Promise<FallbackResult> {
  try {
    return await attemptFallback(tool, request, false);
  } catch (error) {
    if (isAbortError(error) || request.signal?.aborted === true) throw error;
    request.onRetry?.();
    return attemptFallback(tool, request, true);
  }
}

async function attemptFallback(
  tool: FallbackTool,
  request: FallbackRequest,
  permissive: boolean,
): Promise<FallbackResult> {
  const args = [
    ...formatSelector(request.media, request.quality, permissive),
    '--retries', '3',
    '--no-playlist',
    '--no-warnings',
    '--newline',
    '--no-simulate',
    '--print',
    'after_move:filepath',
    '--no-part',
    '-o',
    outputTemplate(request.outputDir, request.filename),
    request.url,
  ];

  return new Promise<FallbackResult>((resolve, reject) => {
    const child = spawn(tool.binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    let pending = '';
    let settled = false;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', onAbort);
      fn();
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(() =>
        reject(
          new VectraxError(`${path.basename(tool.binary)} timed out.`, {
            code: 'E_TIMEOUT',
            exitCode: ExitCode.NetworkError,
          }),
        ),
      );
    }, request.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    const onAbort = (): void => {
      child.kill('SIGTERM');
      finish(() => reject(request.signal?.reason ?? new Error('Aborted')));
    };
    request.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });

    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stderr += text;
      pending += text;

      const lines = pending.split(/\r?\n|\r/);
      pending = lines.pop() ?? '';

      let latest: number | undefined;
      for (const line of lines) {
        const match = PROGRESS.exec(line);
        if (match?.[1] !== undefined) latest = Number(match[1]) / 100;
      }
      if (latest !== undefined) request.onProgress?.(latest);
    });

    child.on('error', (error) => {
      finish(() =>
        reject(
          new VectraxError(`Could not run ${path.basename(tool.binary)}: ${error.message}`, {
            code: 'E_INTERNAL',
            exitCode: ExitCode.Failure,
          }),
        ),
      );
    });

    child.on('close', (code) => {
      finish(() => {
        const produced = stdout
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line !== '' && path.isAbsolute(line));
        const file = produced[produced.length - 1];

        if (code !== 0 || file === undefined) {
          reject(
            new VectraxError(
              `${path.basename(tool.binary)} could not download this item.`,
              {
                code: 'E_NO_MEDIA',
                exitCode: ExitCode.NoResults,
                hint: firstUsefulLine(stderr),
                details: { exitCode: code },
              },
            ),
          );
          return;
        }
        resolve({ path: file, tool });
      });
    });
  });
}

function firstUsefulLine(stderr: string): string | undefined {
  const line = stderr
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith('ERROR:') || entry.startsWith('WARNING:'));
  return line === undefined ? undefined : line.replace(/^(ERROR|WARNING):\s*/, '');
}
