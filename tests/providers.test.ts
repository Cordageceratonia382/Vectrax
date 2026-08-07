import { describe, expect, it } from 'vitest';

import { providerFor, providers } from '../src/core/providers/registry.js';
import { pageProvider } from '../src/core/providers/page.js';
import { bareHost, hostMatches } from '../src/core/providers/types.js';
import {
  extractPlaylistEntries,
  extractPlaylistTitle,
  parseInitialData,
  parseYouTubeUrl,
  selectFormat,
  splitArtistTitle,
  youtubeProvider,
} from '../src/core/providers/youtube.js';
import { parseQuality } from '../src/core/quality.js';
import { unsupportedProvider } from '../src/core/providers/unsupported.js';

describe('registry', () => {
  it('refuses DRM-protected sources with an explanation', () => {
    for (const url of [
      'https://open.spotify.com/track/4PTG3Z6ehGkBFwjybzWkR8',
      'https://music.apple.com/us/album/x/1',
      'https://tidal.com/browse/track/1',
    ]) {
      expect(unsupportedProvider.supports(new URL(url)), url).toBe(true);
      expect(providerFor(new URL(url)).id, url).toBe('unsupported');
    }
    expect(unsupportedProvider.supports(new URL('https://example.com/x'))).toBe(false);
  });

  it('routes each source to its provider', () => {
    expect(providerFor(new URL('https://www.youtube.com/watch?v=abcdefghijk')).id).toBe('youtube');
    expect(providerFor(new URL('https://youtu.be/abcdefghijk')).id).toBe('youtube');
    expect(providerFor(new URL('https://example.com/album')).id).toBe('page');
  });

  it('keeps the catch-all page provider last', () => {
    expect(providers[providers.length - 1]).toBe(pageProvider);
    expect(pageProvider.supports(new URL('https://anything.test/x'))).toBe(true);
  });

  it('never leaves a URL unhandled', () => {
    for (const url of ['https://a.test/x', 'http://b.test', 'https://vimeo.com/123']) {
      expect(providerFor(new URL(url))).toBeDefined();
    }
  });
});

describe('host helpers', () => {
  it('strips www and matches subdomains', () => {
    expect(bareHost(new URL('https://www.Example.com/x'))).toBe('example.com');
    expect(hostMatches('m.youtube.com', 'youtube.com')).toBe(true);
    expect(hostMatches('youtube.com', 'youtube.com')).toBe(true);
    expect(hostMatches('notyoutube.com', 'youtube.com')).toBe(false);
  });
});

describe('parseYouTubeUrl', () => {
  const id = 'dQw4w9WgXcQ';

  it('handles every common video URL form', () => {
    const forms = [
      `https://www.youtube.com/watch?v=${id}`,
      `https://youtube.com/watch?v=${id}&t=42`,
      `https://youtu.be/${id}`,
      `https://www.youtube.com/shorts/${id}`,
      `https://www.youtube.com/embed/${id}`,
      `https://www.youtube.com/live/${id}`,
      `https://m.youtube.com/watch?v=${id}`,
      `https://www.youtube-nocookie.com/embed/${id}`,
    ];
    for (const form of forms) {
      expect(parseYouTubeUrl(new URL(form))?.videoId, form).toBe(id);
    }
  });

  it('extracts playlist ids', () => {
    const list = 'PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI';
    expect(parseYouTubeUrl(new URL(`https://www.youtube.com/playlist?list=${list}`))).toEqual({
      playlistId: list,
    });
  });

  it('prefers the video when a watch URL also carries a list', () => {
    const list = 'PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI';
    const target = parseYouTubeUrl(new URL(`https://www.youtube.com/watch?v=${id}&list=${list}`));
    expect(target?.videoId).toBe(id);
    expect(target?.playlistId).toBe(list);
  });

  it('ignores personal pseudo-playlists', () => {
    expect(parseYouTubeUrl(new URL('https://www.youtube.com/playlist?list=WL'))).toBeUndefined();
    expect(parseYouTubeUrl(new URL('https://www.youtube.com/playlist?list=LL'))).toBeUndefined();
  });

  it('rejects non-YouTube and malformed URLs', () => {
    expect(parseYouTubeUrl(new URL('https://example.com/watch?v=' + id))).toBeUndefined();
    expect(parseYouTubeUrl(new URL('https://www.youtube.com/watch?v=short'))).toBeUndefined();
    expect(parseYouTubeUrl(new URL('https://www.youtube.com/'))).toBeUndefined();
  });

  it('is reflected by the provider guard', () => {
    expect(youtubeProvider.supports(new URL(`https://youtu.be/${id}`))).toBe(true);
    expect(youtubeProvider.supports(new URL('https://example.com/'))).toBe(false);
  });
});

