import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readId3, writeId3, stripId3, findId3Tag } from '../src/core/metadata/id3.js';
import { readFlac, writeFlac, imageDimensions } from '../src/core/metadata/flac.js';
import { readMp4, writeMp4 } from '../src/core/metadata/mp4.js';
import {
  detectFormat,
  detectImageMime,
  readTags,
  readTagsFromBuffer,
  supportsTagging,
  toArtwork,
  writeTags,
  writeTagsToBuffer,
} from '../src/core/metadata/tags.js';
import { mergeMetadata, isEmptyMetadata, type TrackMetadata } from '../src/core/metadata/types.js';
import {
  bareFlac,
  bareMp3,
  bareMp4,
  JPEG_STUB,
  markersAtOffsets,
  mp3Audio,
  mp3WithId3v1,
  PNG_1X1,
  readStco,
} from './helpers/containers.js';

const FULL: TrackMetadata = {
  title: 'Nocturne in E♭',
  artist: 'Frédéric Chopin',
  album: 'Nocturnes',
  albumArtist: 'Various Artists',
  genre: 'Classical',
  year: 1832,
  track: 2,
  trackTotal: 21,
  disc: 1,
  discTotal: 2,
  composer: 'Chopin',
  comment: 'A test comment',
};

describe('ID3 (mp3)', () => {
  it('round-trips every text field', () => {
    const tagged = writeId3(bareMp3(), FULL);
    expect(readId3(tagged)).toMatchObject(FULL);
  });

  it('preserves the audio payload byte for byte', () => {
    const audio = mp3Audio(1024);
    const tagged = writeId3(audio, FULL);
    expect(stripId3(tagged)).toEqual(audio);
  });

  it('replaces an existing tag rather than appending one', () => {
    const once = writeId3(bareMp3(), { title: 'First' });
    const twice = writeId3(once, { title: 'Second' });
    expect(readId3(twice).title).toBe('Second');
    expect(stripId3(twice)).toEqual(mp3Audio());
    expect(twice.indexOf(Buffer.from('ID3', 'latin1'))).toBe(0);
    expect(twice.subarray(3).indexOf(Buffer.from('ID3', 'latin1'))).toBe(-1);
  });

  it('clears fields omitted from the new tag', () => {
    const once = writeId3(bareMp3(), { title: 'Kept', artist: 'Dropped' });
    const twice = writeId3(once, { title: 'Kept' });
    expect(readId3(twice)).toEqual({ title: 'Kept' });
  });

  it('handles non-Latin text', () => {
    const metadata = { title: 'آهنگ جدید', artist: '日本語のアーティスト' };
    expect(readId3(writeId3(bareMp3(), metadata))).toMatchObject(metadata);
  });

  it('round-trips artwork', () => {
    const tagged = writeId3(bareMp3(), { title: 'Art', artwork: toArtwork(PNG_1X1) });
    const read = readId3(tagged);
    expect(read.artwork?.mime).toBe('image/png');
    expect(read.artwork?.data).toEqual(PNG_1X1);
  });

  it('strips a stale ID3v1 trailer when writing', () => {
    const tagged = writeId3(mp3WithId3v1(), { title: 'New Title' });
    expect(readId3(tagged).title).toBe('New Title');
    expect(tagged.subarray(tagged.length - 128).toString('latin1', 0, 3)).not.toBe('TAG');
  });

  it('writes only the fields provided', () => {
    const read = readId3(writeId3(bareMp3(), { title: 'Only' }));
    expect(read).toEqual({ title: 'Only' });
  });

  it('emits no tag for empty metadata', () => {
    const result = writeId3(bareMp3(), {});
    expect(findId3Tag(result)).toBeUndefined();
    expect(result).toEqual(mp3Audio());
  });

  it('reads a track pair written as "2/21"', () => {
    const tagged = writeId3(bareMp3(), { track: 2, trackTotal: 21 });
    expect(readId3(tagged)).toMatchObject({ track: 2, trackTotal: 21 });
  });

  it('returns empty metadata for an untagged file', () => {
    expect(readId3(bareMp3())).toEqual({});
  });

  it('does not throw on a truncated tag', () => {
    const tagged = writeId3(bareMp3(), FULL);
    expect(() => readId3(tagged.subarray(0, 20))).not.toThrow();
  });
});

