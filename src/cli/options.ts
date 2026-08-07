import { UsageError } from '../core/errors.js';
import { MEDIA_KINDS, type MediaKind } from '../core/scrape/media.js';

export function parseInteger(flag: string, value: string, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new UsageError(`${flag} must be an integer between ${min} and ${max} (got "${value}").`);
  }
  return parsed;
}

export function collect(value: string, previous: string[] = []): string[] {
  return [...previous, ...value.split(',').map((v) => v.trim()).filter(Boolean)];
}

export function parseKinds(values: readonly string[]): MediaKind[] {
  const out: MediaKind[] = [];
  for (const value of values) {
    const kind = value.toLowerCase();
    if (!(MEDIA_KINDS as readonly string[]).includes(kind)) {
      throw new UsageError(`Unknown media kind "${value}".`, {
        hint: `Valid kinds: ${MEDIA_KINDS.join(', ')}.`,
      });
    }
    if (!out.includes(kind as MediaKind)) out.push(kind as MediaKind);
  }
  return out;
}

export function parseExtensions(values: readonly string[]): string[] {
  return [...new Set(values.map((v) => v.replace(/^[.*]+/, '').toLowerCase()).filter(Boolean))];
}

export function parseRegex(flag: string, value: string): RegExp {
  try {
    return new RegExp(value, 'i');
  } catch (error) {
    throw new UsageError(`${flag} is not a valid regular expression: ${value}`, { cause: error });
  }
}

export function parseSelection(expression: string, total: number): number[] {
  const trimmed = expression.trim().toLowerCase();
  if (trimmed === '' ) {
    throw new UsageError('--select was empty.', { hint: 'Try --select 1,3,5-8 or --all.' });
  }
  if (trimmed === 'all' || trimmed === '*') {
    return Array.from({ length: total }, (_, index) => index);
  }

  const indices = new Set<number>();
  for (const token of trimmed.split(/[\s,]+/).filter(Boolean)) {
    const range = /^(\d+)\s*(?:-|\.\.)\s*(\d+)$/.exec(token);
    if (range !== null) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      assertInRange(start, total, token);
      assertInRange(end, total, token);
      const [low, high] = start <= end ? [start, end] : [end, start];
      for (let n = low; n <= high; n++) indices.add(n - 1);
      continue;
    }
    if (!/^\d+$/.test(token)) {
      throw new UsageError(`Invalid selection token "${token}".`, {
        hint: 'Use numbers and ranges, e.g. --select 1,3,5-8.',
      });
    }
    assertInRange(Number(token), total, token);
    indices.add(Number(token) - 1);
  }

  return [...indices].sort((a, b) => a - b);
}

function assertInRange(value: number, total: number, token: string): void {
  if (value < 1 || value > total) {
    throw new UsageError(`Selection "${token}" is out of range (1–${total}).`);
  }
}

export function resolveReferer(policy: string, pageUrl: URL | undefined): string | undefined {
  if (policy === 'none' || policy === '') return undefined;
  if (policy === 'auto') return pageUrl?.href;
  return policy;
}