describe('splitArtistTitle', () => {
  it('splits the conventional "Artist - Title"', () => {
    expect(splitArtistTitle('Rick Astley - Never Gonna Give You Up', 'Rick Astley')).toEqual({
      artist: 'Rick Astley',
      title: 'Never Gonna Give You Up',
    });
  });

  it('strips English promotional suffixes', () => {
    expect(splitArtistTitle('Adele - Hello (Official Music Video)', 'AdeleVEVO').title).toBe('Hello');
  });

  it('strips non-English promotional suffixes', () => {
    expect(splitArtistTitle('BELLAKEO (Video Oficial) - Peso Pluma', 'Peso Pluma').title).toBe('BELLAKEO');
  });

  it('strips quality markers', () => {
    expect(
      splitArtistTitle('Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)', 'Rick Astley')
        .title,
    ).toBe('Never Gonna Give You Up');
  });

  it('uses the channel to detect a reversed "Title - Artist"', () => {
    expect(splitArtistTitle('BELLAKEO - Peso Pluma, Anitta', 'Peso Pluma')).toEqual({
      artist: 'Peso Pluma, Anitta',
      title: 'BELLAKEO',
    });
    expect(splitArtistTitle('Shape of You - Ed Sheeran', 'Ed Sheeran')).toEqual({
      artist: 'Ed Sheeran',
      title: 'Shape of You',
    });
  });

  it('ignores a featured credit when matching the channel', () => {
    expect(splitArtistTitle('Despacito - Luis Fonsi ft. Daddy Yankee', 'LuisFonsiVEVO').title).toBe(
      'Despacito',
    );
  });

  it('defaults to Artist - Title without a channel signal', () => {
    expect(splitArtistTitle('Alpha - Beta', undefined)).toEqual({ artist: 'Alpha', title: 'Beta' });
  });

  it('falls back to the channel when there is no separator', () => {
    expect(splitArtistTitle('Me at the zoo', 'jawed')).toEqual({ artist: 'jawed', title: 'Me at the zoo' });
  });

  it('never returns an empty title', () => {
    for (const name of ['-', '   ', '(Official Video)', 'A - ']) {
      expect(splitArtistTitle(name, 'Chan').title.length).toBeGreaterThan(0);
    }
  });
});

describe('selectFormat', () => {
  const formats = [
    { itag: 251, url: 'u1', mimeType: 'audio/webm; codecs="opus"', bitrate: 160_000 },
    { itag: 140, url: 'u2', mimeType: 'audio/mp4; codecs="mp4a.40.2"', bitrate: 130_000 },
    { itag: 139, url: 'u3', mimeType: 'audio/mp4; codecs="mp4a.40.5"', bitrate: 49_000 },
    { itag: 18, url: 'u4', mimeType: 'video/mp4', bitrate: 500_000, audioQuality: 'LOW', height: 360 },
    { itag: 137, url: 'u5', mimeType: 'video/mp4', bitrate: 4_000_000, height: 1080 },
  ];

  it('prefers taggable m4a over a higher-bitrate webm', () => {
    expect(selectFormat(formats, 'audio', parseQuality('best'))?.format.itag).toBe(140);
  });

  it('honours an explicit bitrate ceiling', () => {
    expect(selectFormat(formats, 'audio', parseQuality('64k'))?.format.itag).toBe(139);
  });

  it('accepts a slightly-over m4a rather than dropping to an untaggable container', () => {
    const choice = selectFormat(formats, 'audio', parseQuality('128k'));
    expect(choice?.format.itag).toBe(140);
  });

  it('falls back to any audio when no m4a exists', () => {
    const webmOnly = formats.filter((format) => format.itag === 251);
    expect(selectFormat(webmOnly, 'audio', parseQuality('best'))?.format.itag).toBe(251);
  });

  it('takes a combined stream for video so audio is included', () => {
    expect(selectFormat(formats, 'video', parseQuality('1080p'))?.format.itag).toBe(18);
  });

  it('explains why a higher resolution was not used', () => {
    const choice = selectFormat(formats, 'video', parseQuality('1080p'));
    expect(choice?.note).toMatch(/audio included/i);
  });

  it('stays quiet when the requested resolution is met', () => {
    expect(selectFormat(formats, 'video', parseQuality('360p'))?.note).toBeUndefined();
  });

  it('falls back to audio when nothing is combined', () => {
    const adaptiveOnly = formats.filter((format) => format.itag !== 18);
    expect(selectFormat(adaptiveOnly, 'video', parseQuality('best'))?.format.mimeType).toMatch(/^audio/);
  });

  it('ignores formats without a usable URL', () => {
    const ciphered = [{ itag: 140, mimeType: 'audio/mp4', bitrate: 1, signatureCipher: 's=abc' }];
    expect(selectFormat(ciphered, 'audio', parseQuality('best'))).toBeUndefined();
  });

  it('returns undefined for an empty list', () => {
    expect(selectFormat([], 'audio', parseQuality('best'))).toBeUndefined();
  });
});

