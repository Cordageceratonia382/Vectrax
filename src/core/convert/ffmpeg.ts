import { spawn } from 'node:child_process';
import { rename, stat } from 'node:fs/promises';
import path from 'node:path';

import { VectraxError, ExitCode, errorMessage } from '../errors.js';
import { removeQuietly } from '../util/fs.js';
import { findExecutable, isWindows } from '../util/platform.js';
import { planConversion, type ConversionPlan, type MediaFormat, type SourceProbe } from './formats.js';
import type { TrackMetadata } from '../metadata/types.js';

const CONVERT_TIMEOUT_MS = 30 * 60_000;

export interface Toolchain {
  readonly ffmpeg: string;
  readonly ffprobe: string | undefined;
}

let cached: Toolchain | null | undefined;

export async function detectToolchain(): Promise<Toolchain | undefined> {
  if (cached !== undefined) return cached ?? undefined;

  const ffmpeg = await findExecutable('ffmpeg');
  if (ffmpeg === undefined) {
    cached = null;
    return undefined;
  }

  cached = {
    ffmpeg,
    ffprobe: await findExecutable('ffprobe'),
  };
  return cached;
}

export function resetToolchainCache(): void {
  cached = undefined;
}

export function ffmpegInstruction(): string {
  if (isWindows()) return 'winget install Gyan.FFmpeg';
  return process.platform === 'darwin' ? 'brew install ffmpeg' : 'your package manager, e.g. apt install ffmpeg';
}

function run(
  command: string,
  args: readonly string[],
  signal: AbortSignal | undefined,
  onLine?: (line: string) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
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
      finish(() => reject(new VectraxError('ffmpeg timed out.', { code: 'E_TIMEOUT' })));
    }, CONVERT_TIMEOUT_MS);

    const onAbort = (): void => {
      child.kill('SIGTERM');
      finish(() => reject(signal?.reason ?? new Error('Aborted')));
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stderr += text;
      for (const line of text.split(/\r?\n/)) {
        if (line.trim() !== '') onLine?.(line.trim());
      }
    });

    child.on('error', (error) => {
      finish(() => reject(new VectraxError(`Could not run ${path.basename(command)}: ${error.message}`)));
    });
    child.on('close', (code) => {
      finish(() => {
        if (code === 0) resolve(stdout);
        else reject(new VectraxError(`ffmpeg exited with code ${code}.`, { hint: lastError(stderr) }));
      });
    });
  });
}

function lastError(stderr: string): string | undefined {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('frame=') && !line.startsWith('size='));
  return lines[lines.length - 1];
}

interface ProbeJson {
  streams?: { codec_type?: string; codec_name?: string; bit_rate?: string }[];
  format?: { bit_rate?: string };
}

export async function probeSource(
  tools: Toolchain,
  file: string,
  signal?: AbortSignal,
): Promise<SourceProbe> {
  const extension = path.extname(file).slice(1).toLowerCase();

  if (tools.ffprobe === undefined) {
    return { extension, audioCodec: undefined, videoCodec: undefined, audioBitrate: undefined };
  }

  const output = await run(
    tools.ffprobe,
    ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file],
    signal,
  ).catch(() => '');

  let parsed: ProbeJson = {};
  try {
    parsed = JSON.parse(output) as ProbeJson;
  } catch {}

  const streams = parsed.streams ?? [];
  const audio = streams.find((stream) => stream.codec_type === 'audio');
  const video = streams.find((stream) => stream.codec_type === 'video' && stream.codec_name !== 'mjpeg');
  const bitrate = Number(audio?.bit_rate ?? parsed.format?.bit_rate);

  return {
    extension,
    audioCodec: audio?.codec_name,
    videoCodec: video?.codec_name,
    audioBitrate: Number.isFinite(bitrate) && bitrate > 0 ? bitrate : undefined,
  };
}

export interface ConversionOutcome {
  readonly path: string;
  readonly action: ConversionPlan['action'];
  readonly warning: string | undefined;
}

const METADATA_KEYS: readonly [keyof TrackMetadata, string][] = [
  ['title', 'title'],
  ['artist', 'artist'],
  ['album', 'album'],
  ['albumArtist', 'album_artist'],
  ['genre', 'genre'],
  ['composer', 'composer'],
  ['comment', 'comment'],
];

function metadataArgs(metadata: TrackMetadata | undefined): string[] {
  const args = ['-map_metadata', '-1'];
  if (metadata === undefined) return args;

  for (const [field, key] of METADATA_KEYS) {
    const value = metadata[field];
    if (typeof value === 'string' && value !== '') args.push('-metadata', `${key}=${value}`);
  }
  if (metadata.year !== undefined) args.push('-metadata', `date=${metadata.year}`);
  if (metadata.track !== undefined) {
    const total = metadata.trackTotal !== undefined ? `/${metadata.trackTotal}` : '';
    args.push('-metadata', `track=${metadata.track}${total}`);
  }
  return args;
}

export async function convertFile(
  tools: Toolchain,
  source: string,
  target: MediaFormat,
  options: {
    signal?: AbortSignal | undefined;
    onProgress?: ((seconds: number) => void) | undefined;
    metadata?: TrackMetadata | undefined;
  } = {},
): Promise<ConversionOutcome> {
  const probe = await probeSource(tools, source, options.signal);
  const plan = planConversion(probe, target);

  if (plan.action === 'none') {
    return { path: source, action: 'none', warning: undefined };
  }

  const destination = path.join(path.dirname(source), `${path.basename(source, path.extname(source))}.${target}`);
  const staging = `${destination}.converting.${target}`;

  try {
    await run(
      tools.ffmpeg,
      [
        '-hide_banner', '-loglevel', 'error', '-stats', '-y',
        '-i', source,
        ...plan.args,
        ...metadataArgs(options.metadata),
        staging,
      ],
      options.signal,
      (line) => {
        const match = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(line);
        if (match !== null) {
          const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
          options.onProgress?.(seconds);
        }
      },
    );

    const info = await stat(staging);
    if (info.size === 0) throw new VectraxError('ffmpeg produced an empty file.');

    if (destination !== source) await removeQuietly(destination);
    await rename(staging, destination);
    if (destination !== source) await removeQuietly(source);

    return { path: destination, action: plan.action, warning: plan.warning };
  } catch (error) {
    await removeQuietly(staging);
    if (error instanceof VectraxError) throw error;
    throw new VectraxError(`Could not convert to ${target}: ${errorMessage(error)}`, {
      code: 'E_INTERNAL',
      exitCode: ExitCode.Failure,
    });
  }
}
