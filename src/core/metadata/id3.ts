import type { Artwork, TrackMetadata } from './types.js';

const HEADER_SIZE = 10;

function readSynchsafe(buffer: Buffer, offset: number): number {
  return (
    ((buffer[offset] as number) & 0x7f) * 0x200000 +
    ((buffer[offset + 1] as number) & 0x7f) * 0x4000 +
    ((buffer[offset + 2] as number) & 0x7f) * 0x80 +
    ((buffer[offset + 3] as number) & 0x7f)
  );
}

function writeSynchsafe(value: number): Buffer {
  return Buffer.from([
    (value >>> 21) & 0x7f,
    (value >>> 14) & 0x7f,
    (value >>> 7) & 0x7f,
    value & 0x7f,
  ]);
}

export function findId3Tag(buffer: Buffer): { start: number; end: number; version: number } | undefined {
  if (buffer.length < HEADER_SIZE) return undefined;
  if (buffer.toString('latin1', 0, 3) !== 'ID3') return undefined;

  const version = buffer[3] as number;
  const flags = buffer[5] as number;
  const size = readSynchsafe(buffer, 6);
  const footer = (flags & 0x10) !== 0 ? 10 : 0;
  return { start: 0, end: HEADER_SIZE + size + footer, version };
}

export function stripId3(buffer: Buffer): Buffer {
  const tag = findId3Tag(buffer);
  let audio = tag !== undefined ? buffer.subarray(tag.end) : buffer;

  if (audio.length >= 128 && audio.toString('latin1', audio.length - 128, audio.length - 125) === 'TAG') {
    audio = audio.subarray(0, audio.length - 128);
  }
  return audio;
}

function deunsynchronise(buffer: Buffer): Buffer {
  const out: number[] = [];
  for (let i = 0; i < buffer.length; i++) {
    out.push(buffer[i] as number);
    if (buffer[i] === 0xff && buffer[i + 1] === 0x00) i++;
  }
  return Buffer.from(out);
}

function decodeText(buffer: Buffer): string {
  if (buffer.length === 0) return '';
  const encoding = buffer[0] as number;
  const body = buffer.subarray(1);
  switch (encoding) {
    case 0:
      return trimNull(body.toString('latin1'));
    case 1:
      return trimNull(decodeUtf16WithBom(body));
    case 2:
      return trimNull(body.swap16().toString('utf16le'));
    default:
      return trimNull(body.toString('utf8'));
  }
}

function decodeUtf16WithBom(buffer: Buffer): string {
  if (buffer.length < 2) return '';
  const bom = buffer.readUInt16LE(0);
  if (bom === 0xfeff) return buffer.subarray(2).toString('utf16le');
  if (bom === 0xfffe) return Buffer.from(buffer.subarray(2)).swap16().toString('utf16le');
  return buffer.toString('utf16le');
}

const trimNull = (value: string): string => value.replace(/\u0000+$/, '').trim();

const FRAMES_V22: Record<string, string> = {
  TT2: 'TIT2', TP1: 'TPE1', TAL: 'TALB', TP2: 'TPE2', TCO: 'TCON',
  TYE: 'TDRC', TRK: 'TRCK', TPA: 'TPOS', COM: 'COMM', PIC: 'APIC', TCM: 'TCOM',
};

export function readId3(buffer: Buffer): TrackMetadata {
  const tag = findId3Tag(buffer);
  if (tag === undefined) return {};

  const major = buffer[3] as number;
  const flags = buffer[5] as number;
  let body = buffer.subarray(HEADER_SIZE, tag.end);
  if ((flags & 0x80) !== 0) body = deunsynchronise(body);

  let offset = 0;
  if ((flags & 0x40) !== 0 && body.length >= 4) {
    offset += major >= 4 ? readSynchsafe(body, 0) : body.readUInt32BE(0) + 4;
  }

  const metadata: TrackMetadata = {};
  const idLength = major <= 2 ? 3 : 4;
  const sizeLength = major <= 2 ? 3 : 4;

  while (offset + idLength + sizeLength <= body.length) {
    const rawId = body.toString('latin1', offset, offset + idLength);
    if (!/^[A-Z0-9]{3,4}$/.test(rawId)) break;

    let size: number;
    if (major <= 2) size = body.readUIntBE(offset + 3, 3);
    else if (major === 3) size = body.readUInt32BE(offset + 4);
    else size = readSynchsafe(body, offset + 4);

    const headerLength = idLength + sizeLength + (major <= 2 ? 0 : 2);
    const start = offset + headerLength;
    const end = start + size;
    if (size <= 0 || end > body.length) break;

    const id = major <= 2 ? (FRAMES_V22[rawId] ?? rawId) : rawId;
    applyFrame(metadata, id, body.subarray(start, end));
    offset = end;
  }

  return metadata;
}

