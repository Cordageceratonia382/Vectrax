import { describe, expect, it } from 'vitest';

import { decodeEntities, extractMedia, extractPageTitle } from '../src/core/scrape/extract.js';
import { detectQuality, extensionsForKinds, kindForExtension } from '../src/core/scrape/media.js';

const base = new URL('https://music.test/album/great-album');
const audio = extensionsForKinds(['audio']);

const run = (html: string, extensions = audio, match?: RegExp) =>
  extractMedia(html, { baseUrl: base, extensions, ...(match !== undefined ? { match } : {}) });

describe('decodeEntities', () => {
  it('decodes named and numeric entities', () => {
    expect(decodeEntities('a&amp;b')).toBe('a&b');
    expect(decodeEntities('&lt;tag&gt;')).toBe('<tag>');
    expect(decodeEntities('&#39;quoted&#39;')).toBe("'quoted'");
    expect(decodeEntities('&#x41;')).toBe('A');
  });

  it('leaves unknown entities alone', () => {
    expect(decodeEntities('&notreal;')).toBe('&notreal;');
  });
});

describe('extractPageTitle', () => {
  it('reads and cleans the title', () => {
    expect(extractPageTitle('<title>  My &amp; Album  </title>')).toBe('My & Album');
  });

  it('returns undefined when absent', () => {
    expect(extractPageTitle('<html></html>')).toBeUndefined();
  });
});

describe('extractMedia', () => {
  it('finds anchors and uses their text as the title', () => {
    const result = run('<a href="/files/01.mp3">Opening Theme</a>');
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.url).toBe('https://music.test/files/01.mp3');
    expect(result.items[0]?.title).toBe('Opening Theme');
    expect(result.items[0]?.source).toBe('anchor');
  });

  it('resolves protocol-relative, root-relative, and relative hrefs', () => {
    const result = run(`
      <a href="//cdn.test/a.mp3">A</a>
      <a href="/b.mp3">B</a>
      <a href="c.mp3">C</a>
    `);
    expect(result.items.map((item) => item.url).sort()).toEqual([
      'https://cdn.test/a.mp3',
      'https://music.test/album/c.mp3',
      'https://music.test/b.mp3',
    ]);
  });

  it('honours a <base href>', () => {
    const result = run('<base href="https://other.test/root/"><a href="x.mp3">X</a>');
    expect(result.items[0]?.url).toBe('https://other.test/root/x.mp3');
  });

  it('reads <source> and data-* player attributes', () => {
    const result = run(`
      <audio><source src="/s1.mp3" type="audio/mpeg"></audio>
      <div class="player" data-src="/s2.mp3" data-title="Second Track"></div>
    `);
    const urls = result.items.map((item) => item.url);
    expect(urls).toContain('https://music.test/s1.mp3');
    expect(urls).toContain('https://music.test/s2.mp3');
    expect(result.items.find((item) => item.url.endsWith('s2.mp3'))?.title).toBe('Second Track');
  });

  it('finds URLs embedded in inline JSON with escaped slashes', () => {
    const result = run(`<script>var player = {"file":"https:\\/\\/cdn.test\\/track.mp3"};</script>`);
    expect(result.items[0]?.url).toBe('https://cdn.test/track.mp3');
  });

  it('de-duplicates the same file found by several passes', () => {
    const result = run(`
      <a href="https://cdn.test/x.mp3">Title From Anchor</a>
      <source src="https://cdn.test/x.mp3">
      <script>{"file":"https://cdn.test/x.mp3"}</script>
      https://cdn.test/x.mp3
    `);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.title).toBe('Title From Anchor');
  });

  it('treats fragment-only differences as the same file', () => {
    const result = run('<a href="/a.mp3#one">1</a><a href="/a.mp3#two">2</a>');
    expect(result.items).toHaveLength(1);
  });

  it('keeps distinct query strings apart', () => {
    const result = run('<a href="/dl.mp3?q=128">Low</a><a href="/dl.mp3?q=320">High</a>');
    expect(result.items).toHaveLength(2);
  });

  it('filters by extension', () => {
    const result = run('<a href="/a.mp3">A</a><a href="/b.mp4">B</a><a href="/c.html">C</a>');
    expect(result.items.map((item) => item.extension)).toEqual(['mp3']);
  });

  it('includes video when asked', () => {
    const result = run('<a href="/a.mp3">A</a><a href="/b.mp4">B</a>', extensionsForKinds(['audio', 'video']));
    expect(result.items).toHaveLength(2);
    expect(result.items.map((item) => item.kind).sort()).toEqual(['audio', 'video']);
  });

  it('applies a --match filter to the title and the URL', () => {
    const html = '<a href="/live.mp3">Live Version</a><a href="/studio.mp3">Studio Version</a>';
    expect(run(html, audio, /live/i).items).toHaveLength(1);
    expect(run(html, audio, /studio\.mp3/i).items).toHaveLength(1);
  });

  it('ignores javascript:, data:, and mailto: hrefs', () => {
    const result = run(`
      <a href="javascript:play('a.mp3')">JS</a>
      <a href="data:audio/mp3;base64,AAAA">Data</a>
      <a href="mailto:a@b.c?file=x.mp3">Mail</a>
    `);
    expect(result.items).toHaveLength(0);
  });

  it('decodes HTML entities in URLs', () => {
    const result = run('<a href="/dl.mp3?a=1&amp;b=2">Track</a>');
    expect(result.items[0]?.url).toBe('https://music.test/dl.mp3?a=1&b=2');
  });

  it('falls back to the URL, then the page title, for a name', () => {
    const result = run('<title>Album Page</title><source src="/my_great_song.mp3">');
    expect(result.items[0]?.title).toBe('my great song');
  });

  it('rejects generic link text as a title', () => {
    const result = run('<a href="/real_name.mp3">Download</a>');
    expect(result.items[0]?.title).toBe('real name');
  });

  it('decodes percent-encoded non-Latin filenames', () => {
    const result = run('<source src="/%D8%A2%D9%87%D9%86%DA%AF.mp3">');
    expect(result.items[0]?.title).toBe('آهنگ');
  });

  it('does not swallow the closing quote of a raw URL', () => {
    const result = run(`<div data-x="https://cdn.test/a.mp3"></div>`);
    expect(result.items[0]?.url).toBe('https://cdn.test/a.mp3');
  });

  it('flags a page that likely renders client-side', () => {
    expect(run('<div id="root"></div>').likelyDynamic).toBe(true);
    expect(run('<a href="/a.mp3">A</a>').likelyDynamic).toBe(false);
  });

  it('returns an empty list rather than throwing on junk input', () => {
    expect(run('').items).toEqual([]);
    expect(run('<<<>>> not really html').items).toEqual([]);
  });
});

describe('detectQuality', () => {
  it('detects bitrates and resolutions', () => {
    expect(detectQuality('/music/song-320.mp3')).toBe('320kbps');
    expect(detectQuality('Track [128kbps]')).toBe('128kbps');
    expect(detectQuality('/video/clip-1080p.mp4')).toBe('1080p');
    expect(detectQuality('Album (FLAC)')).toBe('FLAC');
  });

  it('returns undefined when there is no marker', () => {
    expect(detectQuality('/music/song.mp3')).toBeUndefined();
  });
});

describe('kindForExtension', () => {
  it('classifies by extension, with or without a dot', () => {
    expect(kindForExtension('mp3')).toBe('audio');
    expect(kindForExtension('.MP4')).toBe('video');
    expect(kindForExtension('zip')).toBe('archive');
    expect(kindForExtension('xyz')).toBe('other');
    expect(kindForExtension(undefined)).toBe('other');
  });
});
