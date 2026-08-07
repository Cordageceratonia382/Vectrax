import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  detectFallbackTool,
  formatSelector,
  resetFallbackCache,
  runFallback,
} from '../src/core/fallback/ytdlp.js';
import { parseQuality } from '../src/core/quality.js';

let dir: string;
let binDir: string;
let originalPath: string | undefined;
let savedDataDir: string | undefined;

async function installStub(body: string): Promise<void> {
  const file = path.join(binDir, 'yt-dlp');
  await writeFile(file, `#!/usr/bin/env bash\n${body}\n`);
  await chmod(file, 0o755);
  process.env['PATH'] = `${binDir}${path.delimiter}${originalPath ?? ''}`;
  resetFallbackCache();
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'vectrax-fallback-'));
  savedDataDir = process.env['VECTRAX_DATA_DIR'];
  process.env['VECTRAX_DATA_DIR'] = path.join(dir, 'data');
  binDir = path.join(dir, 'bin');
  await mkdtemp(binDir).catch(() => undefined);
  await import('node:fs/promises').then((fs) => fs.mkdir(binDir, { recursive: true }));
  originalPath = process.env['PATH'];
  resetFallbackCache();
});

afterEach(async () => {
  process.env['PATH'] = originalPath;
  if (savedDataDir === undefined) delete process.env['VECTRAX_DATA_DIR'];
  else process.env['VECTRAX_DATA_DIR'] = savedDataDir;
  resetFallbackCache();
  await rm(dir, { recursive: true, force: true });
});

describe('formatSelector', () => {
  it('asks for the best taggable audio by default', () => {
    const args = formatSelector('audio', parseQuality('best'));
    expect(args.join(' ')).toContain('bestaudio[ext=m4a]');
    expect(args.join(' ')).toContain('aext:m4a');
  });

  it('targets an explicit bitrate', () => {
    expect(formatSelector('audio', parseQuality('192k')).join(' ')).toContain('abr~192');
  });

  it('caps video height and prefers a compatible codec', () => {
    const args = formatSelector('video', parseQuality('720p')).join(' ');
    expect(args).toContain('height<=720');
    expect(args).toContain('res:720');
    expect(args).toContain('h264');
  });

  it('lets video run to the maximum when asked', () => {
    const args = formatSelector('video', parseQuality('best')).join(' ');
    expect(args).not.toContain('height<=');
    expect(args).toContain('bv*+ba');
  });
});

describe('detectFallbackTool', () => {
  it('finds an executable on PATH and reports its version', async () => {
    await installStub('echo 2026.01.01');
    const tool = await detectFallbackTool();
    expect(tool?.version).toBe('2026.01.01');
    expect(path.basename(tool?.binary ?? '')).toBe('yt-dlp');
  });

  it('returns undefined when nothing is installed', async () => {
    process.env['PATH'] = path.join(dir, 'empty');
    resetFallbackCache();
    expect(await detectFallbackTool()).toBeUndefined();
  });

  it('ignores a binary that fails to report a version', async () => {
    await installStub('exit 1');
    expect(await detectFallbackTool()).toBeUndefined();
  });
});

