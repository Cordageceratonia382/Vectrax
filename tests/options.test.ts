import { describe, expect, it } from 'vitest';

import { UsageError } from '../src/core/errors.js';
import {
  parseExtensions,
  parseInteger,
  parseKinds,
  parseSelection,
  resolveReferer,
} from '../src/cli/options.js';

describe('parseSelection', () => {
  it('expands "all"', () => {
    expect(parseSelection('all', 3)).toEqual([0, 1, 2]);
    expect(parseSelection('*', 2)).toEqual([0, 1]);
  });

  it('parses comma- and space-separated indices', () => {
    expect(parseSelection('1,3,5', 5)).toEqual([0, 2, 4]);
    expect(parseSelection('1 3 5', 5)).toEqual([0, 2, 4]);
  });

  it('expands inclusive ranges', () => {
    expect(parseSelection('2-5', 6)).toEqual([1, 2, 3, 4]);
    expect(parseSelection('2..4', 6)).toEqual([1, 2, 3]);
  });

  it('accepts a descending range', () => {
    expect(parseSelection('5-2', 6)).toEqual([1, 2, 3, 4]);
  });

  it('de-duplicates and sorts', () => {
    expect(parseSelection('5,1,1,2-3', 5)).toEqual([0, 1, 2, 4]);
  });

  it('rejects out-of-range values rather than silently dropping them', () => {
    expect(() => parseSelection('1,9', 5)).toThrow(UsageError);
    expect(() => parseSelection('0', 5)).toThrow(/out of range/);
    expect(() => parseSelection('3-9', 5)).toThrow(/out of range/);
  });

  it('rejects garbage tokens', () => {
    expect(() => parseSelection('abc', 5)).toThrow(/Invalid selection token/);
    expect(() => parseSelection('', 5)).toThrow(UsageError);
  });
});

describe('parseInteger', () => {
  it('accepts values inside the range', () => {
    expect(parseInteger('--concurrency', '4', 1, 16)).toBe(4);
  });

  it('rejects out-of-range, fractional, and non-numeric values', () => {
    expect(() => parseInteger('--concurrency', '0', 1, 16)).toThrow(UsageError);
    expect(() => parseInteger('--concurrency', '17', 1, 16)).toThrow(/between 1 and 16/);
    expect(() => parseInteger('--concurrency', '2.5', 1, 16)).toThrow(UsageError);
    expect(() => parseInteger('--concurrency', 'many', 1, 16)).toThrow(UsageError);
  });
});

describe('parseKinds', () => {
  it('normalises case and de-duplicates', () => {
    expect(parseKinds(['Audio', 'audio', 'VIDEO'])).toEqual(['audio', 'video']);
  });

  it('rejects unknown kinds with a hint', () => {
    expect(() => parseKinds(['music'])).toThrow(/Unknown media kind/);
  });
});

describe('parseExtensions', () => {
  it('strips dots, lowercases, and de-duplicates', () => {
    expect(parseExtensions(['.MP3', 'mp3', '*.flac'])).toEqual(['mp3', 'flac']);
  });
});

describe('resolveReferer', () => {
  const page = new URL('https://site.test/album/1');

  it('uses the page URL in auto mode', () => {
    expect(resolveReferer('auto', page)).toBe('https://site.test/album/1');
  });

  it('sends nothing for "none"', () => {
    expect(resolveReferer('none', page)).toBeUndefined();
  });

  it('passes an explicit value through', () => {
    expect(resolveReferer('https://other.test/', page)).toBe('https://other.test/');
  });

  it('yields undefined in auto mode with no page', () => {
    expect(resolveReferer('auto', undefined)).toBeUndefined();
  });
});
