import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildFilename,
  extensionFromContentType,
  filenameFromContentDisposition,
  sanitizeFilename,
} from '../src/core/download/filename.js';

describe('sanitizeFilename', () => {
  it('keeps ordinary names intact', () => {
    expect(sanitizeFilename('Track 01 - Intro.mp3')).toBe('Track 01 - Intro.mp3');
  });

  it('collapses path traversal to a bare name', () => {
    expect(sanitizeFilename('../../../etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('..\\..\\windows\\system32\\config')).toBe('config');
    expect(sanitizeFilename('/absolute/path/song.mp3')).toBe('song.mp3');
  });

  it('never emits a path separator', () => {
    for (const input of ['a/b', 'a\\b', '..', '.', '/', '\\', 'a/../b']) {
      const result = sanitizeFilename(input);
      expect(result).not.toContain('/');
      expect(result).not.toContain('\\');
      expect(path.basename(result)).toBe(result);
    }
  });

  it('strips control characters and invisible bidi overrides', () => {
    expect(sanitizeFilename('song\u0000\u001Fname.mp3')).toBe('song__name.mp3');
    expect(sanitizeFilename('inv\u200Boice\u202Egnp.exe')).toBe('invoicegnp.exe');
  });

  it('replaces characters that are illegal on Windows', () => {
    expect(sanitizeFilename('a<b>c:d"e|f?g*h.mp3')).toBe('a_b_c_d_e_f_g_h.mp3');
  });

  it('rejects Windows device names', () => {
    expect(sanitizeFilename('CON.mp3')).toBe('download.mp3');
    expect(sanitizeFilename('com1')).toBe('download');
    expect(sanitizeFilename('LPT9.txt')).toBe('download.txt');
  });

  it('drops leading and trailing dots and spaces', () => {
    expect(sanitizeFilename('  .hidden.mp3  ')).toBe('hidden.mp3');
    expect(sanitizeFilename('name.mp3...')).toBe('name.mp3');
  });

  it('falls back when nothing usable remains', () => {
    expect(sanitizeFilename('')).toBe('download');
    expect(sanitizeFilename('...')).toBe('download');
    expect(sanitizeFilename('   ')).toBe('download');
  });

  it('caps length in bytes while preserving the extension', () => {
    const long = `${'a'.repeat(500)}.mp3`;
    const result = sanitizeFilename(long);
    expect(Buffer.byteLength(result)).toBeLessThanOrEqual(180);
    expect(result.endsWith('.mp3')).toBe(true);
  });

  it('does not split a multi-byte character when clamping', () => {
    const result = sanitizeFilename(`${'آهنگ'.repeat(80)}.mp3`);
    expect(Buffer.byteLength(result)).toBeLessThanOrEqual(180);
    expect(result).not.toContain('�');
  });

  it('preserves non-Latin scripts', () => {
    expect(sanitizeFilename('آهنگ جدید.mp3')).toBe('آهنگ جدید.mp3');
  });
});

describe('filenameFromContentDisposition', () => {
  it('reads a quoted filename', () => {
    expect(filenameFromContentDisposition('attachment; filename="My Song.mp3"')).toBe('My Song.mp3');
  });

  it('reads an unquoted filename', () => {
    expect(filenameFromContentDisposition('attachment; filename=song.mp3')).toBe('song.mp3');
  });

  it('prefers the RFC 5987 extended form', () => {
    const header = "attachment; filename=\"fallback.mp3\"; filename*=UTF-8''%D8%A2%D9%87%D9%86%DA%AF.mp3";
    expect(filenameFromContentDisposition(header)).toBe('آهنگ.mp3');
  });

  it('sanitises a traversal attempt in the header', () => {
    expect(filenameFromContentDisposition('attachment; filename="../../evil.sh"')).toBe('evil.sh');
  });

  it('returns undefined when absent', () => {
    expect(filenameFromContentDisposition(null)).toBeUndefined();
    expect(filenameFromContentDisposition('inline')).toBeUndefined();
  });
});

describe('extensionFromContentType', () => {
  it('maps known audio types', () => {
    expect(extensionFromContentType('audio/mpeg')).toBe('.mp3');
    expect(extensionFromContentType('audio/mp4; codecs="mp4a"')).toBe('.m4a');
  });

  it('returns undefined for unknown types', () => {
    expect(extensionFromContentType('application/octet-stream')).toBeUndefined();
    expect(extensionFromContentType(null)).toBeUndefined();
  });
});

describe('buildFilename', () => {
  it('prefers a title plus the URL extension', () => {
    expect(
      buildFilename({ title: 'Nice Track', url: new URL('https://cdn.test/files/abc123.mp3') }),
    ).toBe('Nice Track.mp3');
  });

  it('uses Content-Disposition when it carries an extension', () => {
    expect(
      buildFilename({
        title: 'Ignored',
        url: new URL('https://cdn.test/download?id=9'),
        contentDisposition: 'attachment; filename="Real Name.flac"',
      }),
    ).toBe('Real Name.flac');
  });

  it('falls back to the content type when the URL has no extension', () => {
    expect(
      buildFilename({
        title: 'Stream',
        url: new URL('https://cdn.test/stream?id=9'),
        contentType: 'audio/mpeg',
      }),
    ).toBe('Stream.mp3');
  });

  it('derives a name from the URL when there is no title', () => {
    expect(buildFilename({ url: new URL('https://cdn.test/music/my_song.mp3') })).toBe('my song.mp3');
  });

  it('does not double an extension the title already has', () => {
    expect(
      buildFilename({ title: 'Track.mp3', url: new URL('https://cdn.test/x/track.mp3') }),
    ).toBe('Track.mp3');
  });

  it('produces a safe name from hostile input', () => {
    const result = buildFilename({
      title: '../../../etc/passwd',
      url: new URL('https://cdn.test/a.mp3'),
    });
    expect(result).toBe('passwd.mp3');
  });
});
