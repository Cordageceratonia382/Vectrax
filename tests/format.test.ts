import { describe, expect, it } from 'vitest';

import {
  formatBytes,
  formatDuration,
  formatEta,
  formatPercent,
  formatRate,
  renderBar,
  truncate,
  padEnd,
  pluralize,
} from '../src/core/util/format.js';

describe('formatBytes', () => {
  it('scales through binary units', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1.00 KB');
    expect(formatBytes(1536)).toBe('1.50 KB');
    expect(formatBytes(1024 ** 2 * 4.25)).toBe('4.25 MB');
    expect(formatBytes(1024 ** 3 * 250)).toBe('250 GB');
  });

  it('treats negative and non-finite input as zero', () => {
    expect(formatBytes(-1)).toBe('0 B');
    expect(formatBytes(Number.NaN)).toBe('0 B');
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('0 B');
  });
});

describe('formatRate', () => {
  it('marks an unknown rate rather than printing 0', () => {
    expect(formatRate(0)).toBe('—');
    expect(formatRate(Number.NaN)).toBe('—');
  });

  it('appends a per-second suffix', () => {
    expect(formatRate(1024 * 1024)).toBe('1.00 MB/s');
  });
});

describe('formatDuration', () => {
  it('switches units as the duration grows', () => {
    expect(formatDuration(1500)).toBe('1.5s');
    expect(formatDuration(45_000)).toBe('45s');
    expect(formatDuration(125_000)).toBe('2m 05s');
    expect(formatDuration(3_725_000)).toBe('1h 02m');
  });
});

describe('formatEta', () => {
  it('falls back to placeholders when the ETA is unknown', () => {
    expect(formatEta(undefined)).toBe('--:--');
    expect(formatEta(Number.POSITIVE_INFINITY)).toBe('--:--');
  });

  it('adds an hours field only when needed', () => {
    expect(formatEta(65_000)).toBe('01:05');
    expect(formatEta(3_665_000)).toBe('01:01:05');
  });
});

describe('formatPercent', () => {
  it('clamps and right-aligns', () => {
    expect(formatPercent(0)).toBe('  0%');
    expect(formatPercent(0.5)).toBe(' 50%');
    expect(formatPercent(1)).toBe('100%');
    expect(formatPercent(2)).toBe('100%');
    expect(formatPercent(-1)).toBe('  0%');
  });
});

describe('renderBar', () => {
  const glyphs = { full: '#', partial: [''], empty: '-' };

  it('fills proportionally', () => {
    expect(renderBar(0, 10, glyphs)).toBe('----------');
    expect(renderBar(1, 10, glyphs)).toBe('##########');
    expect(renderBar(0.5, 10, glyphs)).toBe('#####-----');
  });

  it('always renders exactly `width` cells', () => {
    for (const ratio of [0, 0.13, 0.5, 0.777, 0.999, 1]) {
      expect(renderBar(ratio, 20, glyphs)).toHaveLength(20);
    }
  });

  it('treats non-finite ratios as empty', () => {
    expect(renderBar(Number.NaN, 5, glyphs)).toBe('-----');
  });
});

describe('truncate', () => {
  it('leaves short strings untouched', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  it('appends an ellipsis when clipping', () => {
    expect(truncate('abcdefghij', 5)).toBe('abcd…');
  });

  it('measures wide glyphs as two columns', () => {
    expect(truncate('日本語テスト', 6).length).toBeLessThan(6);
  });

  it('does not split surrogate pairs', () => {
    const result = truncate('👍👍👍👍', 5);
    expect([...result].every((char) => char.codePointAt(0) !== 0xfffd)).toBe(true);
  });
});

describe('padEnd', () => {
  it('pads to a display width and never truncates', () => {
    expect(padEnd('ab', 5)).toBe('ab   ');
    expect(padEnd('abcdef', 3)).toBe('abcdef');
  });
});

describe('pluralize', () => {
  it('agrees with the count', () => {
    expect(pluralize(1, 'file')).toBe('1 file');
    expect(pluralize(0, 'file')).toBe('0 files');
    expect(pluralize(3, 'file')).toBe('3 files');
  });
});
