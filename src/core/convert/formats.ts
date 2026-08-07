import { UsageError } from '../errors.js';

export const AUDIO_FORMATS = ['mp3', 'm4a', 'flac', 'wav', 'opus', 'ogg'] as const;
export const VIDEO_FORMATS = ['mp4', 'mkv', 'webm'] as const;

export type AudioFormat = (typeof AUDIO_FORMATS)[number];
export type VideoFormat = (typeof VIDEO_FORMATS)[number];
export type MediaFormat = AudioFormat | VideoFormat;

export type FormatIntent = 'original' | 'compatible' | 'archive';

export const FORMAT_INTENTS: readonly FormatIntent[] = ['original', 'compatible', 'archive'];

export interface FormatChoice {
  readonly intent: FormatIntent;
  readonly audio: AudioFormat | undefined;
  readonly video: VideoFormat | undefined;
}

export const KEEP_ORIGINAL: FormatChoice = { intent: 'original', audio: undefined, video: undefined };

const ALIASES: Record<string, MediaFormat> = {
  mp3: 'mp3',
  m4a: 'm4a',
  aac: 'm4a',
  mp4a: 'm4a',
  flac: 'flac',
  wav: 'wav',
  wave: 'wav',
  opus: 'opus',
  ogg: 'ogg',
  vorbis: 'ogg',
  mp4: 'mp4',
  m4v: 'mp4',
  mkv: 'mkv',
  matroska: 'mkv',
  webm: 'webm',
};

export function isAudioFormat(value: MediaFormat): value is AudioFormat {
  return (AUDIO_FORMATS as readonly string[]).includes(value);
}

export function parseFormat(input: string): FormatChoice {
  const value = input.trim().toLowerCase();

  if (value === 'original' || value === 'source' || value === 'keep') return KEEP_ORIGINAL;
  if (value === 'compatible' || value === 'phone' || value === 'universal') {
    return { intent: 'compatible', audio: 'mp3', video: 'mp4' };
  }
  if (value === 'archive' || value === 'lossless') {
    return { intent: 'archive', audio: 'flac', video: 'mkv' };
  }

  const format = ALIASES[value];
  if (format === undefined) {
    throw new UsageError(`Unrecognised format "${input}".`, {
      hint: `Audio: ${AUDIO_FORMATS.join(', ')}. Video: ${VIDEO_FORMATS.join(', ')}. Or use original, compatible, archive.`,
    });
  }

  return isAudioFormat(format)
    ? { intent: 'original', audio: format, video: undefined }
    : { intent: 'original', audio: undefined, video: format };
}

const LOSSLESS_CODECS = new Set(['flac', 'alac', 'pcm_s16le', 'pcm_s24le', 'pcm_f32le', 'wavpack']);

const CONTAINER_CODECS: Record<MediaFormat, readonly string[]> = {
  mp3: ['mp3'],
  m4a: ['aac', 'alac', 'mp3'],
  flac: ['flac'],
  wav: ['pcm_s16le', 'pcm_s24le', 'pcm_f32le'],
  opus: ['opus'],
  ogg: ['opus', 'vorbis', 'flac'],
  mp4: ['aac', 'alac', 'mp3', 'h264', 'hevc', 'av1', 'mpeg4'],
  mkv: ['aac', 'alac', 'mp3', 'flac', 'opus', 'vorbis', 'h264', 'hevc', 'av1', 'vp8', 'vp9'],
  webm: ['opus', 'vorbis', 'vp8', 'vp9', 'av1'],
};

const ENCODERS: Record<MediaFormat, { audio: string; video?: string }> = {
  mp3: { audio: 'libmp3lame' },
  m4a: { audio: 'aac' },
  flac: { audio: 'flac' },
  wav: { audio: 'pcm_s16le' },
  opus: { audio: 'libopus' },
  ogg: { audio: 'libopus' },
  mp4: { audio: 'aac', video: 'libx264' },
  mkv: { audio: 'aac', video: 'libx264' },
  webm: { audio: 'libopus', video: 'libvpx-vp9' },
};

export interface SourceProbe {
  readonly extension: string;
  readonly audioCodec: string | undefined;
  readonly videoCodec: string | undefined;
  readonly audioBitrate: number | undefined;
}

export type ConversionAction = 'none' | 'remux' | 'transcode';

export interface ConversionPlan {
  readonly action: ConversionAction;
  readonly target: MediaFormat;
  readonly args: readonly string[];
  readonly warning: string | undefined;
}

export function targetFormatFor(choice: FormatChoice, probe: SourceProbe): MediaFormat | undefined {
  const wantsVideo = probe.videoCodec !== undefined;
  return wantsVideo ? choice.video : choice.audio;
}

function codecFits(target: MediaFormat, codec: string | undefined): boolean {
  if (codec === undefined) return true;
  return CONTAINER_CODECS[target].includes(codec);
}

function bitrateArgs(probe: SourceProbe): string[] {
  if (probe.audioBitrate === undefined) return ['-q:a', '2'];
  const kbps = Math.max(64, Math.min(320, Math.round(probe.audioBitrate / 1000)));
  return ['-b:a', `${kbps}k`];
}

export function planConversion(probe: SourceProbe, target: MediaFormat): ConversionPlan {
  if (probe.extension === target) {
    return { action: 'none', target, args: [], warning: undefined };
  }

  const audioFits = codecFits(target, probe.audioCodec);
  const videoFits = probe.videoCodec === undefined || codecFits(target, probe.videoCodec);

  if (audioFits && videoFits) {
    return {
      action: 'remux',
      target,
      args: ['-c', 'copy'],
      warning: undefined,
    };
  }

  const encoder = ENCODERS[target];
  const args: string[] = [];
  let warning: string | undefined;

  if (probe.videoCodec !== undefined) {
    args.push('-c:v', videoFits ? 'copy' : (encoder.video ?? 'libx264'));
    if (!videoFits) warning = `re-encoding video to ${encoder.video ?? 'h264'}, which is slow and loses quality`;
  }

  args.push('-c:a', audioFits ? 'copy' : encoder.audio);

  if (!audioFits) {
    const sourceLossless = probe.audioCodec !== undefined && LOSSLESS_CODECS.has(probe.audioCodec);
    const targetLossless = target === 'flac' || target === 'wav';

    if (targetLossless && !sourceLossless) {
      warning = `${probe.audioCodec ?? 'the source'} is lossy, so ${target} will be larger without recovering quality`;
    } else if (!targetLossless && !sourceLossless) {
      args.push(...bitrateArgs(probe));
      warning ??= `re-encoding ${probe.audioCodec ?? 'audio'} to ${target} loses some quality`;
    }
  }

  if (target === 'mp4' || target === 'm4a') args.push('-movflags', '+faststart');
  if (target === 'm4a' || target === 'mp3' || target === 'flac' || target === 'wav') args.push('-vn');

  return { action: 'transcode', target, args, warning };
}
