import { readFile, rename, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { FilesystemError, VectraxError, errorMessage, wrapFsError } from '../errors.js';
import { removeQuietly } from '../util/fs.js';
import { isFlac, readFlac, writeFlac } from './flac.js';
import { findId3Tag, readId3, writeId3 } from './id3.js';
import { isMp4, readMp4, writeMp4 } from './mp4.js';
import type { Artwork, TrackMetadata } from './types.js';

export type TagFormat = 'id3' | 'flac' | 'mp4';

const EXTENSION_FORMATS: Record<string, TagFormat> = {
  '.mp3': 'id3',
  '.flac': 'flac',
  '.m4a': 'mp4',
  '.mp4': 'mp4',
  '.m4b': 'mp4',
  '.m4v': 'mp4',
  '.aac': 'id3',
};

export function supportsTagging(filename: string): boolean {
  return path.extname(filename).toLowerCase() in EXTENSION_FORMATS;
}

export function supportsArtwork(filename: string): boolean {
  return supportsTagging(filename);
}

export function detectFormat(buffer: Buffer, filename: string): TagFormat | undefined {
  if (isFlac(buffer)) return 'flac';
  if (isMp4(buffer)) return 'mp4';
  if (findId3Tag(buffer) !== undefined) return 'id3';
  if (buffer.length > 2 && buffer[0] === 0xff && ((buffer[1] as number) & 0xe0) === 0xe0) return 'id3';
  return EXTENSION_FORMATS[path.extname(filename).toLowerCase()];
}

export function readTagsFromBuffer(buffer: Buffer, filename: string): TrackMetadata {
  switch (detectFormat(buffer, filename)) {
    case 'flac':
      return readFlac(buffer);
    case 'mp4':
      return readMp4(buffer);
    case 'id3':
      return readId3(buffer);
    default:
      return {};
  }
}

export function writeTagsToBuffer(buffer: Buffer, filename: string, metadata: TrackMetadata): Buffer {
  switch (detectFormat(buffer, filename)) {
    case 'flac':
      return writeFlac(buffer, metadata);
    case 'mp4':
      return writeMp4(buffer, metadata);
    case 'id3':
      return writeId3(buffer, metadata);
    default:
      throw new VectraxError(`Cannot tag ${path.basename(filename)}: unrecognised audio container.`, {
        code: 'E_USAGE',
        hint: `Supported formats: ${[...new Set(Object.keys(EXTENSION_FORMATS))].join(', ')}.`,
      });
  }
}

const MAX_TAG_FILE_BYTES = 512 * 1024 * 1024;

export async function readTags(file: string): Promise<TrackMetadata> {
  let buffer: Buffer;
  try {
    buffer = await readFile(file);
  } catch (error) {
    throw wrapFsError(error, 'read file', file);
  }
  return readTagsFromBuffer(buffer, file);
}

export async function writeTags(file: string, metadata: TrackMetadata): Promise<void> {
  const info = await stat(file).catch((error: unknown) => {
    throw wrapFsError(error, 'stat file', file);
  });
  if (info.size > MAX_TAG_FILE_BYTES) {
    throw new FilesystemError(`Refusing to tag ${path.basename(file)}: file is larger than 512 MB.`, {
      hint: 'Tagging rewrites the container in memory.',
    });
  }

  const buffer = await readFile(file).catch((error: unknown) => {
    throw wrapFsError(error, 'read file', file);
  });
  const updated = writeTagsToBuffer(buffer, file, metadata);

  const staging = `${file}.vxtag`;
  try {
    await writeFile(staging, updated);
    await rename(staging, file);
  } catch (error) {
    await removeQuietly(staging);
    throw wrapFsError(error, 'write tags to', file);
  }
}

export function detectImageMime(data: Buffer): string | undefined {
  if (data.length > 8 && data.readUInt32BE(0) === 0x89504e47) return 'image/png';
  if (data.length > 3 && data[0] === 0xff && data[1] === 0xd8) return 'image/jpeg';
  if (data.length > 12 && data.toString('latin1', 0, 4) === 'RIFF' && data.toString('latin1', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  if (data.length > 6 && data.toString('latin1', 0, 3) === 'GIF') return 'image/gif';
  return undefined;
}

export function toArtwork(data: Buffer, description?: string): Artwork {
  const mime = detectImageMime(data);
  if (mime === undefined) {
    throw new VectraxError('That file is not a recognised image (expected PNG, JPEG, WebP, or GIF).', {
      code: 'E_USAGE',
    });
  }
  return { mime, data, ...(description !== undefined ? { description } : {}) };
}

export function artworkExtension(artwork: Artwork): string {
  return artwork.mime.includes('png')
    ? '.png'
    : artwork.mime.includes('webp')
      ? '.webp'
      : artwork.mime.includes('gif')
        ? '.gif'
        : '.jpg';
}

export async function readArtworkFile(file: string): Promise<Artwork> {
  try {
    return toArtwork(await readFile(file), path.basename(file));
  } catch (error) {
    if (error instanceof VectraxError) throw error;
    throw new FilesystemError(`Cannot read artwork file: ${file} (${errorMessage(error)})`, { cause: error });
  }
}
