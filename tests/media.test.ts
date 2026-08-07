import { describe, expect, it } from 'vitest';

import {
  AUDIO_FORMATS,
  KEEP_ORIGINAL,
  VIDEO_FORMATS,
  parseFormat,
  planConversion,
  targetFormatFor,
  type SourceProbe,
} from '../src/core/convert/formats.js';
import { UsageError } from '../src/core/errors.js';

describe('parseFormat', () => {
  it('accepts every supported format', () => {
    for (const format of AUDIO_FORMATS) {
      expect(parseFormat(format).audio, format).toBe(format);
    }
    for (const format of VIDEO_FORMATS) {
      expect(parseFormat(format).video, format).toBe(format);
    }
  });

  it('understands intent words', () => {
    expect(parseFormat('compatible')).toMatchObject({ audio: 'mp3', video: 'mp4' });
    expect(parseFormat('archive')).toMatchObject({ audio: 'flac', video: 'mkv' });
    expect(parseFormat('original')).toEqual(KEEP_ORIGINAL);
  });

  it('accepts common aliases', () => {
    expect(parseFormat('aac').audio).toBe('m4a');
    expect(parseFormat('matroska').video).toBe('mkv');
    expect(parseFormat('PHONE').audio).toBe('mp3');
  });

  it('rejects nonsense with a helpful hint', () => {
    expect(() => parseFormat('mp5')).toThrow(UsageError);
    try {
      parseFormat('mp5');
    } catch (error) {
      expect((error as UsageError).hint).toMatch(/Audio: mp3/);
    }
  });
});

describe('targetFormatFor', () => {
  const audioProbe: SourceProbe = {
    extension: 'm4a',
    audioCodec: 'aac',
    videoCodec: undefined,
    audioBitrate: 128_000,
  };
  const videoProbe: SourceProbe = { ...audioProbe, extension: 'mp4', videoCodec: 'h264' };

  it('picks the audio target for audio sources', () => {
    expect(targetFormatFor(parseFormat('compatible'), audioProbe)).toBe('mp3');
  });

  it('picks the video target for video sources', () => {
    expect(targetFormatFor(parseFormat('compatible'), videoProbe)).toBe('mp4');
  });

  it('returns undefined when the intent has no target for that kind', () => {
    expect(targetFormatFor(parseFormat('flac'), videoProbe)).toBeUndefined();
  });
});

describe('planConversion', () => {
  const probe = (over: Partial<SourceProbe> = {}): SourceProbe => ({
    extension: 'm4a',
    audioCodec: 'aac',
    videoCodec: undefined,
    audioBitrate: 128_000,
    ...over,
  });

  it('does nothing when the file is already the target', () => {
    expect(planConversion(probe(), 'm4a').action).toBe('none');
  });

  it('remuxes when the codec already fits the target container', () => {
    const plan = planConversion(probe(), 'mp4');
    expect(plan.action).toBe('remux');
    expect(plan.args).toContain('copy');
    expect(plan.warning).toBeUndefined();
  });

  it('remuxes opus into ogg without re-encoding', () => {
    const plan = planConversion(probe({ extension: 'webm', audioCodec: 'opus' }), 'ogg');
    expect(plan.action).toBe('remux');
  });

  it('transcodes when the codec cannot live in the target container', () => {
    const plan = planConversion(probe(), 'mp3');
    expect(plan.action).toBe('transcode');
    expect(plan.args).toContain('libmp3lame');
  });

  it('carries the source bitrate into a lossy re-encode', () => {
    const plan = planConversion(probe({ audioBitrate: 192_000 }), 'mp3');
    expect(plan.args).toContain('192k');
  });

  it('warns that a lossy re-encode costs quality', () => {
    expect(planConversion(probe(), 'mp3').warning).toMatch(/loses some quality/i);
  });

  it('warns that lossless from a lossy source recovers nothing', () => {
    const plan = planConversion(probe(), 'flac');
    expect(plan.warning).toMatch(/without recovering quality/i);
  });

  it('does not warn when the source is genuinely lossless', () => {
    const plan = planConversion(probe({ extension: 'wav', audioCodec: 'pcm_s16le' }), 'flac');
    expect(plan.warning).toBeUndefined();
  });

  it('copies video and re-encodes only audio when only the audio is incompatible', () => {
    const plan = planConversion(probe({ extension: 'mkv', audioCodec: 'flac', videoCodec: 'h264' }), 'mp4');
    expect(plan.args.join(' ')).toContain('-c:v copy');
    expect(plan.args.join(' ')).toContain('-c:a aac');
  });

  it('drops the video stream for audio-only targets', () => {
    expect(planConversion(probe({ extension: 'mp4', videoCodec: 'h264' }), 'mp3').args).toContain('-vn');
  });

  it('asks for faststart on mp4 output', () => {
    expect(planConversion(probe(), 'mp4').args).not.toContain('-movflags');
    expect(planConversion(probe({ audioCodec: 'flac' }), 'mp4').args).toContain('-movflags');
  });
});
