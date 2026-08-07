export interface Artwork {
  readonly mime: string;
  readonly data: Buffer;
  readonly description?: string | undefined;
}

export interface TrackMetadata {
  title?: string | undefined;
  artist?: string | undefined;
  album?: string | undefined;
  albumArtist?: string | undefined;
  genre?: string | undefined;
  year?: number | undefined;
  track?: number | undefined;
  trackTotal?: number | undefined;
  disc?: number | undefined;
  discTotal?: number | undefined;
  comment?: string | undefined;
  composer?: string | undefined;
  sourceUrl?: string | undefined;
  artwork?: Artwork | undefined;
}

export const EDITABLE_FIELDS = [
  'title',
  'artist',
  'album',
  'albumArtist',
  'genre',
  'year',
  'track',
  'trackTotal',
  'disc',
  'discTotal',
  'composer',
  'comment',
] as const;

export type EditableField = (typeof EDITABLE_FIELDS)[number];

export const NUMERIC_FIELDS = new Set<EditableField>([
  'year',
  'track',
  'trackTotal',
  'disc',
  'discTotal',
]);

export const FIELD_LABELS: Record<EditableField, string> = {
  title: 'Title',
  artist: 'Artist',
  album: 'Album',
  albumArtist: 'Album artist',
  genre: 'Genre',
  year: 'Year',
  track: 'Track',
  trackTotal: 'Track total',
  disc: 'Disc',
  discTotal: 'Disc total',
  composer: 'Composer',
  comment: 'Comment',
};

export function isEmptyMetadata(metadata: TrackMetadata): boolean {
  return !Object.values(metadata).some((value) => value !== undefined && value !== '');
}

export function mergeMetadata(base: TrackMetadata, updates: TrackMetadata): TrackMetadata {
  const out: TrackMetadata = { ...base };
  for (const [key, value] of Object.entries(updates) as [keyof TrackMetadata, unknown][]) {
    if (value === undefined) continue;
    if (value === '') delete out[key];
    else Object.assign(out, { [key]: value });
  }
  return out;
}