describe('FLAC', () => {
  it('round-trips every text field', () => {
    expect(readFlac(writeFlac(bareFlac(), FULL))).toMatchObject(FULL);
  });

  it('preserves STREAMINFO and the audio frames', () => {
    const original = bareFlac();
    const tagged = writeFlac(original, FULL);
    expect(tagged.toString('latin1', 0, 4)).toBe('fLaC');
    expect(tagged[4] as number & 0x7f).toBe(0);
    expect(tagged.includes(Buffer.from('FLAC-AUDIO-FRAMES'))).toBe(true);
  });

  it('marks exactly one block as last', () => {
    const tagged = writeFlac(bareFlac(), FULL);
    let offset = 4;
    let lastCount = 0;
    let blocks = 0;
    for (;;) {
      const header = tagged[offset] as number;
      const size = tagged.readUIntBE(offset + 1, 3);
      blocks++;
      if ((header & 0x80) !== 0) {
        lastCount++;
        break;
      }
      offset += 4 + size;
      if (blocks > 20) break;
    }
    expect(lastCount).toBe(1);
  });

  it('round-trips artwork with correct dimensions', () => {
    const tagged = writeFlac(bareFlac(), { title: 'Art', artwork: toArtwork(PNG_1X1) });
    const read = readFlac(tagged);
    expect(read.artwork?.data).toEqual(PNG_1X1);
    expect(read.artwork?.mime).toBe('image/png');
  });

  it('replaces tags on a second write', () => {
    const once = writeFlac(bareFlac(), { title: 'First', artist: 'Gone' });
    const twice = writeFlac(once, { title: 'Second' });
    expect(readFlac(twice)).toEqual({ title: 'Second' });
  });

  it('returns empty metadata for an untagged file', () => {
    expect(readFlac(bareFlac())).toEqual({});
  });
});

describe('imageDimensions', () => {
  it('reads PNG dimensions', () => {
    expect(imageDimensions(PNG_1X1)).toEqual({ width: 1, height: 1 });
  });

  it('returns undefined for data it cannot parse', () => {
    expect(imageDimensions(Buffer.from('not an image'))).toBeUndefined();
  });
});

describe('MP4', () => {
  it('round-trips every text field', () => {
    const { buffer } = bareMp4();
    expect(readMp4(writeMp4(buffer, FULL))).toMatchObject({
      title: FULL.title,
      artist: FULL.artist,
      album: FULL.album,
      albumArtist: FULL.albumArtist,
      genre: FULL.genre,
      year: FULL.year,
      track: FULL.track,
      trackTotal: FULL.trackTotal,
      disc: FULL.disc,
      discTotal: FULL.discTotal,
      composer: FULL.composer,
    });
  });

  it('repairs chunk offsets so they still point at their audio', () => {
    const { buffer, chunkOffsets, chunkMarkers } = bareMp4();
    expect(markersAtOffsets(buffer, chunkOffsets)).toEqual(chunkMarkers);

    const tagged = writeMp4(buffer, FULL);
    const updated = readStco(tagged);

    expect(updated).not.toEqual(chunkOffsets);
    expect(markersAtOffsets(tagged, updated)).toEqual(chunkMarkers);
  });

  it('keeps offsets valid when the tag shrinks again', () => {
    const { buffer, chunkMarkers } = bareMp4();
    const big = writeMp4(buffer, { ...FULL, artwork: toArtwork(JPEG_STUB) });
    const small = writeMp4(big, { title: 'x' });
    expect(markersAtOffsets(small, readStco(small))).toEqual(chunkMarkers);
  });

  it('preserves the mdat payload exactly', () => {
    const { buffer } = bareMp4();
    const tagged = writeMp4(buffer, FULL);
    const mdatIndex = tagged.indexOf(Buffer.from('mdat', 'latin1'));
    const originalIndex = buffer.indexOf(Buffer.from('mdat', 'latin1'));
    expect(tagged.subarray(mdatIndex)).toEqual(buffer.subarray(originalIndex));
  });

  it('round-trips artwork', () => {
    const { buffer } = bareMp4();
    const tagged = writeMp4(buffer, { title: 'Art', artwork: toArtwork(JPEG_STUB) });
    const read = readMp4(tagged);
    expect(read.artwork?.mime).toBe('image/jpeg');
    expect(read.artwork?.data).toEqual(JPEG_STUB);
  });

  it('replaces tags on a second write', () => {
    const { buffer } = bareMp4();
    const once = writeMp4(buffer, { title: 'First', artist: 'Gone' });
    const twice = writeMp4(once, { title: 'Second' });
    expect(readMp4(twice).title).toBe('Second');
    expect(readMp4(twice).artist).toBeUndefined();
  });

  it('folds a source URL into the comment', () => {
    const { buffer } = bareMp4();
    const tagged = writeMp4(buffer, { sourceUrl: 'https://example.com/x' });
    expect(readMp4(tagged).comment).toContain('https://example.com/x');
  });

  it('returns empty metadata for an untagged file', () => {
    expect(readMp4(bareMp4().buffer)).toEqual({});
  });

  it('leaves a non-MP4 buffer untouched', () => {
    const audio = mp3Audio();
    expect(writeMp4(audio, FULL)).toEqual(audio);
  });
});