function applyFrame(metadata: TrackMetadata, id: string, data: Buffer): void {
  switch (id) {
    case 'TIT2': metadata.title = decodeText(data); return;
    case 'TPE1': metadata.artist = decodeText(data); return;
    case 'TALB': metadata.album = decodeText(data); return;
    case 'TPE2': metadata.albumArtist = decodeText(data); return;
    case 'TCON': metadata.genre = normaliseGenre(decodeText(data)); return;
    case 'TCOM': metadata.composer = decodeText(data); return;
    case 'TDRC':
    case 'TYER':
    case 'TDAT': {
      const year = Number.parseInt(decodeText(data).slice(0, 4), 10);
      if (Number.isFinite(year) && year > 0) metadata.year = year;
      return;
    }
    case 'TRCK': {
      const [track, total] = splitPair(decodeText(data));
      if (track !== undefined) metadata.track = track;
      if (total !== undefined) metadata.trackTotal = total;
      return;
    }
    case 'TPOS': {
      const [disc, total] = splitPair(decodeText(data));
      if (disc !== undefined) metadata.disc = disc;
      if (total !== undefined) metadata.discTotal = total;
      return;
    }
    case 'COMM': {
      if (data.length < 5) return;
      const encoding = data[0] as number;
      const rest = data.subarray(4);
      const separator = encoding === 1 || encoding === 2 ? findDoubleNull(rest) : rest.indexOf(0);
      const textStart = separator === -1 ? 0 : separator + (encoding === 1 || encoding === 2 ? 2 : 1);
      metadata.comment = decodeText(Buffer.concat([Buffer.from([encoding]), rest.subarray(textStart)]));
      return;
    }
    case 'WXXX':
    case 'WOAF': {
      const url = trimNull(data.subarray(data.indexOf(0) + 1).toString('latin1'));
      if (url !== '' && metadata.sourceUrl === undefined) metadata.sourceUrl = url;
      return;
    }
    case 'APIC': {
      const artwork = readApic(data);
      if (artwork !== undefined) metadata.artwork = artwork;
      return;
    }
    default:
      return;
  }
}

function readApic(data: Buffer): Artwork | undefined {
  if (data.length < 4) return undefined;
  const encoding = data[0] as number;
  const mimeEnd = data.indexOf(0, 1);
  if (mimeEnd === -1) return undefined;

  let mime = data.toString('latin1', 1, mimeEnd);
  if (mime.length <= 4 && !mime.includes('/')) mime = `image/${mime.toLowerCase() === 'png' ? 'png' : 'jpeg'}`;

  let cursor = mimeEnd + 2;
  const wide = encoding === 1 || encoding === 2;
  const descEnd = wide ? findDoubleNull(data.subarray(cursor)) : data.subarray(cursor).indexOf(0);
  if (descEnd === -1) return undefined;
  cursor += descEnd + (wide ? 2 : 1);

  const payload = data.subarray(cursor);
  return payload.length > 0 ? { mime, data: Buffer.from(payload) } : undefined;
}

function findDoubleNull(buffer: Buffer): number {
  for (let i = 0; i + 1 < buffer.length; i += 2) {
    if (buffer[i] === 0 && buffer[i + 1] === 0) return i;
  }
  return -1;
}

