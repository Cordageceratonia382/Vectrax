import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { renderBanner, shouldShowBanner } from '../src/ui/banner.js';
import { Logger } from '../src/ui/logger.js';
import { stripAnsi } from '../src/ui/theme.js';
import { VERSION } from '../src/version.js';

function fakeStream(options: { isTTY: boolean; columns?: number }): NodeJS.WriteStream {
  const stream = new PassThrough() as unknown as NodeJS.WriteStream & { output: string };
  stream.output = '';
  const original = stream.write.bind(stream);
  stream.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    stream.output += String(chunk);
    return original(chunk as never, ...(rest as []));
  }) as NodeJS.WriteStream['write'];
  Object.defineProperty(stream, 'isTTY', { value: options.isTTY });
  Object.defineProperty(stream, 'columns', { value: options.columns ?? 80 });
  return stream;
}

const read = (stream: NodeJS.WriteStream): string => (stream as unknown as { output: string }).output;

describe('stripAnsi', () => {
  it('removes SGR sequences and keeps the text', () => {
    expect(stripAnsi('\u001B[38;2;168;85;247mviolet\u001B[0m')).toBe('violet');
    expect(stripAnsi('\u001B[1mbold\u001B[0m and \u001B[2mdim\u001B[0m')).toBe('bold and dim');
  });

  it('leaves unstyled text untouched', () => {
    expect(stripAnsi('plain text')).toBe('plain text');
  });
});

describe('renderBanner', () => {
  it('renders the full wordmark when there is room', () => {
    const banner = stripAnsi(renderBanner({ version: '1.2.3', columns: 100 }));
    expect(banner).toContain('██╗');
    expect(banner).toContain('v1.2.3');
    expect(banner).toContain('volatile media extraction');
  });

  it('falls back to a compact lockup on a narrow terminal', () => {
    const banner = stripAnsi(renderBanner({ version: '1.2.3', columns: 40 }));
    expect(banner).toContain('VECTRAX');
    expect(banner).not.toContain('██╗');
  });

  it('never emits a line wider than the terminal', () => {
    for (const columns of [40, 62, 80, 120]) {
      const lines = stripAnsi(renderBanner({ version: VERSION, columns })).split('\n');
      for (const line of lines) expect(line.length).toBeLessThanOrEqual(columns);
    }
  });

  it('treats a zero-width terminal as unknown rather than as "no room"', () => {
    expect(stripAnsi(renderBanner({ version: '1.0.0', columns: 0 }))).toContain('██╗');
  });
});

describe('shouldShowBanner', () => {
  const tty = fakeStream({ isTTY: true });
  const pipe = fakeStream({ isTTY: false });
  const base = { json: false, quiet: false, noBanner: false };

  it('shows on a terminal', () => {
    expect(shouldShowBanner({ ...base, stream: tty })).toBe(true);
  });

  it('hides when the target stream is not a terminal', () => {
    expect(shouldShowBanner({ ...base, stream: pipe })).toBe(false);
  });

  it('hides for --json, --quiet, and --no-banner', () => {
    expect(shouldShowBanner({ ...base, json: true, stream: tty })).toBe(false);
    expect(shouldShowBanner({ ...base, quiet: true, stream: tty })).toBe(false);
    expect(shouldShowBanner({ ...base, noBanner: true, stream: tty })).toBe(false);
  });
});

describe('Logger', () => {
  it('sends results to stdout and diagnostics to stderr', () => {
    const stdout = fakeStream({ isTTY: false });
    const stderr = fakeStream({ isTTY: false });
    const logger = new Logger({ stdout, stderr });

    logger.result('the answer');
    logger.info('working on it');

    expect(read(stdout)).toBe('the answer\n');
    expect(read(stderr)).toContain('working on it');
    expect(read(stdout)).not.toContain('working on it');
  });

  it('strips styling from results when stdout is not a terminal', () => {
    const stdout = fakeStream({ isTTY: false });
    const logger = new Logger({ stdout, stderr: fakeStream({ isTTY: false }) });
    logger.result('\u001B[1mstyled\u001B[0m');
    expect(read(stdout)).toBe('styled\n');
  });

  it('keeps styling in results when stdout is a terminal', () => {
    const stdout = fakeStream({ isTTY: true });
    const logger = new Logger({ stdout, stderr: fakeStream({ isTTY: true }) });
    logger.result('\u001B[1mstyled\u001B[0m');
    expect(read(stdout)).toBe('\u001B[1mstyled\u001B[0m\n');
  });

  it('honours the level threshold', () => {
    const stderr = fakeStream({ isTTY: false });
    const logger = new Logger({ level: 'error', stdout: fakeStream({ isTTY: false }), stderr });

    logger.debug('debug');
    logger.info('info');
    logger.warn('warn');
    logger.error('error');

    const output = read(stderr);
    expect(output).not.toContain('debug');
    expect(output).not.toContain('info');
    expect(output).not.toContain('warn');
    expect(output).toContain('error');
  });

  it('emits one NDJSON object per diagnostic in json mode', () => {
    const stderr = fakeStream({ isTTY: false });
    const logger = new Logger({ json: true, stdout: fakeStream({ isTTY: false }), stderr });

    logger.info('scanning', { url: 'https://a.test' });
    logger.error('boom');

    const lines = read(stderr).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toEqual([
      { level: 'info', message: 'scanning', url: 'https://a.test' },
      { level: 'error', message: 'boom' },
    ]);
  });

  it('suppresses decorative output in json mode', () => {
    const stderr = fakeStream({ isTTY: false });
    const logger = new Logger({ json: true, stdout: fakeStream({ isTTY: false }), stderr });

    logger.heading('summary');
    logger.field('Files', '3');
    logger.detail('extra');
    logger.blank();

    expect(read(stderr)).toBe('');
  });

  it('reports a zero-width terminal as the default width', () => {
    const logger = new Logger({
      stdout: fakeStream({ isTTY: true, columns: 0 }),
      stderr: fakeStream({ isTTY: true, columns: 0 }),
    });
    expect(logger.columns).toBe(80);
  });
});