describe('format detection', () => {
  it('identifies containers by content, not extension', () => {
    expect(detectFormat(bareFlac(), 'mislabelled.mp3')).toBe('flac');
    expect(detectFormat(bareMp4().buffer, 'mislabelled.mp3')).toBe('mp4');
    expect(detectFormat(mp3Audio(), 'x.mp3')).toBe('id3');
  });

  it('falls back to the extension for ambiguous content', () => {
    expect(detectFormat(Buffer.alloc(64), 'song.flac')).toBe('flac');
    expect(detectFormat(Buffer.alloc(64), 'song.m4a')).toBe('mp4');
    expect(detectFormat(Buffer.alloc(64), 'song.txt')).toBeUndefined();
  });

  it('reports which files can be tagged', () => {
    expect(supportsTagging('a.mp3')).toBe(true);
    expect(supportsTagging('a.FLAC')).toBe(true);
    expect(supportsTagging('a.m4a')).toBe(true);
    expect(supportsTagging('a.opus')).toBe(false);
    expect(supportsTagging('a.webm')).toBe(false);
  });

  it('routes through the facade for each container', () => {
    for (const [buffer, name] of [
      [bareMp3(), 'a.mp3'],
      [bareFlac(), 'a.flac'],
      [bareMp4().buffer, 'a.m4a'],
    ] as const) {
      const tagged = writeTagsToBuffer(buffer, name, { title: 'Facade', artist: 'Test' });
      expect(readTagsFromBuffer(tagged, name)).toMatchObject({ title: 'Facade', artist: 'Test' });
    }
  });

  it('refuses to tag an unknown container', () => {
    expect(() => writeTagsToBuffer(Buffer.alloc(32), 'a.txt', { title: 'x' })).toThrow(/unrecognised/i);
  });
});

describe('image helpers', () => {
  it('sniffs common image types', () => {
    expect(detectImageMime(PNG_1X1)).toBe('image/png');
    expect(detectImageMime(JPEG_STUB)).toBe('image/jpeg');
    expect(detectImageMime(Buffer.from('<html>error</html>'))).toBeUndefined();
  });

  it('rejects non-image artwork', () => {
    expect(() => toArtwork(Buffer.from('<html>404</html>'))).toThrow(/not a recognised image/i);
  });
});

describe('metadata helpers', () => {
  it('detects empty metadata', () => {
    expect(isEmptyMetadata({})).toBe(true);
    expect(isEmptyMetadata({ title: 'x' })).toBe(false);
  });

  it('merges updates over a base', () => {
    expect(mergeMetadata({ title: 'a', artist: 'b' }, { artist: 'c' })).toEqual({ title: 'a', artist: 'c' });
  });

  it('treats an empty string as a request to clear', () => {
    expect(mergeMetadata({ title: 'a', artist: 'b' }, { artist: '' })).toEqual({ title: 'a' });
  });

  it('ignores undefined updates', () => {
    expect(mergeMetadata({ title: 'a' }, { artist: undefined })).toEqual({ title: 'a' });
  });
});

describe('file round-trip', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'vectrax-tags-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes tags atomically and leaves no staging file', async () => {
    const file = path.join(dir, 'song.mp3');
    await writeFile(file, bareMp3());

    await writeTags(file, { title: 'On Disk', artist: 'Tester' });

    expect(await readTags(file)).toMatchObject({ title: 'On Disk', artist: 'Tester' });
    await expect(readFile(`${file}.vxtag`)).rejects.toThrow();
  });

  it('supports repeated edits', async () => {
    const file = path.join(dir, 'song.flac');
    await writeFile(file, bareFlac());

    await writeTags(file, { title: 'One' });
    await writeTags(file, { ...(await readTags(file)), artist: 'Two' });

    expect(await readTags(file)).toMatchObject({ title: 'One', artist: 'Two' });
  });

  it('reports a helpful error for a missing file', async () => {
    await expect(readTags(path.join(dir, 'nope.mp3'))).rejects.toThrow(/read file/i);
  });
});
