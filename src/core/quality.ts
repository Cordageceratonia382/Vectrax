import { UsageError } from './errors.js';

export type MediaIntent = 'audio' | 'video' | 'auto';

export const QUALITY_PRESETS = ['best', 'high', 'balanced', 'small'] as const;
export type QualityPreset = (typeof QUALITY_PRESETS)[number];

export const MAX = 'max' as const;
export type Target = number | typeof MAX;

export interface QualityTargets {
  readonly preset: QualityPreset;
  readonly audioKbps: Target;
  readonly videoHeight: Target;
}

const PRESET_TARGETS: Record<QualityPreset, { audioKbps: Target; videoHeight: Target }> = {
  best: { audioKbps: MAX, videoHeight: MAX },
  high: { audioKbps: 320, videoHeight: 1080 },
  balanced: { audioKbps: 256, videoHeight: 720 },
  small: { audioKbps: 128, videoHeight: 480 },
};

export const DEFAULT_QUALITY: QualityTargets = { preset: 'balanced', ...PRESET_TARGETS.balanced };

const PRESET_ALIASES: Record<string, QualityPreset> = {
  best: 'best',
  max: 'best',
  highest: 'best',
  lossless: 'best',
  high: 'high',
  hq: 'high',
  balanced: 'balanced',
  default: 'balanced',
  medium: 'balanced',
  small: 'small',
  low: 'small',
  tiny: 'small',
  data: 'small',
};

const AUDIO_BITRATE = /^(\d{2,4})\s*k(bps)?$/i;
const VIDEO_HEIGHT = /^(\d{3,4})\s*p$/i;
const SHORTHAND_4K = /^(4k|2160)$/i;
const SHORTHAND_2K = /^(2k|1440)$/i;

export function parseQuality(input: string): QualityTargets {
  const value = input.trim().toLowerCase();

  const preset = PRESET_ALIASES[value];
  if (preset !== undefined) return { preset, ...PRESET_TARGETS[preset] };

  if (SHORTHAND_4K.test(value)) return { preset: 'best', audioKbps: MAX, videoHeight: 2160 };
  if (SHORTHAND_2K.test(value)) return { preset: 'high', audioKbps: MAX, videoHeight: 1440 };

  const audio = AUDIO_BITRATE.exec(value);
  if (audio?.[1] !== undefined) {
    const kbps = Number(audio[1]);
    if (kbps < 8 || kbps > 3000) {
      throw new UsageError(`Audio bitrate ${kbps}k is outside the usable range (8k–3000k).`);
    }
    return { preset: presetForBitrate(kbps), audioKbps: kbps, videoHeight: MAX };
  }

  const video = VIDEO_HEIGHT.exec(value);
  if (video?.[1] !== undefined) {
    const height = Number(video[1]);
    if (height < 144 || height > 4320) {
      throw new UsageError(`Video height ${height}p is outside the usable range (144p–4320p).`);
    }
    return { preset: presetForHeight(height), audioKbps: MAX, videoHeight: height };
  }

  throw new UsageError(`Unrecognised quality "${input}".`, {
    hint: 'Use best, high, balanced, small — or an exact target like 320k or 1080p.',
  });
}

function presetForBitrate(kbps: number): QualityPreset {
  if (kbps >= 320) return 'high';
  if (kbps >= 192) return 'balanced';
  return 'small';
}

function presetForHeight(height: number): QualityPreset {
  if (height >= 1440) return 'best';
  if (height >= 1080) return 'high';
  if (height >= 720) return 'balanced';
  return 'small';
}

export interface QualityChoice<T> {
  readonly item: T;
  readonly value: number;
  readonly target: Target;
  readonly satisfied: boolean;
  readonly bestAvailable: number;
}

export function chooseByCeiling<T>(
  items: readonly T[],
  valueOf: (item: T) => number,
  target: Target,
  overshoot = 1,
): QualityChoice<T> | undefined {
  if (items.length === 0) return undefined;

  const ranked = [...items].sort((a, b) => valueOf(b) - valueOf(a));
  const bestAvailable = valueOf(ranked[0] as T);

  if (target === MAX) {
    return { item: ranked[0] as T, value: bestAvailable, target, satisfied: true, bestAvailable };
  }

  const admissible = ranked.filter((item) => valueOf(item) <= target * overshoot);
  if (admissible.length === 0) {
    const smallest = ranked[ranked.length - 1] as T;
    return { item: smallest, value: valueOf(smallest), target, satisfied: false, bestAvailable };
  }

  const distance = (item: T): number => Math.abs(Math.log(Math.max(valueOf(item), 1) / target));
  const nearest = admissible.reduce((best, item) => (distance(item) < distance(best) ? item : best));

  return {
    item: nearest,
    value: valueOf(nearest),
    target,
    satisfied: valueOf(nearest) <= target || overshoot > 1,
    bestAvailable,
  };
}

export function describeShortfall(
  choice: QualityChoice<unknown>,
  unit: 'kbps' | 'p',
  source: string,
): string | undefined {
  if (choice.target === MAX) return undefined;

  if (!choice.satisfied) {
    return `${source} offers nothing at or below ${choice.target}${unit}; using ${choice.value}${unit}.`;
  }
  if (choice.bestAvailable > choice.target && choice.value < choice.bestAvailable) {
    return undefined;
  }
  if (choice.value < choice.target && choice.bestAvailable <= choice.target) {
    return `${source} tops out at ${choice.bestAvailable}${unit}.`;
  }
  return undefined;
}

const TITLE_KEY = /[^\p{L}\p{N}]+/gu;

function titleKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/\b\d{2,4}\s*k(bps)?\b/g, '')
    .replace(/\b\d{3,4}\s*p\b/g, '')
    .replace(TITLE_KEY, '')
    .trim();
}

export interface QualityRanked {
  readonly title: string;
  readonly quality?: string | undefined;
  readonly extension?: string | undefined;
}

export function qualityValue(item: QualityRanked): number | undefined {
  const marker = item.quality;
  if (marker === undefined) return undefined;
  const kbps = /^(\d{2,4})kbps$/i.exec(marker);
  if (kbps?.[1] !== undefined) return Number(kbps[1]);
  const height = /^(\d{3,4})p$/i.exec(marker);
  if (height?.[1] !== undefined) return Number(height[1]);
  if (/^(flac|lossless|hi-?res)$/i.test(marker)) return 1411;
  if (/^4K$/i.test(marker)) return 2160;
  return undefined;
}

export function collapseDuplicateQualities<T extends QualityRanked>(
  items: readonly T[],
  targets: QualityTargets,
): { kept: T[]; collapsed: number } {
  const groups = new Map<string, T[]>();

  for (const item of items) {
    const key = `${titleKey(item.title)}::${item.extension ?? ''}`;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }

  const kept: T[] = [];
  let collapsed = 0;

  for (const group of groups.values()) {
    if (group.length === 1 || group.some((item) => qualityValue(item) === undefined)) {
      kept.push(...group);
      continue;
    }
    const isVideo = group.every((item) => (qualityValue(item) ?? 0) >= 144 && /p$/i.test(item.quality ?? ''));
    const target = isVideo ? targets.videoHeight : targets.audioKbps;
    const choice = chooseByCeiling(group, (item) => qualityValue(item) ?? 0, target);
    if (choice === undefined) {
      kept.push(...group);
      continue;
    }
    kept.push(choice.item);
    collapsed += group.length - 1;
  }

  const order = new Map(items.map((item, index) => [item, index]));
  kept.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  return { kept, collapsed };
}