function splitPair(value: string): [number | undefined, number | undefined] {
  const [first, second] = value.split('/');
  const toNumber = (v: string | undefined) => {
    const n = Number.parseInt(v ?? '', 10);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  return [toNumber(first), toNumber(second)];
}

const ID3V1_GENRES = [
  'Blues', 'Classic Rock', 'Country', 'Dance', 'Disco', 'Funk', 'Grunge', 'Hip-Hop', 'Jazz', 'Metal',
  'New Age', 'Oldies', 'Other', 'Pop', 'R&B', 'Rap', 'Reggae', 'Rock', 'Techno', 'Industrial',
  'Alternative', 'Ska', 'Death Metal', 'Pranks', 'Soundtrack', 'Euro-Techno', 'Ambient', 'Trip-Hop',
  'Vocal', 'Jazz+Funk', 'Fusion', 'Trance', 'Classical', 'Instrumental', 'Acid', 'House', 'Game',
  'Sound Clip', 'Gospel', 'Noise', 'AlternRock', 'Bass', 'Soul', 'Punk', 'Space', 'Meditative',
];

function normaliseGenre(value: string): string {
  const numeric = /^\((\d+)\)$/.exec(value.trim());
  if (numeric?.[1] !== undefined) return ID3V1_GENRES[Number(numeric[1])] ?? value;
  if (/^\d+$/.test(value.trim())) return ID3V1_GENRES[Number(value.trim())] ?? value;
  return value;
}

function textFrame(id: string, value: string): Buffer {
  const payload = Buffer.concat([Buffer.from([3]), Buffer.from(value, 'utf8')]);
  return frame(id, payload);
}

function frame(id: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(10);
  header.write(id, 0, 4, 'latin1');
  writeSynchsafe(payload.length).copy(header, 4);
  return Buffer.concat([header, payload]);
}

function commentFrame(value: string): Buffer {
  return frame(
    'COMM',
    Buffer.concat([
      Buffer.from([3]),
      Buffer.from('eng', 'latin1'),
      Buffer.from([0]),
      Buffer.from(value, 'utf8'),
    ]),
  );
}

function apicFrame(artwork: Artwork): Buffer {
  return frame(
    'APIC',
    Buffer.concat([
      Buffer.from([3]),
      Buffer.from(artwork.mime, 'latin1'),
      Buffer.from([0]),
      Buffer.from([3]),
      Buffer.from(artwork.description ?? '', 'utf8'),
      Buffer.from([0]),
      artwork.data,
    ]),
  );
}

export function writeId3(buffer: Buffer, metadata: TrackMetadata): Buffer {
  const frames: Buffer[] = [];

  if (metadata.title !== undefined) frames.push(textFrame('TIT2', metadata.title));
  if (metadata.artist !== undefined) frames.push(textFrame('TPE1', metadata.artist));
  if (metadata.album !== undefined) frames.push(textFrame('TALB', metadata.album));
  if (metadata.albumArtist !== undefined) frames.push(textFrame('TPE2', metadata.albumArtist));
  if (metadata.genre !== undefined) frames.push(textFrame('TCON', metadata.genre));
  if (metadata.composer !== undefined) frames.push(textFrame('TCOM', metadata.composer));
  if (metadata.year !== undefined) frames.push(textFrame('TDRC', String(metadata.year)));

  if (metadata.track !== undefined) {
    frames.push(
      textFrame('TRCK', metadata.trackTotal !== undefined ? `${metadata.track}/${metadata.trackTotal}` : String(metadata.track)),
    );
  }
  if (metadata.disc !== undefined) {
    frames.push(
      textFrame('TPOS', metadata.discTotal !== undefined ? `${metadata.disc}/${metadata.discTotal}` : String(metadata.disc)),
    );
  }
  if (metadata.comment !== undefined) frames.push(commentFrame(metadata.comment));
  if (metadata.sourceUrl !== undefined) {
    frames.push(frame('WXXX', Buffer.concat([Buffer.from([3]), Buffer.from([0]), Buffer.from(metadata.sourceUrl, 'latin1')])));
  }
  if (metadata.artwork !== undefined) frames.push(apicFrame(metadata.artwork));

  const audio = stripId3(buffer);
  if (frames.length === 0) return audio;

  const body = Buffer.concat(frames);
  const header = Buffer.alloc(HEADER_SIZE);
  header.write('ID3', 0, 3, 'latin1');
  header[3] = 4;
  header[4] = 0;
  header[5] = 0;
  writeSynchsafe(body.length).copy(header, 6);

  return Buffer.concat([header, body, audio]);
}
