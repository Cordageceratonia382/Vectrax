import type { Artwork, TrackMetadata } from './types.js';

const MAGIC = 'fLaC';

const BlockType = {
  StreamInfo: 0,
  Padding: 1,
  VorbisComment: 4,
  Picture: 6,
} as const;

interface MetadataBlock {
  type: number;
  last: boolean;
  data: Buffer;
}

export function isFlac(buffer: Buffer): boolean {
  return buffer.length >= 4 && buffer.toString('latin1', 0, 4) === MAGIC;
}

function parseBlocks(buffer: Buffer): { blocks: MetadataBlock[]; audioOffset: number } {
  const blocks: MetadataBlock[] = [];
  let offset = 4;

  while (offset + 4 <= buffer.length) {
    const header = buffer[offset] as number;
    const last = (header & 0x80) !== 0;
    const type = header & 0x7f;
    const size = buffer.readUIntBE(offset + 1, 3);
    const start = offset + 4;
    const end = start + size;
    if (end > buffer.length) break;

    blocks.push({ type, last, data: buffer.subarray(start, end) });
    offset = end;
    if (last) break;
  }

  return { blocks, audioOffset: offset };
}

function encodeBlock(block: MetadataBlock, last: boolean): Buffer {
  const header = Buffer.alloc(4);
  header[0] = (last ? 0x80 : 0) | (block.type & 0x7f);
  header.writeUIntBE(block.data.length, 1, 3);
  return Buffer.concat([header, block.data]);
}

function parseVorbisComments(data: Buffer): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (data.length < 8) return out;

  let offset = 0;
  const vendorLength = data.readUInt32LE(offset);
  offset += 4 + vendorLength;
  if (offset + 4 > data.length) return out;

  const count = data.readUInt32LE(offset);
  offset += 4;

  for (let i = 0; i < count && offset + 4 <= data.length; i++) {
    const length = data.readUInt32LE(offset);
    offset += 4;
    if (offset + length > data.length) break;
    const entry = data.toString('utf8', offset, offset + length);
    offset += length;

    const separator = entry.indexOf('=');
    if (separator === -1) continue;
    const key = entry.slice(0, separator).toUpperCase();
    const value = entry.slice(separator + 1);
    out.set(key, [...(out.get(key) ?? []), value]);
  }
  return out;
}

function encodeVorbisComments(fields: [string, string][], vendor = 'Vectrax'): Buffer {
  const vendorBytes = Buffer.from(vendor, 'utf8');
  const entries = fields.map(([key, value]) => {
    const bytes = Buffer.from(`${key}=${value}`, 'utf8');
    const length = Buffer.alloc(4);
    length.writeUInt32LE(bytes.length);
    return Buffer.concat([length, bytes]);
  });

  const vendorLength = Buffer.alloc(4);
  vendorLength.writeUInt32LE(vendorBytes.length);
  const count = Buffer.alloc(4);
  count.writeUInt32LE(entries.length);

  return Buffer.concat([vendorLength, vendorBytes, count, ...entries]);
}

function parsePicture(data: Buffer): Artwork | undefined {
  try {
    let offset = 4;
    const mimeLength = data.readUInt32BE(offset);
    offset += 4;
    const mime = data.toString('latin1', offset, offset + mimeLength);
    offset += mimeLength;

    const descLength = data.readUInt32BE(offset);
    offset += 4;
    const description = data.toString('utf8', offset, offset + descLength);
    offset += descLength;

    offset += 16;
    const dataLength = data.readUInt32BE(offset);
    offset += 4;
    const payload = data.subarray(offset, offset + dataLength);

    return payload.length > 0
      ? { mime, data: Buffer.from(payload), description: description === '' ? undefined : description }
      : undefined;
  } catch {
    return undefined;
  }
}

function encodePicture(artwork: Artwork): Buffer {
  const mime = Buffer.from(artwork.mime, 'latin1');
  const description = Buffer.from(artwork.description ?? '', 'utf8');
  const dimensions = imageDimensions(artwork.data);

  const buffer = Buffer.alloc(32 + mime.length + description.length + artwork.data.length);
  let offset = 0;
  const u32 = (value: number) => {
    buffer.writeUInt32BE(value, offset);
    offset += 4;
  };

  u32(3);
  u32(mime.length);
  mime.copy(buffer, offset);
  offset += mime.length;
  u32(description.length);
  description.copy(buffer, offset);
  offset += description.length;
  u32(dimensions?.width ?? 0);
  u32(dimensions?.height ?? 0);
  u32(24);
  u32(0);
  u32(artwork.data.length);
  artwork.data.copy(buffer, offset);

  return buffer;
}

