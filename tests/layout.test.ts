import { execFile } from 'node:child_process';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { breakpointFor, fit, planColumns, usableColumns, usableRows, wrap } from '../src/ui/layout.js';
import { DownloadDashboard } from '../src/ui/progress.js';
import { Logger } from '../src/ui/logger.js';
import { stripAnsi } from '../src/ui/theme.js';
import { contaminate, condense, driftField, reactionEdge, seedEntropy } from '../src/ui/chemistry.js';
import { playBannerReaction, renderBanner } from '../src/ui/banner.js';
import { displayWidth } from '../src/core/util/format.js';
import type { TaskSnapshot } from '../src/core/download/types.js';

function fakeStream(columns: number, rows = 24, isTTY = true): NodeJS.WriteStream {
  const stream = new PassThrough() as unknown as NodeJS.WriteStream & { output: string };
  stream.output = '';
  const original = stream.write.bind(stream);
  stream.write = ((chunk: string) => {
    stream.output += String(chunk);
    return original(chunk as never);
  }) as NodeJS.WriteStream['write'];
  Object.defineProperty(stream, 'isTTY', { value: isTTY });
  Object.defineProperty(stream, 'columns', { value: columns });
  Object.defineProperty(stream, 'rows', { value: rows });
  return stream;
}

const read = (stream: NodeJS.WriteStream): string => (stream as unknown as { output: string }).output;

