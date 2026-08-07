import { VectraxError, ExitCode } from '../errors.js';
import type { HttpClient } from '../http/client.js';
import { providerFor } from '../providers/registry.js';
import type { ProviderResult, ResolvedMedia } from '../providers/types.js';
import { mapPool } from '../util/pool.js';
import {
  DEFAULT_QUALITY,
  collapseDuplicateQualities,
  type MediaIntent,
  type QualityTargets,
} from '../quality.js';
import type { MediaCandidate, MediaKind } from './media.js';

export interface DiscoverOptions {
  kinds: readonly MediaKind[];
  extensions?: readonly string[];
  match?: RegExp | undefined;
  media?: MediaIntent | undefined;
  quality?: QualityTargets | undefined;
  limit?: number | undefined;
  signal?: AbortSignal | undefined;
}

export interface DiscoveryResult {
  readonly pageUrl: URL;
  readonly pageTitle: string | undefined;
  readonly items: readonly ResolvedMedia[];
  readonly direct: boolean;
  readonly likelyDynamic: boolean;
  readonly provider: string;
  readonly warnings: readonly string[];
}

export function kindsForIntent(media: MediaIntent, configured: readonly MediaKind[]): MediaKind[] {
  if (media === 'video') return ['video', 'audio'];
  if (media === 'audio') return ['audio'];
  return [...configured];
}

export async function discoverWithFallback(
  http: HttpClient,
  target: URL,
  options: DiscoverOptions,
): Promise<DiscoveryResult> {
  const first = await discover(http, target, options);
  const widenable =
    first.items.length === 0 &&
    (options.media ?? 'auto') === 'auto' &&
    !options.kinds.includes('video');

  if (!widenable) return first;

  const widened = await discover(http, target, { ...options, kinds: [...options.kinds, 'video'] });
  if (widened.items.length === 0) return first;

  return {
    ...widened,
    warnings: [...widened.warnings, 'No audio found, so Vectrax widened the search to video.'],
  };
}

export async function discover(
  http: HttpClient,
  target: URL,
  options: DiscoverOptions,
): Promise<DiscoveryResult> {
  const provider = providerFor(target);

  const result: ProviderResult = await provider.resolve(target, {
    http,
    kinds: options.kinds,
    extensions: options.extensions,
    match: options.match,
    media: options.media ?? 'auto',
    quality: options.quality ?? DEFAULT_QUALITY,
    limit: options.limit,
    signal: options.signal,
  });

  const filtered =
    options.match !== undefined && provider.id !== 'page'
      ? result.items.filter(
          (item) => options.match?.test(item.title) === true || options.match?.test(item.url) === true,
        )
      : result.items;

  const quality = options.quality ?? DEFAULT_QUALITY;
  const { kept, collapsed } =
    provider.id === 'page' && !result.direct
      ? collapseDuplicateQualities(filtered, quality)
      : { kept: [...filtered], collapsed: 0 };

  const warnings = [...(result.warnings ?? [])];
  if (collapsed > 0) {
    warnings.push(
      `Collapsed ${collapsed} duplicate ${collapsed === 1 ? 'rendition' : 'renditions'} of the same items, keeping the ${quality.preset} match.`,
    );
  }
  for (const note of new Set(kept.map((item) => item.note).filter((note): note is string => note !== undefined))) {
    warnings.push(note);
  }

  return {
    pageUrl: result.pageUrl,
    pageTitle: result.title,
    items: kept,
    direct: result.direct,
    likelyDynamic: result.likelyDynamic ?? false,
    provider: provider.id,
    warnings,
  };
}

export function noMediaError(result: DiscoveryResult, kinds: readonly MediaKind[]): VectraxError {
  const hint = result.likelyDynamic
    ? 'The page appears to render its content with JavaScript, so the links are not in the HTML. Open the media URL directly and pass that instead.'
    : `Try widening the filter, e.g. --kind ${kinds.includes('audio') ? 'audio,video' : 'audio'} or --ext mp3,m4a.`;

  return new VectraxError('No matching media found on that page.', {
    code: 'E_NO_MEDIA',
    exitCode: ExitCode.NoResults,
    hint,
    details: { url: result.pageUrl.href },
  });
}

export interface SizedCandidate extends ResolvedMedia {
  size: number | undefined;
}

export async function probeSizes(
  http: HttpClient,
  items: readonly ResolvedMedia[],
  options: { concurrency: number; referer?: string | undefined; signal?: AbortSignal | undefined },
): Promise<SizedCandidate[]> {
  const settled = await mapPool(
    items,
    async (item) => {
      if (item.size !== undefined) return item.size;
      const probe = await http.probe(item.url, {
        ...(item.headers !== undefined ? { headers: { ...item.headers } } : {}),
        ...(options.referer !== undefined ? { referer: options.referer } : {}),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      });
      return probe.size;
    },
    { limit: options.concurrency, ...(options.signal !== undefined ? { signal: options.signal } : {}) },
  );

  return items.map((item, index) => {
    const entry = settled[index];
    return { ...item, size: entry?.status === 'fulfilled' ? entry.value : undefined };
  });
}

export type { MediaCandidate, ResolvedMedia };
