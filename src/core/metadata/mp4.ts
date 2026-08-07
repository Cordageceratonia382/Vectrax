import type { TrackMetadata } from './types.js';

interface Atom {
  type: string;
  start: number;
  dataStart: number;
  end: number;
}

const CONTAINERS = new Set(['moov', 'udta', 'trak', 'mdia', 'minf', 'stbl', 'ilst']);

const DataType = { Implicit: 0, Utf8: 1, Jpeg: 13, Png: 14, SignedInt: 21 } as const;

export function isMp4(buffer: Buffer): boolean {
  return buffer.length > 12 && buffer.toString('latin1', 4, 8) === 'ftyp';
}

function parseAtoms(buffer: Buffer, start: number, end: number): Atom[] {
  const atoms: Atom[] = [];
  let offset = start;

  while (offset + 8 <= end) {
    let size = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    let dataStart = offset + 8;

    if (size === 1) {
      if (offset + 16 > end) break;
      size = Number(buffer.readBigUInt64BE(offset + 8));
      dataStart = offset + 16;
    } else if (size === 0) {
      size = end - offset;
    }

    if (size < 8 || offset + size > end) break;
    atoms.push({ type, start: offset, dataStart, end: offset + size });
    offset += size;
  }

  return atoms;
}

function findAtom(atoms: Atom[], type: string): Atom | undefined {
  return atoms.find((atom) => atom.type === type);
}

function metaChildrenOffset(buffer: Buffer, meta: Atom): number {
  if (meta.dataStart + 8 > meta.end) return meta.dataStart;
  const typeAtZero = buffer.toString('latin1', meta.dataStart + 4, meta.dataStart + 8);
  return /^[a-zA-Z0-9©\-. ]{4}$/.test(typeAtZero) ? meta.dataStart : meta.dataStart + 4;
}

function locateTagAtoms(
  buffer: Buffer,
): { moov: Atom; udta?: Atom; meta?: Atom; ilst?: Atom } | undefined {
  const top = parseAtoms(buffer, 0, buffer.length);
  const moov = findAtom(top, 'moov');
  if (moov === undefined) return undefined;

  const udta = findAtom(parseAtoms(buffer, moov.dataStart, moov.end), 'udta');
  if (udta === undefined) return { moov };

  const meta = findAtom(parseAtoms(buffer, udta.dataStart, udta.end), 'meta');
  if (meta === undefined) return { moov, udta };

  const ilst = findAtom(parseAtoms(buffer, metaChildrenOffset(buffer, meta), meta.end), 'ilst');
  return ilst === undefined ? { moov, udta, meta } : { moov, udta, meta, ilst };
}

export function readMp4(buffer: Buffer): TrackMetadata {
  if (!isMp4(buffer)) return {};
  const located = locateTagAtoms(buffer);
  if (located?.ilst === undefined) return {};

  const metadata: TrackMetadata = {};
  for (const item of parseAtoms(buffer, located.ilst.dataStart, located.ilst.end)) {
    const data = findAtom(parseAtoms(buffer, item.dataStart, item.end), 'data');
    if (data === undefined || data.dataStart + 8 > data.end) continue;

    const indicator = buffer.readUInt32BE(data.dataStart) & 0x00ffffff;
    const payload = buffer.subarray(data.dataStart + 8, data.end);
    applyItem(metadata, item.type, indicator, payload);
  }
  return metadata;
}

function applyItem(metadata: TrackMetadata, type: string, indicator: number, payload: Buffer): void {
  const text = () => payload.toString('utf8').replace(/\u0000+$/, '');

  switch (type) {
    case '©nam': metadata.title = text(); return;
    case '©ART': metadata.artist = text(); return;
    case '©alb': metadata.album = text(); return;
    case 'aART': metadata.albumArtist = text(); return;
    case '©gen': metadata.genre = text(); return;
    case '©wrt': metadata.composer = text(); return;
    case '©cmt': metadata.comment = text(); return;
    case '©day': {
      const year = Number.parseInt(text().slice(0, 4), 10);
      if (Number.isFinite(year) && year > 0) metadata.year = year;
      return;
    }
    case 'trkn': {
      if (payload.length >= 6) {
        const track = payload.readUInt16BE(2);
        const total = payload.readUInt16BE(4);
        if (track > 0) metadata.track = track;
        if (total > 0) metadata.trackTotal = total;
      }
      return;
    }
    case 'disk': {
      if (payload.length >= 6) {
        const disc = payload.readUInt16BE(2);
        const total = payload.readUInt16BE(4);
        if (disc > 0) metadata.disc = disc;
        if (total > 0) metadata.discTotal = total;
      }
      return;
    }
    case 'covr': {
      if (payload.length > 0) {
        metadata.artwork = {
          mime: indicator === DataType.Png ? 'image/png' : 'image/jpeg',
          data: Buffer.from(payload),
        };
      }
      return;
    }
    default:
      return;
  }
}

function atom(type: string, ...payload: Buffer[]): Buffer {
  const body = Buffer.concat(payload);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(body.length + 8, 0);
  header.write(type, 4, 4, 'latin1');
  return Buffer.concat([header, body]);
}

