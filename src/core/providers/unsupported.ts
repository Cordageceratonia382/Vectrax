import { VectraxError, ExitCode } from '../errors.js';
import { bareHost, hostMatches, type Provider, type ProviderResult } from './types.js';

interface BlockedSource {
  readonly domains: readonly string[];
  readonly name: string;
  readonly reason: string;
}

const DRM_SOURCES: readonly BlockedSource[] = [
  {
    domains: ['spotify.com', 'spotify.link'],
    name: 'Spotify',
    reason: 'every Spotify stream is encrypted under Widevine DRM',
  },
  {
    domains: ['music.apple.com', 'itunes.apple.com'],
    name: 'Apple Music',
    reason: 'Apple Music streams are DRM-protected',
  },
  {
    domains: ['tidal.com', 'listen.tidal.com'],
    name: 'Tidal',
    reason: 'Tidal streams are DRM-protected',
  },
  {
    domains: ['deezer.com'],
    name: 'Deezer',
    reason: 'Deezer streams are DRM-protected',
  },
  {
    domains: ['netflix.com', 'primevideo.com', 'disneyplus.com', 'hulu.com', 'max.com'],
    name: 'that streaming service',
    reason: 'its video streams are DRM-protected',
  },
];

function blockedSourceFor(url: URL): BlockedSource | undefined {
  const host = bareHost(url);
  return DRM_SOURCES.find((source) => source.domains.some((domain) => hostMatches(host, domain)));
}

export const unsupportedProvider: Provider = {
  id: 'unsupported',
  label: 'unsupported source',

  supports(url: URL): boolean {
    return blockedSourceFor(url) !== undefined;
  },

  resolve(url: URL): Promise<ProviderResult> {
    const source = blockedSourceFor(url) as BlockedSource;
    throw new VectraxError(`Vectrax cannot download from ${source.name}.`, {
      code: 'E_URL_BLOCKED',
      exitCode: ExitCode.UsageError,
      hint: `Vectrax does not circumvent DRM, and ${source.reason}. Supported sources: YouTube, and direct media links on any page.`,
      details: { url: url.href, source: source.name },
    });
  },
};
