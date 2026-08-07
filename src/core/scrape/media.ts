export const MEDIA_KINDS = ['audio', 'video', 'image', 'archive', 'document', 'other'] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

const EXTENSIONS_BY_KIND: Record<Exclude<MediaKind, 'other'>, readonly string[]> = {
  audio: ['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'oga', 'opus', 'wma', 'alac', 'aiff', 'aif'],
  video: ['mp4', 'm4v', 'mkv', 'webm', 'mov', 'avi', 'flv', 'wmv', 'ts'],
  image: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'svg', 'bmp'],
  archive: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz'],
  document: ['pdf', 'epub', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'srt', 'vtt'],
};

const KIND_BY_EXTENSION = new Map<string, MediaKind>(
  Object.entries(EXTENSIONS_BY_KIND).flatMap(([kind, extensions]) =>
    extensions.map((ext) => [ext, kind as MediaKind] as const),
  ),
);

export function extensionsForKinds(kinds: readonly MediaKind[]): string[] {
  const out = new Set<string>();
  for (const kind of kinds) {
    if (kind === 'other') continue;
    for (const ext of EXTENSIONS_BY_KIND[kind]) out.add(ext);
  }
  return [...out];
}

export function kindForExtension(extension: string | undefined): MediaKind {
  if (extension === undefined) return 'other';
  return KIND_BY_EXTENSION.get(extension.replace(/^\./, '').toLowerCase()) ?? 'other';
}

export type MediaSource = 'anchor' | 'media-tag' | 'embedded-json' | 'raw-scan' | 'direct';

export interface MediaCandidate {
  readonly url: string;
  readonly title: string;
  readonly kind: MediaKind;
  readonly extension: string | undefined;
  readonly quality: string | undefined;
  readonly source: MediaSource;
}

const QUALITY_PATTERNS: readonly { pattern: RegExp; format: (match: RegExpExecArray) => string }[] = [
  { pattern: /\b(\d{3,4})\s?kbps\b/i, format: (m) => `${m[1]}kbps` },
  { pattern: /\b(2160|1440|1080|720|480|360)p\b/i, format: (m) => `${m[1]}p` },
  { pattern: /\b(4k|8k)\b/i, format: (m) => (m[1] as string).toUpperCase() },
  { pattern: /\b(flac|hi-?res|lossless)\b/i, format: (m) => (m[1] as string).toUpperCase() },
  { pattern: /(?:^|[^\d])(320|256|192|128|96|64)(?:[^\d]|$)/, format: (m) => `${m[1]}kbps` },
];

export function describeFormat(item: Pick<MediaCandidate, 'quality' | 'extension'>): string {
  const extension = item.extension?.toUpperCase();
  if (item.quality === undefined) return extension ?? '';
  if (extension === undefined) return item.quality;
  return item.quality.toUpperCase() === extension ? extension : `${item.quality} ${extension}`;
}

export function detectQuality(...sources: (string | undefined)[]): string | undefined {
  for (const source of sources) {
    if (source === undefined || source === '') continue;
    for (const { pattern, format } of QUALITY_PATTERNS) {
      const match = pattern.exec(source);
      if (match !== null) return format(match);
    }
  }
  return undefined;
}