describe('runFallback', () => {
  const request = (over: Record<string, unknown> = {}) => ({
    url: 'https://www.youtube.com/watch?v=abcdefghijk',
    outputDir: dir,
    filename: 'Artist - Song',
    media: 'audio' as const,
    quality: parseQuality('best'),
    ...over,
  });

  it('returns the path the tool reports', async () => {
    await installStub(`
if [ "$1" = "--version" ]; then echo 2026.01.01; exit 0; fi
out="${'${TMPDIR:-/tmp}'}/produced.m4a"
printf 'audio' > "$out"
echo "$out"
`);
    const tool = await detectFallbackTool();
    const result = await runFallback(tool!, request());
    expect(path.isAbsolute(result.path)).toBe(true);
    expect(await readFile(result.path, 'utf8')).toBe('audio');
  });

  it('passes the output template and URL through', async () => {
    await installStub(`
if [ "$1" = "--version" ]; then echo 2026.01.01; exit 0; fi
printf '%s\\n' "$@" > "${'${ARGS_FILE}'}"
out="${'${TMPDIR:-/tmp}'}/produced2.m4a"
printf 'x' > "$out"
echo "$out"
`);
    process.env['ARGS_FILE'] = path.join(dir, 'args.txt');
    const tool = await detectFallbackTool();
    await runFallback(tool!, request());

    const args = await readFile(path.join(dir, 'args.txt'), 'utf8');
    expect(args).toContain('https://www.youtube.com/watch?v=abcdefghijk');
    expect(args).toContain('Artist - Song.%(ext)s');
    expect(args).toContain('--no-playlist');
    delete process.env['ARGS_FILE'];
  });

  it('reports the tool error when it exits non-zero', async () => {
    await installStub(`
if [ "$1" = "--version" ]; then echo 2026.01.01; exit 0; fi
echo "ERROR: Video unavailable" >&2
exit 1
`);
    const tool = await detectFallbackTool();
    await expect(runFallback(tool!, request())).rejects.toThrow(/could not download/i);
  });

  it('surfaces the tool message as a hint', async () => {
    await installStub(`
if [ "$1" = "--version" ]; then echo 2026.01.01; exit 0; fi
echo "ERROR: Sign in to confirm your age" >&2
exit 1
`);
    const tool = await detectFallbackTool();
    await expect(runFallback(tool!, request())).rejects.toMatchObject({
      hint: 'Sign in to confirm your age',
    });
  });

  it('fails when the tool succeeds but produces no path', async () => {
    await installStub(`
if [ "$1" = "--version" ]; then echo 2026.01.01; exit 0; fi
exit 0
`);
    const tool = await detectFallbackTool();
    await expect(runFallback(tool!, request())).rejects.toThrow(/could not download/i);
  });

  it('reports progress while downloading', async () => {
    await installStub(`
if [ "$1" = "--version" ]; then echo 2026.01.01; exit 0; fi
echo "[download]  10.0% of 1.00MiB" >&2
echo "[download]  95.5% of 1.00MiB" >&2
out="${'${TMPDIR:-/tmp}'}/produced3.m4a"
printf 'x' > "$out"
echo "$out"
`);
    const seen: number[] = [];
    const tool = await detectFallbackTool();
    await runFallback(tool!, request({ onProgress: (p: number) => seen.push(p) }));
    expect(seen.length).toBeGreaterThan(0);
    expect(Math.max(...seen)).toBeCloseTo(0.955, 2);
  });

  it('retries without format constraints when the first attempt fails', async () => {
    await installStub(`
if [ "$1" = "--version" ]; then echo 2026.01.01; exit 0; fi
printf '%s\\n' "$@" >> "${'${ARGS_FILE}'}"
for a in "$@"; do
  case "$a" in
    *'[ext=m4a]'*) echo "ERROR: unable to download video data: HTTP Error 403: Forbidden" >&2; exit 1 ;;
  esac
done
out="${'${TMPDIR:-/tmp}'}/recovered.webm"
printf 'x' > "$out"
echo "$out"
`);
    process.env['ARGS_FILE'] = path.join(dir, 'retry-args.txt');
    const tool = await detectFallbackTool();
    const retries: number[] = [];

    const result = await runFallback(tool!, request({ onRetry: () => retries.push(1) }));

    expect(retries).toHaveLength(1);
    expect(result.path).toContain('recovered.webm');

    const args = await readFile(path.join(dir, 'retry-args.txt'), 'utf8');
    expect(args).toContain('[ext=m4a]');
    expect(args).toContain('bestaudio/best');
    delete process.env['ARGS_FILE'];
  });

  it('does not retry after an abort', async () => {
    await installStub(`
if [ "$1" = "--version" ]; then echo 2026.01.01; exit 0; fi
sleep 30
`);
    const controller = new AbortController();
    const tool = await detectFallbackTool();
    const retries: number[] = [];
    const pending = runFallback(tool!, request({ signal: controller.signal, onRetry: () => retries.push(1) }));
    setTimeout(() => controller.abort(new Error('stop')), 50);

    await expect(pending).rejects.toThrow('stop');
    expect(retries).toHaveLength(0);
  });

  it('stops when the signal aborts', async () => {
    await installStub(`
if [ "$1" = "--version" ]; then echo 2026.01.01; exit 0; fi
sleep 30
`);
    const controller = new AbortController();
    const tool = await detectFallbackTool();
    const pending = runFallback(tool!, request({ signal: controller.signal }));
    setTimeout(() => controller.abort(new Error('stop')), 50);
    await expect(pending).rejects.toThrow('stop');
  });

  it('kills a tool that never finishes', async () => {
    await installStub(`
if [ "$1" = "--version" ]; then echo 2026.01.01; exit 0; fi
sleep 30
`);
    const tool = await detectFallbackTool();
    await expect(runFallback(tool!, request({ timeoutMs: 120 }))).rejects.toThrow(/timed out/i);
  });
});
