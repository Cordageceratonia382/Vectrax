import path from 'node:path';

import { errorMessage } from '../errors.js';
import type { HttpClient } from '../http/client.js';
import { mapPool } from '../util/pool.js';
import { readTags, supportsTagging, toArtwork, writeTags } from './tags.js';
import { mergeMetadata, type Artwork, type TrackMetadata } from './types.js';

export interface TaggingJob {
  readonly path: string;
  readonly metadata: TrackMetadata;
  readonly artworkUrl?: string | undefined;
}

export interface TaggingOptions {
  readonly artwork?: boolean;
  readonly concurrency?: number;
  readonly signal?: AbortSignal | undefined;
  readonly maxArtworkBytes?: number;
}

export interface TaggingReport {
  readonly tagged: number;
  readonly skipped: number;
  readonly warnings: readonly string[];
}

class ArtworkCache {
  private readonly entries = new Map<string, Promise<Artwork | undefined>>();

  constructor(
    private readonly http: HttpClient,
    private readonly maxBytes: number,
    private readonly signal: AbortSignal | undefined,
  ) {}

  get(url: string): Promise<Artwork | undefined> {
    const existing = this.entries.get(url);
    if (existing !== undefined) return existing;

    const pending = this.fetch(url);
    this.entries.set(url, pending);
    return pending;
  }

  private async fetch(url: string): Promise<Artwork | undefined> {
    try {
      const { data } = await this.http.buffer(url, {
        maxBytes: this.maxBytes,
        ...(this.signal !== undefined ? { signal: this.signal } : {}),
      });
      return toArtwork(data);
    } catch {
      return undefined;
    }
  }
}

export async function applyMetadata(
  http: HttpClient,
  jobs: readonly TaggingJob[],
  options: TaggingOptions = {},
): Promise<TaggingReport> {
  const taggable = jobs.filter((job) => supportsTagging(job.path));
  const skipped = jobs.length - taggable.length;
  if (taggable.length === 0) return { tagged: 0, skipped, warnings: [] };

  const cache = new ArtworkCache(http, options.maxArtworkBytes ?? 8 * 1024 * 1024, options.signal);
  const warnings: string[] = [];

  const settled = await mapPool(
    taggable,
    async (job) => {
      let metadata = job.metadata;

      if (options.artwork !== false && job.artworkUrl !== undefined) {
        const artwork = await cache.get(job.artworkUrl);
        if (artwork !== undefined) metadata = { ...metadata, artwork };
      }

      const existing = await readTags(job.path).catch(() => ({}) as TrackMetadata);
      await writeTags(job.path, mergeMetadata(existing, metadata));
    },
    {
      limit: Math.max(1, options.concurrency ?? 4),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    },
  );

  let tagged = 0;
  settled.forEach((result, index) => {
    if (result.status === 'fulfilled') tagged++;
    else {
      const job = taggable[index] as TaggingJob;
      warnings.push(`${path.basename(job.path)}: ${errorMessage(result.reason)}`);
    }
  });

  return { tagged, skipped, warnings };
}