function dataBox(indicator: number, payload: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(indicator, 0);
  head.writeUInt32BE(0, 4);
  return atom('data', head, payload);
}

const textItem = (type: string, value: string): Buffer =>
  atom(type, dataBox(DataType.Utf8, Buffer.from(value, 'utf8')));

function pairItem(type: string, value: number, total: number | undefined, width: number): Buffer {
  const payload = Buffer.alloc(width);
  payload.writeUInt16BE(value, 2);
  payload.writeUInt16BE(total ?? 0, 4);
  return atom(type, dataBox(DataType.Implicit, payload));
}

function buildIlst(metadata: TrackMetadata): Buffer {
  const items: Buffer[] = [];

  if (metadata.title !== undefined) items.push(textItem('©nam', metadata.title));
  if (metadata.artist !== undefined) items.push(textItem('©ART', metadata.artist));
  if (metadata.album !== undefined) items.push(textItem('©alb', metadata.album));
  if (metadata.albumArtist !== undefined) items.push(textItem('aART', metadata.albumArtist));
  if (metadata.genre !== undefined) items.push(textItem('©gen', metadata.genre));
  if (metadata.composer !== undefined) items.push(textItem('©wrt', metadata.composer));
  if (metadata.year !== undefined) items.push(textItem('©day', String(metadata.year)));

  const comment = [metadata.comment, metadata.sourceUrl].filter((v) => v !== undefined && v !== '').join('\n');
  if (comment !== '') items.push(textItem('©cmt', comment));

  if (metadata.track !== undefined) items.push(pairItem('trkn', metadata.track, metadata.trackTotal, 8));
  if (metadata.disc !== undefined) items.push(pairItem('disk', metadata.disc, metadata.discTotal, 6));

  if (metadata.artwork !== undefined) {
    const indicator = metadata.artwork.mime.includes('png') ? DataType.Png : DataType.Jpeg;
    items.push(atom('covr', dataBox(indicator, metadata.artwork.data)));
  }

  return atom('ilst', ...items);
}

function buildMetaHandler(): Buffer {
  return atom(
    'hdlr',
    Buffer.alloc(4),
    Buffer.alloc(4),
    Buffer.from('mdir', 'latin1'),
    Buffer.from('appl', 'latin1'),
    Buffer.alloc(9),
  );
}

function buildUdta(metadata: TrackMetadata, preserved: Buffer[]): Buffer {
  const meta = atom(
    'meta',
    Buffer.alloc(4),
    buildMetaHandler(),
    buildIlst(metadata),
  );
  return atom('udta', ...preserved, meta);
}

function patchChunkOffsets(moov: Buffer, delta: number): void {
  if (delta === 0) return;

  const walk = (start: number, end: number): void => {
    for (const child of parseAtoms(moov, start, end)) {
      if (child.type === 'stco') {
        const count = moov.readUInt32BE(child.dataStart + 4);
        for (let i = 0; i < count; i++) {
          const at = child.dataStart + 8 + i * 4;
          if (at + 4 > child.end) break;
          moov.writeUInt32BE(moov.readUInt32BE(at) + delta, at);
        }
      } else if (child.type === 'co64') {
        const count = moov.readUInt32BE(child.dataStart + 4);
        for (let i = 0; i < count; i++) {
          const at = child.dataStart + 8 + i * 8;
          if (at + 8 > child.end) break;
          moov.writeBigUInt64BE(moov.readBigUInt64BE(at) + BigInt(delta), at);
        }
      } else if (CONTAINERS.has(child.type)) {
        walk(child.dataStart, child.end);
      }
    }
  };

  walk(8, moov.length);
}

export function writeMp4(buffer: Buffer, metadata: TrackMetadata): Buffer {
  if (!isMp4(buffer)) return buffer;
  const located = locateTagAtoms(buffer);
  if (located === undefined) return buffer;

  const { moov, udta } = located;

  const preserved: Buffer[] =
    udta !== undefined
      ? parseAtoms(buffer, udta.dataStart, udta.end)
          .filter((child) => child.type !== 'meta')
          .map((child) => Buffer.from(buffer.subarray(child.start, child.end)))
      : [];

  const newUdta = buildUdta(metadata, preserved);

  const oldUdtaStart = udta?.start ?? moov.end;
  const oldUdtaEnd = udta?.end ?? moov.end;
  const moovPayload = Buffer.concat([
    buffer.subarray(moov.dataStart, oldUdtaStart),
    newUdta,
    buffer.subarray(oldUdtaEnd, moov.end),
  ]);
  const newMoov = atom('moov', moovPayload);

  const delta = newMoov.length - (moov.end - moov.start);

  const mdat = findAtom(parseAtoms(buffer, 0, buffer.length), 'mdat');
  if (mdat !== undefined && moov.start < mdat.start) patchChunkOffsets(newMoov, delta);

  return Buffer.concat([buffer.subarray(0, moov.start), newMoov, buffer.subarray(moov.end)]);
}
