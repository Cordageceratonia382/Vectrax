import type { HttpClient } from '../http/client.js';
import type { MediaIntent, QualityTargets } from '../quality.js';
import type { TrackMetadata } from '../metadata/types.js';
import type { MediaCandidate, MediaKind } from '../scrape/media.js';

export interface ProviderContext {
  readonly http: HttpClient;
  readonly signal?: AbortSignal | undefined;
  readonly kinds: readonly MediaKind[];
  readonly extensions?: readonly string[] | undefined;
  readonly match?: RegExp | undefined;
  readonly media: MediaIntent;
  readonly quality: QualityTargets;
  readonly limit?: number | undefined;
}

export interface ResolvedMedia extends MediaCandidate {
  readonly metadata?: TrackMetadata | undefined;
  readonly artworkUrl?: string | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly filename?: string | undefined;
  readonly durationSeconds?: number | undefined;
  readonly size?: number | undefined;
  readonly failureHint?: string | undefined;
  readonly note?: string | undefined;
  readonly fallbackUrl?: string | undefined;
}

export interface ProviderResult {
  readonly pageUrl: URL;
  readonly title?: string | undefined;
  readonly items: readonly ResolvedMedia[];
  readonly direct: boolean;
  readonly likelyDynamic?: boolean | undefined;
  readonly warnings?: readonly string[] | undefined;
}

export interface Provider {
  readonly id: string;
  readonly label: string;
  supports(url: URL): boolean;
  resolve(url: URL, context: ProviderContext): Promise<ProviderResult>;
}

export function bareHost(url: URL): string {
  return url.hostname.toLowerCase().replace(/^www\./, '');
}

export function hostMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}
