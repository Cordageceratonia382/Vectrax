import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DownloadEngine } from '../src/core/download/engine.js';
import { HttpClient } from '../src/core/http/client.js';
import type { DownloadRequest } from '../src/core/download/types.js';

const BODY = Buffer.from('vectrax-payload-'.repeat(64));
const ETAG = '"v1"';

let server: Server;
let origin: string;
let outputDir: string;

let hits: Record<string, number>;

function client(): HttpClient {
  return new HttpClient({ guard: { allowPrivateHosts: true }, retries: 0, timeoutMs: 5000 });
}

function engine(options: Partial<ConstructorParameters<typeof DownloadEngine>[1]> = {}): DownloadEngine {
  return new DownloadEngine(client(), { concurrency: 2, retries: 2, retryDelayMs: 5, ...options });
}

function request(id: string, urlPath: string, title: string): DownloadRequest {
  return { id, url: `${origin}${urlPath}`, title, outputDir };
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const route = url.pathname;
    hits[route] = (hits[route] ?? 0) + 1;

    const serveRange = (body: Buffer, headers: Record<string, string> = {}) => {
      const range = req.headers.range;
      const base = { 'accept-ranges': 'bytes', etag: ETAG, 'content-type': 'audio/mpeg', ...headers };
      if (range !== undefined) {
        const match = /bytes=(\d+)-(\d*)/.exec(range);
        const start = Number(match?.[1] ?? 0);
        const end = match?.[2] !== undefined && match[2] !== '' ? Number(match[2]) : body.length - 1;
        if (start >= body.length) {
          res.writeHead(416, { ...base, 'content-range': `bytes */${body.length}` });
          res.end();
          return;
        }
        const slice = body.subarray(start, end + 1);
        res.writeHead(206, {
          ...base,
          'content-length': String(slice.length),
          'content-range': `bytes ${start}-${end}/${body.length}`,
        });
        res.end(req.method === 'HEAD' ? undefined : slice);
        return;
      }
      res.writeHead(200, { ...base, 'content-length': String(body.length) });
      res.end(req.method === 'HEAD' ? undefined : body);
    };

    switch (route) {
      case '/ok.mp3':
        serveRange(BODY);
        return;

      case '/named':
        serveRange(BODY, { 'content-disposition': 'attachment; filename="From Header.mp3"' });
        return;

      case '/no-head.mp3':
        if (req.method === 'HEAD') {
          res.writeHead(405).end();
          return;
        }
        serveRange(BODY);
        return;

      case '/no-ranges.mp3':
        res.writeHead(200, { 'content-length': String(BODY.length), 'content-type': 'audio/mpeg' });
        res.end(req.method === 'HEAD' ? undefined : BODY);
        return;

      case '/flaky.mp3':
        if (req.method === 'GET' && (hits[route] ?? 0) <= 3) {
          res.writeHead(503).end();
          return;
        }
        serveRange(BODY);
        return;

      case '/truncated.mp3':
        res.writeHead(200, { 'content-length': String(BODY.length), 'content-type': 'audio/mpeg' });
        if (req.method === 'HEAD') {
          res.end();
          return;
        }
        res.write(BODY.subarray(0, 100));
        res.destroy();
        return;

      case '/notfound.mp3':
        res.writeHead(404).end();
        return;

      case '/redirect.mp3':
        res.writeHead(302, { location: '/ok.mp3' }).end();
        return;

      case '/loop.mp3':
        res.writeHead(302, { location: '/loop.mp3' }).end();
        return;

      case '/empty.mp3':
        res.writeHead(200, { 'content-length': '0', 'content-type': 'audio/mpeg' }).end();
        return;

      default:
        res.writeHead(404).end();
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(async () => {
  hits = {};
  outputDir = await mkdtemp(path.join(tmpdir(), 'vectrax-test-'));
});

afterEach(async () => {
  await rm(outputDir, { recursive: true, force: true });
});

describe('happy path', () => {
  it('downloads a file with the expected bytes and name', async () => {
    const [outcome] = await engine().run([request('1', '/ok.mp3', 'My Track')]);

    expect(outcome?.state).toBe('completed');
    expect(outcome?.bytes).toBe(BODY.length);
    expect(path.basename(outcome?.path as string)).toBe('My Track.mp3');
    expect(await readFile(outcome?.path as string)).toEqual(BODY);
  });

  it('downloads several files concurrently', async () => {
    const outcomes = await engine({ concurrency: 3 }).run([
      request('1', '/ok.mp3', 'One'),
      request('2', '/ok.mp3', 'Two'),
      request('3', '/ok.mp3', 'Three'),
    ]);
    expect(outcomes.map((o) => o.state)).toEqual(['completed', 'completed', 'completed']);
    expect((await readdir(outputDir)).sort()).toEqual(['One.mp3', 'Three.mp3', 'Two.mp3']);
  });

  it('prefers the Content-Disposition filename', async () => {
    const [outcome] = await engine().run([request('1', '/named', 'Ignored Title')]);
    expect(path.basename(outcome?.path as string)).toBe('From Header.mp3');
  });

  it('follows a redirect', async () => {
    const [outcome] = await engine().run([request('1', '/redirect.mp3', 'Redirected')]);
    expect(outcome?.state).toBe('completed');
    expect(await readFile(outcome?.path as string)).toEqual(BODY);
  });

  it('falls back to a ranged GET when HEAD is refused', async () => {
    const [outcome] = await engine().run([request('1', '/no-head.mp3', 'No Head')]);
    expect(outcome?.state).toBe('completed');
    expect(outcome?.bytes).toBe(BODY.length);
  });

  it('handles a server that does not support ranges', async () => {
    const [outcome] = await engine().run([request('1', '/no-ranges.mp3', 'Plain')]);
    expect(outcome?.state).toBe('completed');
    expect(await readFile(outcome?.path as string)).toEqual(BODY);
  });

  it('leaves no .vxpart files behind on success', async () => {
    await engine().run([request('1', '/ok.mp3', 'Clean')]);
    const files = await readdir(outputDir);
    expect(files.filter((f) => f.includes('vxpart'))).toEqual([]);
  });

  it('reports progress that ends at the final size', async () => {
    const received: number[] = [];
    await engine({ onUpdate: (s) => received.push(s.received) }).run([request('1', '/ok.mp3', 'Progress')]);
    expect(received.at(-1)).toBe(BODY.length);
    expect(received.some((n) => n > 0 && n < BODY.length) || received.includes(BODY.length)).toBe(true);
  });
});

describe('resume', () => {
  it('resumes from an existing partial file', async () => {
    const destination = path.join(outputDir, 'Resumable.mp3');
    await writeFile(`${destination}.vxpart`, BODY.subarray(0, 400));
    await writeFile(
      `${destination}.vxpart.json`,
      JSON.stringify({ url: `${origin}/ok.mp3`, etag: ETAG, lastModified: null, size: BODY.length, version: 1 }),
    );

    const [outcome] = await engine().run([request('1', '/ok.mp3', 'Resumable')]);

    expect(outcome?.state).toBe('completed');
    expect(outcome?.resumed).toBe(true);
    expect(await readFile(destination)).toEqual(BODY);
  });

  it('discards a partial file whose validators no longer match', async () => {
    const destination = path.join(outputDir, 'Stale.mp3');
    await writeFile(`${destination}.vxpart`, Buffer.from('garbage'.repeat(20)));
    await writeFile(
      `${destination}.vxpart.json`,
      JSON.stringify({ url: `${origin}/ok.mp3`, etag: '"old"', lastModified: null, size: BODY.length, version: 1 }),
    );

    const [outcome] = await engine().run([request('1', '/ok.mp3', 'Stale')]);

    expect(outcome?.resumed).toBe(false);
    expect(await readFile(destination)).toEqual(BODY);
  });

  it('discards a partial file with no sidecar', async () => {
    const destination = path.join(outputDir, 'Orphan.mp3');
    await writeFile(`${destination}.vxpart`, Buffer.from('orphaned bytes'));

    const [outcome] = await engine().run([request('1', '/ok.mp3', 'Orphan')]);

    expect(outcome?.state).toBe('completed');
    expect(await readFile(destination)).toEqual(BODY);
  });

  it('restarts instead of resuming when --no-resume is set', async () => {
    const destination = path.join(outputDir, 'Fresh.mp3');
    await writeFile(`${destination}.vxpart`, BODY.subarray(0, 400));
    await writeFile(
      `${destination}.vxpart.json`,
      JSON.stringify({ url: `${origin}/ok.mp3`, etag: ETAG, lastModified: null, size: BODY.length, version: 1 }),
    );

    const [outcome] = await engine({ resume: false }).run([request('1', '/ok.mp3', 'Fresh')]);

    expect(outcome?.resumed).toBe(false);
    expect(await readFile(destination)).toEqual(BODY);
  });

  it('recovers when the partial file is already complete (416)', async () => {
    const destination = path.join(outputDir, 'Full.mp3');
    await writeFile(`${destination}.vxpart`, Buffer.concat([BODY, Buffer.from('extra')]));
    await writeFile(
      `${destination}.vxpart.json`,
      JSON.stringify({ url: `${origin}/ok.mp3`, etag: ETAG, lastModified: null, size: BODY.length, version: 1 }),
    );

    const [outcome] = await engine().run([request('1', '/ok.mp3', 'Full')]);

    expect(outcome?.state).toBe('completed');
    expect(await readFile(destination)).toEqual(BODY);
  });
});

describe('failure handling', () => {
  it('retries a 5xx and eventually succeeds', async () => {
    const [outcome] = await engine({ retries: 4 }).run([request('1', '/flaky.mp3', 'Flaky')]);
    expect(outcome?.state).toBe('completed');
    expect(hits['/flaky.mp3']).toBeGreaterThan(2);
  });

  it('does not retry a 404 and reports it', async () => {
    const [outcome] = await engine({ retries: 3 }).run([request('1', '/notfound.mp3', 'Missing')]);
    expect(outcome?.state).toBe('failed');
    expect(outcome?.error?.message).toMatch(/404/);
    expect(hits['/notfound.mp3']).toBeLessThanOrEqual(2);
  });

  it('does not publish a truncated file under its real name', async () => {
    const [outcome] = await engine({ retries: 0 }).run([request('1', '/truncated.mp3', 'Broken')]);
    expect(outcome?.state).toBe('failed');
    expect(await readdir(outputDir)).not.toContain('Broken.mp3');
  });

  it('rejects a redirect loop', async () => {
    const [outcome] = await engine({ retries: 0 }).run([request('1', '/loop.mp3', 'Loop')]);
    expect(outcome?.state).toBe('failed');
    expect(outcome?.error?.message).toMatch(/redirect/i);
  });

  it('rejects an empty response body', async () => {
    const [outcome] = await engine({ retries: 0 }).run([request('1', '/empty.mp3', 'Empty')]);
    expect(outcome?.state).toBe('failed');
    expect(await readdir(outputDir)).not.toContain('Empty.mp3');
  });

  it('isolates a failure so siblings still complete', async () => {
    const outcomes = await engine({ retries: 0 }).run([
      request('1', '/ok.mp3', 'Good One'),
      request('2', '/notfound.mp3', 'Bad'),
      request('3', '/ok.mp3', 'Good Two'),
    ]);
    expect(outcomes.map((o) => o.state)).toEqual(['completed', 'failed', 'completed']);
  });
});

describe('conflict policies', () => {
  it('renames by default', async () => {
    await engine().run([request('1', '/ok.mp3', 'Dup')]);
    const [second] = await engine().run([request('2', '/ok.mp3', 'Dup')]);
    expect(path.basename(second?.path as string)).toBe('Dup (2).mp3');
  });

  it('skips when asked', async () => {
    await engine().run([request('1', '/ok.mp3', 'Dup')]);
    const [second] = await engine({ conflict: 'skip' }).run([request('2', '/ok.mp3', 'Dup')]);
    expect(second?.state).toBe('skipped');
    expect(await readdir(outputDir)).toEqual(['Dup.mp3']);
  });

  it('overwrites when asked', async () => {
    const destination = path.join(outputDir, 'Dup.mp3');
    await writeFile(destination, 'old content');
    await engine({ conflict: 'overwrite' }).run([request('1', '/ok.mp3', 'Dup')]);
    expect(await readFile(destination)).toEqual(BODY);
    expect(await readdir(outputDir)).toEqual(['Dup.mp3']);
  });
});

describe('cancellation and dry run', () => {
  it('reports cancelled tasks when the signal aborts', async () => {
    const controller = new AbortController();
    controller.abort(new Error('user'));
    const outcomes = await engine().run([request('1', '/ok.mp3', 'Never')], controller.signal);
    expect(outcomes[0]?.state).toBe('cancelled');
    expect(await readdir(outputDir)).toEqual([]);
  });

  it('writes nothing in dry-run mode', async () => {
    const [outcome] = await engine({ dryRun: true }).run([request('1', '/ok.mp3', 'Preview')]);
    expect(outcome?.state).toBe('completed');
    expect(await readdir(outputDir)).toEqual([]);
  });
});

describe('provider integration', () => {
  it('sends per-request headers on both the probe and the transfer', async () => {
    const seen: string[] = [];
    const probe = createServer((req, res) => {
      seen.push(`${req.method} ${req.headers['x-provider'] ?? 'none'}`);
      res.writeHead(200, { 'content-length': String(BODY.length), 'accept-ranges': 'bytes' });
      res.end(req.method === 'HEAD' ? undefined : BODY);
    });
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const port = (probe.address() as AddressInfo).port;

    try {
      await engine().run([
        {
          id: '1',
          url: `http://127.0.0.1:${port}/x.mp3`,
          title: 'Headers',
          outputDir,
          headers: { 'x-provider': 'vectrax-test' },
        },
      ]);
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every((entry) => entry.endsWith('vectrax-test'))).toBe(true);
    } finally {
      await new Promise<void>((resolve) => probe.close(() => resolve()));
    }
  });

  it('uses the provider filename stem instead of the URL', async () => {
    const [outcome] = await engine().run([
      { ...request('1', '/ok.mp3', 'Display Title'), filename: 'Artist - Song' },
    ]);
    expect(path.basename(outcome?.path as string)).toBe('Artist - Song.mp3');
  });

  it('attaches the provider failure hint to a 403', async () => {
    const denier = createServer((_req, res) => res.writeHead(403).end());
    await new Promise<void>((resolve) => denier.listen(0, '127.0.0.1', resolve));
    const port = (denier.address() as AddressInfo).port;

    try {
      const [outcome] = await engine({ retries: 0 }).run([
        {
          id: '1',
          url: `http://127.0.0.1:${port}/x.mp3`,
          title: 'Gated',
          outputDir,
          failureHint: 'This source requires a token Vectrax cannot mint.',
        },
      ]);
      expect(outcome?.state).toBe('failed');
      expect((outcome?.error as { hint?: string }).hint).toBe(
        'This source requires a token Vectrax cannot mint.',
      );
    } finally {
      await new Promise<void>((resolve) => denier.close(() => resolve()));
    }
  });

  it('keeps URLs out of error messages at full length', async () => {
    const [outcome] = await engine({ retries: 0 }).run([
      request('1', '/notfound.mp3?' + 'x=1&'.repeat(200), 'Long URL'),
    ]);
    expect(outcome?.state).toBe('failed');
    expect(outcome?.error?.message.length).toBeLessThan(140);
  });
});

describe('timeouts', () => {
  it('does not abort a slow but healthy body', async () => {
    const payload = Buffer.alloc(120 * 1024, 0x41);
    const slow = createServer((_req, res) => {
      res.writeHead(200, { 'content-length': String(payload.length), 'content-type': 'audio/mpeg' });
      let sent = 0;
      const step = 20 * 1024;
      const push = (): void => {
        if (sent >= payload.length) {
          res.end();
          return;
        }
        res.write(payload.subarray(sent, sent + step));
        sent += step;
        setTimeout(push, 120);
      };
      push();
    });
    await new Promise<void>((resolve) => slow.listen(0, '127.0.0.1', resolve));
    const port = (slow.address() as AddressInfo).port;

    try {
      const client = new HttpClient({ guard: { allowPrivateHosts: true }, retries: 0, timeoutMs: 300 });
      const engine = new DownloadEngine(client, { concurrency: 1, retries: 0 });
      const [outcome] = await engine.run([
        { id: '1', url: `http://127.0.0.1:${port}/slow.mp3`, title: 'Slow', outputDir },
      ]);

      expect(outcome?.state).toBe('completed');
      expect(outcome?.bytes).toBe(payload.length);
    } finally {
      await new Promise<void>((resolve) => slow.close(() => resolve()));
    }
  });

  it('still times out when headers never arrive', async () => {
    const silent = createServer(() => {
    });
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    const port = (silent.address() as AddressInfo).port;

    try {
      const client = new HttpClient({ guard: { allowPrivateHosts: true }, retries: 0, timeoutMs: 250 });
      const engine = new DownloadEngine(client, { concurrency: 1, retries: 0 });
      const [outcome] = await engine.run([
        { id: '1', url: `http://127.0.0.1:${port}/hang.mp3`, title: 'Hang', outputDir },
      ]);
      expect(outcome?.state).toBe('failed');
    } finally {
      silent.closeAllConnections?.();
      await new Promise<void>((resolve) => silent.close(() => resolve()));
    }
  });
});

describe('filename safety', () => {
  it('cannot be made to write outside the output directory', async () => {
    const [outcome] = await engine().run([request('1', '/ok.mp3', '../../escaped')]);
    expect(outcome?.state).toBe('completed');
    expect(path.dirname(outcome?.path as string)).toBe(outputDir);
    expect(path.basename(outcome?.path as string)).toBe('escaped.mp3');
  });
});
