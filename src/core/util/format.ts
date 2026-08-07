import stringWidth from 'string-width';

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const;

export function formatBytes(bytes: number, fractionDigits?: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), BYTE_UNITS.length - 1);
  const value = bytes / 1024 ** exponent;
  const digits = fractionDigits ?? (exponent === 0 ? 0 : value >= 100 ? 0 : value >= 10 ? 1 : 2);
  return `${value.toFixed(digits)} ${BYTE_UNITS[exponent]}`;
}

export function formatRate(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '—';
  return `${formatBytes(bytesPerSecond)}/s`;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
}

export function formatEta(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return '--:--';
  const totalSeconds = Math.min(Math.round(ms / 1000), 99 * 3600);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return hours > 0 ? `${pad(hours)}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

export function formatPercent(ratio: number): string {
  if (!Number.isFinite(ratio)) return '  0%';
  return `${String(Math.min(100, Math.max(0, Math.round(ratio * 100)))).padStart(3, ' ')}%`;
}

export const displayWidth = (text: string): number => stringWidth(text);

export function truncate(text: string, maxWidth: number, ellipsis = '…'): string {
  if (maxWidth <= 0) return '';
  if (displayWidth(text) <= maxWidth) return text;
  const budget = Math.max(0, maxWidth - displayWidth(ellipsis));
  let width = 0;
  let out = '';
  for (const char of text) {
    const charWidth = displayWidth(char);
    if (width + charWidth > budget) break;
    width += charWidth;
    out += char;
  }
  return out + ellipsis;
}

export function padEnd(text: string, width: number): string {
  const delta = width - displayWidth(text);
  return delta > 0 ? text + ' '.repeat(delta) : text;
}

export function padStart(text: string, width: number): string {
  const delta = width - displayWidth(text);
  return delta > 0 ? ' '.repeat(delta) + text : text;
}

export function renderBar(
  ratio: number,
  width: number,
  glyphs: { full: string; partial: readonly string[]; empty: string },
): string {
  const clamped = Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0;
  const exact = clamped * width;
  const full = Math.floor(exact);
  const remainder = exact - full;
  const partialIndex = Math.floor(remainder * glyphs.partial.length);
  const partial = full < width ? (glyphs.partial[partialIndex] ?? '') : '';
  const filled = glyphs.full.repeat(full) + partial;
  const emptyCount = Math.max(0, width - full - displayWidth(partial));
  return filled + glyphs.empty.repeat(emptyCount);
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