export function imageDimensions(data: Buffer): { width: number; height: number } | undefined {
  if (data.length > 24 && data.readUInt32BE(0) === 0x89504e47) {
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  }
  if (data.length > 4 && data[0] === 0xff && data[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < data.length) {
      if (data[offset] !== 0xff) {
        offset++;
        continue;
      }
      const marker = data[offset + 1] as number;
      const length = data.readUInt16BE(offset + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: data.readUInt16BE(offset + 5), width: data.readUInt16BE(offset + 7) };
      }
      offset += 2 + length;
    }
  }
  return undefined;
}

const TEXT_KEYS: [keyof TrackMetadata, string][] = [
  ['title', 'TITLE'],
  ['artist', 'ARTIST'],
  ['album', 'ALBUM'],
  ['albumArtist', 'ALBUMARTIST'],
  ['genre', 'GENRE'],
  ['composer', 'COMPOSER'],
  ['comment', 'COMMENT'],
  ['sourceUrl', 'SOURCEURL'],
];

const NUMERIC_KEYS: [keyof TrackMetadata, string][] = [
  ['track', 'TRACKNUMBER'],
  ['trackTotal', 'TRACKTOTAL'],
  ['disc', 'DISCNUMBER'],
  ['discTotal', 'DISCTOTAL'],
];

export function readFlac(buffer: Buffer): TrackMetadata {
  if (!isFlac(buffer)) return {};
  const { blocks } = parseBlocks(buffer);
  const metadata: TrackMetadata = {};

  for (const block of blocks) {
    if (block.type === BlockType.VorbisComment) {
      const comments = parseVorbisComments(block.data);
      const first = (key: string): string | undefined => comments.get(key)?.[0];

      for (const [field, key] of TEXT_KEYS) {
        const value = first(key);
        if (value !== undefined && value !== '') Object.assign(metadata, { [field]: value });
      }
      for (const [field, key] of NUMERIC_KEYS) {
        const raw = first(key);
        const value = Number.parseInt(raw?.split('/')[0] ?? '', 10);
        if (Number.isFinite(value) && value > 0) Object.assign(metadata, { [field]: value });
      }
      const pair = first('TRACKNUMBER')?.split('/')[1];
      if (metadata.trackTotal === undefined && pair !== undefined) {
        const total = Number.parseInt(pair, 10);
        if (Number.isFinite(total) && total > 0) metadata.trackTotal = total;
      }

      const year = Number.parseInt((first('DATE') ?? first('YEAR') ?? '').slice(0, 4), 10);
      if (Number.isFinite(year) && year > 0) metadata.year = year;
    } else if (block.type === BlockType.Picture && metadata.artwork === undefined) {
      const artwork = parsePicture(block.data);
      if (artwork !== undefined) metadata.artwork = artwork;
    }
  }

  return metadata;
}

export function writeFlac(buffer: Buffer, metadata: TrackMetadata): Buffer {
  if (!isFlac(buffer)) return buffer;
  const { blocks, audioOffset } = parseBlocks(buffer);

  const fields: [string, string][] = [];
  for (const [field, key] of TEXT_KEYS) {
    const value = metadata[field];
    if (typeof value === 'string' && value !== '') fields.push([key, value]);
  }
  for (const [field, key] of NUMERIC_KEYS) {
    const value = metadata[field];
    if (typeof value === 'number') fields.push([key, String(value)]);
  }
  if (metadata.year !== undefined) fields.push(['DATE', String(metadata.year)]);

  const preserved = blocks.filter(
    (block) =>
      block.type !== BlockType.VorbisComment &&
      block.type !== BlockType.Picture &&
      block.type !== BlockType.Padding,
  );

  const rebuilt: MetadataBlock[] = [
    ...preserved,
    { type: BlockType.VorbisComment, last: false, data: encodeVorbisComments(fields) },
  ];
  if (metadata.artwork !== undefined) {
    rebuilt.push({ type: BlockType.Picture, last: false, data: encodePicture(metadata.artwork) });
  }

  const encoded = rebuilt.map((block, index) => encodeBlock(block, index === rebuilt.length - 1));
  return Buffer.concat([Buffer.from(MAGIC, 'latin1'), ...encoded, buffer.subarray(audioOffset)]);
}