describe('YouTube playlist parsing', () => {
  it('reads the current lockupViewModel shape', () => {
    const data = {
      contents: [
        {
          lockupViewModel: {
            contentId: 'aaaaaaaaaaa',
            contentType: 'LOCKUP_CONTENT_TYPE_VIDEO',
            metadata: { lockupMetadataViewModel: { title: { content: 'First Song' } } },
          },
        },
        {
          lockupViewModel: {
            contentId: 'bbbbbbbbbbb',
            contentType: 'LOCKUP_CONTENT_TYPE_VIDEO',
            metadata: { lockupMetadataViewModel: { title: { content: 'Second Song' } } },
          },
        },
      ],
    };
    expect(extractPlaylistEntries(data)).toEqual([
      { videoId: 'aaaaaaaaaaa', title: 'First Song', author: undefined },
      { videoId: 'bbbbbbbbbbb', title: 'Second Song', author: undefined },
    ]);
  });

  it('still reads the legacy playlistVideoRenderer shape', () => {
    const data = {
      items: [
        { playlistVideoRenderer: { videoId: 'ccccccccccc', title: { runs: [{ text: 'Legacy Song' }] } } },
      ],
    };
    expect(extractPlaylistEntries(data)[0]).toMatchObject({
      videoId: 'ccccccccccc',
      title: 'Legacy Song',
    });
  });

  it('reads simpleText titles', () => {
    const data = { x: { videoId: 'ddddddddddd', title: { simpleText: 'Simple' } } };
    expect(extractPlaylistEntries(data)[0]?.title).toBe('Simple');
  });

  it('preserves playlist order and de-duplicates repeats', () => {
    const entry = (id: string) => ({
      lockupViewModel: { contentId: id, contentType: 'VIDEO', metadata: {} },
    });
    const ids = extractPlaylistEntries([entry('aaaaaaaaaaa'), entry('bbbbbbbbbbb'), entry('aaaaaaaaaaa')]).map(
      (e) => e.videoId,
    );
    expect(ids).toEqual(['aaaaaaaaaaa', 'bbbbbbbbbbb']);
  });

  it('ignores ids that are not video ids', () => {
    const data = { lockupViewModel: { contentId: 'too-short', contentType: 'VIDEO', metadata: {} } };
    expect(extractPlaylistEntries(data)).toEqual([]);
  });

  it('survives junk input', () => {
    expect(extractPlaylistEntries(null)).toEqual([]);
    expect(extractPlaylistEntries({})).toEqual([]);
    expect(extractPlaylistEntries([1, 'x', true])).toEqual([]);
  });

  it('parses ytInitialData out of a page', () => {
    const html = `<script>var ytInitialData = {"a":1};</script>`;
    expect(parseInitialData(html)).toEqual({ a: 1 });
  });

  it('returns undefined when the blob is absent or malformed', () => {
    expect(parseInitialData('<html></html>')).toBeUndefined();
    expect(parseInitialData('var ytInitialData = {broken;</script>')).toBeUndefined();
  });

  it('reads the playlist title from the microformat block', () => {
    const data = {
      microformat: {
        microformatDataRenderer: { urlCanonical: 'http://x/playlist', title: 'Popular Music Videos' },
      },
    };
    expect(extractPlaylistTitle(data)).toBe('Popular Music Videos');
  });
});

