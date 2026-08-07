import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { UsageError } from '../src/core/errors.js';
import { HttpClient } from '../src/core/http/client.js';
import { applyMetadata } from '../src/core/metadata/embed.js';
import { readTags } from '../src/core/metadata/tags.js';
import { parseAssignments } from '../src/cli/commands/tag.js';
import { bareFlac, bareMp3, PNG_1X1 } from './helpers/containers.js';

describe('parseAssignments', () => {
  it('parses text and numeric fields', () => {
    expect(parseAssignments(['title=Hello', 'artist=Adele', 'year=2015', 'track=3'])).toEqual({
      title: 'Hello',
      artist: 'Adele',
      year: 2015,
      track: 3,
    });
  });

  it('accepts field names case-insensitively', () => {
    expect(parseAssignments(['TITLE=x', 'albumartist=y'])).toEqual({ title: 'x', albumArtist: 'y' });
  });

  it('keeps "=" inside a value', () => {
    expect(parseAssignments(['comment=a=b=c'])).toEqual({ comment: 'a=b=c' });
  });

  it('treats an empty value as a request to clear', () => {
    expect(parseAssignments(['comment='])).toEqual({ comment: '' });
  });

  it('rejects unknown fields', () => {
    expect(() => parseAssignments(['bogus=1'])).toThrow(/Unknown metadata field/);
  });

  it('rejects malformed assignments', () => {
    expect(() => parseAssignments(['noequals'])).toThrow(UsageError);
    expect(() => parseAssignments(['=value'])).toThrow(UsageError);
  });

  it('rejects non-numeric values for numeric fields', () => {
    expect(() => parseAssignments(['year=abc'])).toThrow(/non-negative number/);
    expect(() => parseAssignments(['track=-2'])).toThrow(/non-negative number/);
  });
});

describe('applyMetadata', () => {
  let server: Server;
  let origin: string;
  let dir: string;
  let artworkHits = 0;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === '/cover.png') {
        artworkHits++;
        res.writeHead(200, { 'content-type': 'image/png', 'content-length': PNG_1X1.length });
        res.end(PNG_1X1);
        return;
      }
      if (url.pathname === '/notanimage') {
        const body = Buffer.from('<html>404</html>');
        res.writeHead(200, { 'content-type': 'text/html', 'content-length': body.length });
        res.end(body);
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(async () => {
    artworkHits = 0;
    dir = await mkdtemp(path.join(tmpdir(), 'vectrax-embed-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const client = () => new HttpClient({ guard: { allowPrivateHosts: true }, retries: 0 });

  async function makeFile(name: string, contents = bareMp3()): Promise<string> {
    const file = path.join(dir, name);
    await writeFile(file, contents);
    return file;
  }

  it('writes metadata into a downloaded file', async () => {
    const file = await makeFile('song.mp3');
    const report = await applyMetadata(client(), [
      { path: file, metadata: { title: 'Downloaded', artist: 'Provider' } },
    ]);

    expect(report.tagged).toBe(1);
    expect(await readTags(file)).toMatchObject({ title: 'Downloaded', artist: 'Provider' });
  });

  it('fetches and embeds artwork', async () => {
    const file = await makeFile('art.mp3');
    await applyMetadata(client(), [
      { path: file, metadata: { title: 'With Art' }, artworkUrl: `${origin}/cover.png` },
    ]);

    const tags = await readTags(file);
    expect(tags.artwork?.mime).toBe('image/png');
    expect(tags.artwork?.data).toEqual(PNG_1X1);
  });

  it('fetches shared artwork only once for a whole playlist', async () => {
    const files = await Promise.all([1, 2, 3, 4].map((n) => makeFile(`t${n}.mp3`)));
    const report = await applyMetadata(
      client(),
      files.map((file, index) => ({
        path: file,
        metadata: { title: `Track ${index + 1}`, album: 'Album', track: index + 1 },
        artworkUrl: `${origin}/cover.png`,
      })),
    );

    expect(report.tagged).toBe(4);
    expect(artworkHits).toBe(1);
    for (const file of files) expect((await readTags(file)).artwork?.data).toEqual(PNG_1X1);
  });

  it('skips artwork entirely when disabled', async () => {
    const file = await makeFile('noart.mp3');
    await applyMetadata(
      client(),
      [{ path: file, metadata: { title: 'x' }, artworkUrl: `${origin}/cover.png` }],
      { artwork: false },
    );

    expect(artworkHits).toBe(0);
    expect((await readTags(file)).artwork).toBeUndefined();
  });

  it('still writes tags when the artwork URL is unreachable', async () => {
    const file = await makeFile('badart.mp3');
    const report = await applyMetadata(client(), [
      { path: file, metadata: { title: 'Survives' }, artworkUrl: `${origin}/missing.png` },
    ]);

    expect(report.tagged).toBe(1);
    expect((await readTags(file)).title).toBe('Survives');
  });

  it('refuses to embed a non-image as cover art', async () => {
    const file = await makeFile('html.mp3');
    await applyMetadata(client(), [
      { path: file, metadata: { title: 'No HTML' }, artworkUrl: `${origin}/notanimage` },
    ]);

    expect((await readTags(file)).artwork).toBeUndefined();
  });

  it('reports untaggable containers as skipped rather than failed', async () => {
    const file = await makeFile('audio.opus', Buffer.from('opus-ish'));
    const report = await applyMetadata(client(), [{ path: file, metadata: { title: 'x' } }]);

    expect(report.tagged).toBe(0);
    expect(report.skipped).toBe(1);
    expect(report.warnings).toEqual([]);
  });

  it('isolates a failure to the file that caused it', async () => {
    const good = await makeFile('good.mp3');
    const missing = path.join(dir, 'gone.mp3');

    const report = await applyMetadata(client(), [
      { path: good, metadata: { title: 'Good' } },
      { path: missing, metadata: { title: 'Missing' } },
    ]);

    expect(report.tagged).toBe(1);
    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0]).toContain('gone.mp3');
    expect((await readTags(good)).title).toBe('Good');
  });

  it('preserves tags the file already carried', async () => {
    const file = await makeFile('existing.flac', bareFlac());
    await applyMetadata(client(), [{ path: file, metadata: { album: 'Original', genre: 'Jazz' } }]);
    await applyMetadata(client(), [{ path: file, metadata: { title: 'Later' } }]);

    expect(await readTags(file)).toMatchObject({ title: 'Later', album: 'Original', genre: 'Jazz' });
  });

  it('handles an empty job list', async () => {
    expect(await applyMetadata(client(), [])).toEqual({ tagged: 0, skipped: 0, warnings: [] });
  });

  it('leaves the audio payload intact', async () => {
    const audio = bareMp3(2048);
    const file = await makeFile('intact.mp3', audio);
    await applyMetadata(client(), [
      { path: file, metadata: { title: 'Intact' }, artworkUrl: `${origin}/cover.png` },
    ]);

    const after = await readFile(file);
    expect(after.includes(audio)).toBe(true);
  });
});
