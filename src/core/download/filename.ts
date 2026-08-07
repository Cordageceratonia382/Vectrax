import path from 'node:path';

const WINDOWS_RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

const ILLEGAL = /[<>:"/\\|?*\u0000-\u001F\u007F]/g;

const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

const MAX_BYTES = 180;

const encoder = new TextEncoder();

export function sanitizeFilename(input: string, fallback = 'download'): string {
  let name = path.basename(input.replace(/[\\/]+/g, '/'));

  name = name
    .replace(INVISIBLE, '')
    .replace(ILLEGAL, '_')
    .replace(/\s+/g, ' ')
    .trim();

  name = name.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');

  if (name === '') return fallback;

  const ext = path.extname(name);
  const stem = path.basename(name, ext);

  if (stem === '' || WINDOWS_RESERVED.has(stem.toLowerCase())) {
    return clampBytes(`${fallback}${ext}`, ext);
  }
  return clampBytes(name, ext);
}

function clampBytes(name: string, ext: string): string {
  if (encoder.encode(name).length <= MAX_BYTES) return name;
  const extBytes = encoder.encode(ext).length;
  const budget = Math.max(1, MAX_BYTES - extBytes);
  const stem = path.basename(name, ext);
  let out = '';
  let used = 0;
  for (const char of stem) {
    const size = encoder.encode(char).length;
    if (used + size > budget) break;
    out += char;
    used += size;
  }
  return `${out.trimEnd() || 'download'}${ext}`;
}

const KNOWN_EXTENSIONS = new Set([
  '.mp3', '.m4a', '.aac', '.wav', '.flac', '.ogg', '.oga', '.opus', '.wma', '.alac', '.aiff',
  '.mp4', '.m4v', '.mkv', '.webm', '.mov', '.avi',
  '.pdf', '.zip', '.rar', '.7z', '.tar', '.gz',
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg',
]);

const MIME_EXTENSIONS: Record<string, string> = {
  'audio/mpeg': '.mp3',
  'audio/mp3': '.mp3',
  'audio/mp4': '.m4a',
  'audio/aac': '.aac',
  'audio/x-m4a': '.m4a',
  'audio/flac': '.flac',
  'audio/x-flac': '.flac',
  'audio/ogg': '.ogg',
  'audio/opus': '.opus',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/x-matroska': '.mkv',
  'video/quicktime': '.mov',
  'application/pdf': '.pdf',
  'application/zip': '.zip',
};

export function extensionFromUrl(url: URL): string | undefined {
  const ext = path.extname(decodeSafe(url.pathname)).toLowerCase();
  return KNOWN_EXTENSIONS.has(ext) ? ext : undefined;
}

export function extensionFromContentType(contentType: string | null | undefined): string | undefined {
  if (contentType === null || contentType === undefined) return undefined;
  const mime = contentType.split(';')[0]?.trim().toLowerCase();
  return mime !== undefined ? MIME_EXTENSIONS[mime] : undefined;
}

export function filenameFromContentDisposition(header: string | null | undefined): string | undefined {
  if (header === null || header === undefined) return undefined;

  const extended = /filename\*\s*=\s*([^;]+)/i.exec(header);
  if (extended?.[1] !== undefined) {
    const value = extended[1].trim();
    const match = /^([\w-]*)'([\w-]*)'(.*)$/.exec(value);
    const raw = match?.[3] ?? value;
    const decoded = decodeSafe(raw);
    const clean = sanitizeFilename(decoded, '');
    if (clean !== '') return clean;
  }

  const plain = /filename\s*=\s*("([^"]*)"|[^;]+)/i.exec(header);
  const candidate = plain?.[2] ?? plain?.[1];
  if (candidate !== undefined) {
    const clean = sanitizeFilename(candidate.trim(), '');
    if (clean !== '') return clean;
  }
  return undefined;
}

function decodeSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function titleFromUrl(url: URL): string | undefined {
  const segment = decodeSafe(url.pathname).split('/').filter(Boolean).pop();
  if (segment === undefined) return undefined;
  const stem = path.basename(segment, path.extname(segment));
  const pretty = stem.replace(/[_+]+/g, ' ').replace(/\s+/g, ' ').trim();
  return pretty.length >= 2 ? pretty : undefined;
}

export function buildFilename(options: {
  title?: string | undefined;
  url: URL;
  contentDisposition?: string | null | undefined;
  contentType?: string | null | undefined;
  defaultExtension?: string | undefined;
}): string {
  const fromHeader = filenameFromContentDisposition(options.contentDisposition);
  if (fromHeader !== undefined && path.extname(fromHeader) !== '') return fromHeader;

  const stem = sanitizeFilename(
    options.title ?? fromHeader ?? titleFromUrl(options.url) ?? 'download',
    'download',
  );
  const existingExt = path.extname(stem).toLowerCase();
  if (KNOWN_EXTENSIONS.has(existingExt)) return stem;

  const ext =
    extensionFromUrl(options.url) ??
    extensionFromContentType(options.contentType) ??
    options.defaultExtension ??
    '';

  return sanitizeFilename(`${stem}${ext}`, 'download');
}