const stripEscapes = (text: string): string => text.replace(/\u001B\[[0-9;?]*[A-Za-z]/g, '');

describe('breakpoints', () => {
  it('classifies terminal widths', () => {
    expect(breakpointFor(30)).toBe('micro');
    expect(breakpointFor(60)).toBe('compact');
    expect(breakpointFor(90)).toBe('normal');
    expect(breakpointFor(200)).toBe('wide');
  });

  it('treats a zero-size terminal as unknown', () => {
    expect(usableColumns(fakeStream(0))).toBe(80);
    expect(usableRows(fakeStream(80, 0))).toBe(24);
  });
});

describe('planColumns', () => {
  it('drops detail as the terminal narrows', () => {
    const wide = planColumns(200);
    const normal = planColumns(90);
    const compact = planColumns(60);
    const micro = planColumns(32);

    expect(wide.showRate && wide.showEta && wide.showStats).toBe(true);
    expect(normal.showStats).toBe(true);
    expect(normal.showEta).toBe(false);
    expect(compact.showStats).toBe(false);
    expect(compact.bar).toBeGreaterThan(0);
    expect(micro.bar).toBe(0);
  });

  it('always leaves room for a title', () => {
    for (const columns of [20, 32, 46, 80, 120, 240]) {
      expect(planColumns(columns).title, `${columns}`).toBeGreaterThanOrEqual(8);
    }
  });
});

describe('wrap', () => {
  it('reflows rather than truncating', () => {
    const lines = wrap('the quick brown fox jumps over the lazy dog', 12);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(12);
    expect(lines.join(' ')).toBe('the quick brown fox jumps over the lazy dog');
  });

  it('breaks a word that cannot fit', () => {
    const [line] = wrap('supercalifragilistic', 8);
    expect(displayWidth(line ?? '')).toBeLessThanOrEqual(8);
  });

  it('preserves explicit newlines', () => {
    expect(wrap('a\nb', 20)).toEqual(['a', 'b']);
  });

  it('never returns an empty array', () => {
    expect(wrap('', 10)).toEqual(['']);
  });
});

describe('fit', () => {
  it('pads and clips to an exact width', () => {
    expect(displayWidth(fit('ab', 6))).toBe(6);
    expect(displayWidth(fit('abcdefghij', 6))).toBe(6);
  });
});

describe('dashboard rendering', () => {
  const snapshot = (over: Partial<TaskSnapshot> = {}): TaskSnapshot => ({
    id: '1',
    title: 'A Reasonably Long Track Title For Testing',
    state: 'downloading',
    received: 512_000,
    total: 1_024_000,
    speed: 250_000,
    etaMs: 2_000,
    resumedFrom: 0,
    attempt: 1,
    destination: '/tmp/x.mp3',
    error: undefined,
    ...over,
  });

  function frameAt(columns: number): string[] {
    const stderr = fakeStream(columns);
    const logger = new Logger({ stdout: fakeStream(columns, 24, false), stderr });
    const dashboard = new DownloadDashboard({ logger, total: 3 });
    dashboard.start();
    dashboard.handle(snapshot());
    dashboard.handle(snapshot({ id: '2', title: 'Second Track', state: 'probing' }));
    dashboard.stop();
    return stripAnsi(read(stderr))
      .split('\n')
      .filter((line) => line.trim() !== '');
  }

  it('never emits a line wider than the terminal', () => {
    for (const columns of [32, 46, 60, 80, 120, 200]) {
      for (const line of frameAt(columns)) {
        expect(displayWidth(line), `${columns}: ${line}`).toBeLessThanOrEqual(columns);
      }
    }
  });

  it('still shows progress in a very small terminal', () => {
    const text = frameAt(32).join('\n');
    expect(text).toMatch(/\d+%/);
    expect(text).toMatch(/0\/3|1\/3|2\/3|3\/3/);
  });

  it('shows rate and eta only when there is room', () => {
    expect(frameAt(200).join('\n')).toMatch(/\/s/);
    expect(frameAt(32).join('\n')).not.toMatch(/\/s/);
  });

  it('falls back to line-per-file output without a TTY', () => {
    const stderr = fakeStream(80, 24, false);
    const logger = new Logger({ stdout: fakeStream(80, 24, false), stderr });
    const dashboard = new DownloadDashboard({ logger, total: 1 });
    dashboard.start();
    dashboard.handle(snapshot({ state: 'completed', received: 1_024_000 }));
    dashboard.stop();

    const text = stripAnsi(read(stderr));
    expect(text).toContain('[1/1]');
    expect(text).toContain('A Reasonably Long Track Title');
  });
});

describe('banner responsiveness', () => {
  it('never exceeds the terminal width at any size', () => {
    for (const columns of [30, 40, 62, 80, 140]) {
      for (const line of stripAnsi(renderBanner({ version: '1.0.0', columns })).split('\n')) {
        expect(displayWidth(line), `${columns}`).toBeLessThanOrEqual(columns);
      }
    }
  });

  it('uses the full wordmark when it fits and a lockup when it does not', () => {
    expect(stripAnsi(renderBanner({ version: '1.0.0', columns: 100 }))).toContain('██╗');
    expect(stripAnsi(renderBanner({ version: '1.0.0', columns: 40 }))).toContain('VECTRAX');
    expect(stripAnsi(renderBanner({ version: '1.0.0', columns: 40 }))).not.toContain('██╗');
  });
});

describe('chemistry', () => {
  it('leaves text untouched at zero intensity', () => {
    expect(contaminate('VECTRAX', 0)).toBe('VECTRAX');
  });

  it('corrupts text at full intensity but preserves spacing and length', () => {
    seedEntropy(7);
    const result = contaminate('VECTRAX CORE', 1);
    expect(result).not.toBe('VECTRAX CORE');
    expect(result).toHaveLength('VECTRAX CORE'.length);
    expect(result[7]).toBe(' ');
  });

  it('condenses toward the original as the reaction settles', () => {
    seedEntropy(11);
    expect(condense('VECTRAX', 1)).toBe('VECTRAX');
    seedEntropy(11);
    expect(condense('VECTRAX', 0)).not.toBe('VECTRAX');
  });

  it('produces a drift field of the requested width', () => {
    expect(driftField(24, 3)).toHaveLength(24);
  });

  it('cycles the reaction edge', () => {
    const frames = new Set([0, 1, 2, 3, 4, 5].map((phase) => reactionEdge(phase)));
    expect(frames.size).toBeGreaterThan(1);
  });
});

describe('banner reaction', () => {
  it('settles on the solid wordmark', async () => {
    const stream = fakeStream(80);
    await playBannerReaction({ version: '1.0.0', columns: 80, stream });

    const output = stripEscapes(read(stream));
    expect(output.trimEnd().endsWith('volatile media extraction')).toBe(true);

    const finalFrame = output.slice(output.lastIndexOf('██╗'));
    expect(finalFrame).toContain('╚═══╝');
    expect(finalFrame).not.toMatch(/[·˙∘°⁘⁙]/);
  });

  it('renders instantly when animation is disabled', async () => {
    const previous = process.env['VECTRAX_NO_ANIMATION'];
    process.env['VECTRAX_NO_ANIMATION'] = '1';
    try {
      const stream = fakeStream(80);
      await playBannerReaction({ version: '1.0.0', columns: 80, stream });
      expect(stripEscapes(read(stream))).toContain('██╗');
    } finally {
      if (previous === undefined) delete process.env['VECTRAX_NO_ANIMATION'];
      else process.env['VECTRAX_NO_ANIMATION'] = previous;
    }
  });

  it('keeps the event loop alive until the reaction finishes', async () => {
    const script = path.join(import.meta.dirname, 'helpers', 'banner-exit.ts');
    const { stderr } = await promisify(execFile)(
      process.execPath,
      ['--import', 'tsx', script],
      { env: { ...process.env, FORCE_COLOR: '0' }, timeout: 30_000 },
    );

    expect(stderr).toContain('SETTLED');
    expect(stderr).not.toContain('unsettled top-level await');
  });
});
