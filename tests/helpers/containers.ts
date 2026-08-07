export const PNG_1X1 = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489' +
    '0000000d49444154789c63f8cfc0f01f00050001ff89993d1d0000000049454e44ae426082',
  'hex',
);

export const JPEG_STUB = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.from('vectrax-test-jpeg-payload'.repeat(4)),
]);

export function mp3Audio(bytes = 512): Buffer {
  const audio = Buffer.alloc(bytes, 0x55);
  audio[0] = 0xff;
  audio[1] = 0xfb;
  return audio;
}

export function bareMp3(bytes = 512): Buffer {
  return mp3Audio(bytes);
}

export function mp3WithId3v1(): Buffer {
  const v1 = Buffer.alloc(128, 0);
  v1.write('TAG', 0, 3, 'latin1');
  v1.write('Old Title', 3, 30, 'latin1');
  return Buffer.concat([mp3Audio(), v1]);
}

function flacBlock(type: number, data: Buffer, last: boolean): Buffer {
  const header = Buffer.alloc(4);
  header[0] = (last ? 0x80 : 0) | type;
  header.writeUIntBE(data.length, 1, 3);
  return Buffer.concat([header, data]);
}

export function bareFlac(): Buffer {
  const streamInfo = Buffer.alloc(34, 0);
  streamInfo.writeUInt16BE(4096, 0);
  streamInfo.writeUInt16BE(4096, 2);
  return Buffer.concat([
    Buffer.from('fLaC', 'latin1'),
    flacBlock(0, streamInfo, true),
    Buffer.from('FLAC-AUDIO-FRAMES'.repeat(16)),
  ]);
}

export function mp4Atom(type: string, ...payload: Buffer[]): Buffer {
  const body = Buffer.concat(payload);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(body.length + 8, 0);
  header.write(type, 4, 4, 'latin1');
  return Buffer.concat([header, body]);
}

function stco(offsets: number[]): Buffer {
  const body = Buffer.alloc(8 + offsets.length * 4);
  body.writeUInt32BE(0, 0);
  body.writeUInt32BE(offsets.length, 4);
  offsets.forEach((offset, index) => body.writeUInt32BE(offset, 8 + index * 4));
  return mp4Atom('stco', body);
}

export interface Mp4Fixture {
  buffer: Buffer;
  chunkOffsets: number[];
  chunkMarkers: string[];
}

export function bareMp4(existingTags?: Buffer): Mp4Fixture {
  const ftyp = mp4Atom('ftyp', Buffer.from('M4A isomiso2', 'latin1'));

  const chunkMarkers = ['CHUNK-AAAA', 'CHUNK-BBBB', 'CHUNK-CCCC'];
  const mdatPayload = Buffer.concat(chunkMarkers.map((marker) => Buffer.from(marker.padEnd(64, '.'))));

  const buildMoov = (offsets: number[]): Buffer => {
    const trak = mp4Atom(
      'trak',
      mp4Atom('mdia', mp4Atom('minf', mp4Atom('stbl', stco(offsets)))),
    );
    const children = [mp4Atom('mvhd', Buffer.alloc(100)), trak];
    if (existingTags !== undefined) children.push(existingTags);
    return mp4Atom('moov', ...children);
  };

  const provisional = buildMoov([0, 0, 0]);
  const mdatStart = ftyp.length + provisional.length;
  const chunkOffsets = chunkMarkers.map((_, index) => mdatStart + 8 + index * 64);

  const moov = buildMoov(chunkOffsets);
  const mdat = mp4Atom('mdat', mdatPayload);

  return { buffer: Buffer.concat([ftyp, moov, mdat]), chunkOffsets, chunkMarkers };
}

export function readStco(buffer: Buffer): number[] {
  const index = buffer.indexOf(Buffer.from('stco', 'latin1'));
  if (index === -1) return [];
  const count = buffer.readUInt32BE(index + 8);
  return Array.from({ length: count }, (_, i) => buffer.readUInt32BE(index + 12 + i * 4));
}

export function markersAtOffsets(buffer: Buffer, offsets: number[]): string[] {
  return offsets.map((offset) => buffer.toString('latin1', offset, offset + 10));
}
