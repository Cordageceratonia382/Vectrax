import { VectraxError, ExitCode } from '../errors.js';
import type { HttpClient } from '../http/client.js';
import type { TrackMetadata } from '../metadata/types.js';
import { detectQuality } from '../scrape/media.js';
import {
  MAX,
  chooseByCeiling,
  describeShortfall,
  type MediaIntent,
  type QualityTargets,
} from '../quality.js';
import { mapPool } from '../util/pool.js';
import { bareHost, hostMatches, type Provider, type ProviderContext, type ProviderResult, type ResolvedMedia } from './types.js';

const INNERTUBE_BASE = 'https://www.youtube.com/youtubei/v1';

const IOS_CLIENT = {
  clientName: 'IOS',
  clientVersion: '20.03.02',
  deviceMake: 'Apple',
  deviceModel: 'iPhone16,2',
  osName: 'iPhone',
  osVersion: '18.2.1.22C161',
  hl: 'en',
  gl: 'US',
} as const;

const IOS_USER_AGENT =
  'com.google.ios.youtube/20.03.02 (iPhone16,2; U; CPU iOS 18_2_1 like Mac OS X;)';

const ANDROID_VR_CLIENT = {
  clientName: 'ANDROID_VR',
  clientVersion: '1.60.19',
  deviceMake: 'Oculus',
  deviceModel: 'Quest 3',
  osName: 'Android',
  osVersion: '12',
  androidSdkVersion: 32,
  hl: 'en',
  gl: 'US',
} as const;

const ANDROID_VR_USER_AGENT =
  'com.google.android.apps.youtube.vr.oculus/1.60.19 (Linux; U; Android 12; GB) gzip';

const BROWSER_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const VIDEO_ID = /^[\w-]{11}$/;
const PLAYLIST_ID = /^[\w-]{12,42}$/;

export interface YouTubeTarget {
  videoId?: string | undefined;
  playlistId?: string | undefined;
}

export function parseYouTubeUrl(url: URL): YouTubeTarget | undefined {
  const host = bareHost(url);
  const segments = url.pathname.split('/').filter(Boolean);

  if (hostMatches(host, 'youtu.be')) {
    const id = segments[0];
    return id !== undefined && VIDEO_ID.test(id) ? { videoId: id, ...listParam(url) } : undefined;
  }

  if (!hostMatches(host, 'youtube.com') && !hostMatches(host, 'youtube-nocookie.com')) return undefined;

  const list = listParam(url);

  const v = url.searchParams.get('v');
  if (v !== null && VIDEO_ID.test(v)) return { videoId: v, ...list };

  if (segments.length >= 2 && ['shorts', 'embed', 'live', 'v'].includes(segments[0] as string)) {
    const id = segments[1] as string;
    if (VIDEO_ID.test(id)) return { videoId: id, ...list };
  }

  if (segments[0] === 'playlist' && list.playlistId !== undefined) return list;

  return list.playlistId !== undefined ? list : undefined;
}

function listParam(url: URL): { playlistId?: string } {
  const list = url.searchParams.get('list');
  if (list === null || !PLAYLIST_ID.test(list) || list === 'WL' || list === 'LL') return {};
  return { playlistId: list };
}

interface YouTubeFormat {
  itag: number;
  url?: string;
  mimeType?: string;
  bitrate?: number;
  contentLength?: string;
  audioQuality?: string;
  qualityLabel?: string;
  height?: number;
  signatureCipher?: string;
}

interface PlayerResponse {
  playabilityStatus?: { status?: string; reason?: string };
  streamingData?: { formats?: YouTubeFormat[]; adaptiveFormats?: YouTubeFormat[] };
  videoDetails?: {
    videoId?: string;
    title?: string;
    author?: string;
    lengthSeconds?: string;
    channelId?: string;
    thumbnail?: { thumbnails?: { url?: string; width?: number; height?: number }[] };
  };
  microformat?: {
    playerMicroformatRenderer?: { publishDate?: string; uploadDate?: string; category?: string };
  };
}

type PlayerClient = 'ios' | 'androidVr';

const PLAYER_CLIENTS = {
  ios: { context: IOS_CLIENT, userAgent: IOS_USER_AGENT, id: '5' },
  androidVr: { context: ANDROID_VR_CLIENT, userAgent: ANDROID_VR_USER_AGENT, id: '28' },
} as const;

async function fetchPlayer(
  http: HttpClient,
  videoId: string,
  client: PlayerClient = 'ios',
  signal?: AbortSignal,
): Promise<PlayerResponse> {
  const profile = PLAYER_CLIENTS[client];
  return http.json<PlayerResponse>(`${INNERTUBE_BASE}/player?prettyPrint=false`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': profile.userAgent,
      'x-youtube-client-name': profile.id,
      'x-youtube-client-version': profile.context.clientVersion,
      origin: 'https://www.youtube.com',
    },
    body: JSON.stringify({
      videoId,
      context: { client: profile.context },
      contentCheckOk: true,
      racyCheckOk: true,
    }),
    retryStatuses: [403],
    retries: 4,
    ...(signal !== undefined ? { signal } : {}),
  });
}

function playabilityError(videoId: string, status: PlayerResponse['playabilityStatus']): VectraxError {
  const reason = status?.reason ?? status?.status ?? 'unknown reason';
  const hints: Record<string, string> = {
    LOGIN_REQUIRED: 'This video is private or age-restricted; Vectrax does not sign in.',
    AGE_VERIFICATION_REQUIRED: 'This video requires age verification, which needs a signed-in account.',
    UNPLAYABLE: 'YouTube will not serve this video to an anonymous client.',
    LIVE_STREAM_OFFLINE: 'The live stream is not currently broadcasting.',
    ERROR: 'The video may have been removed or made private.',
  };
  return new VectraxError(`YouTube refused video ${videoId}: ${reason}`, {
    code: 'E_NO_MEDIA',
    exitCode: ExitCode.NoResults,
    ...(status?.status !== undefined && hints[status.status] !== undefined
      ? { hint: hints[status.status] }
      : {}),
    details: { videoId, status: status?.status },
  });
}

function extensionFor(format: YouTubeFormat): string {
  const mime = format.mimeType ?? '';
  if (mime.includes('audio/mp4')) return 'm4a';
  if (mime.includes('audio/webm')) return 'webm';
  if (mime.includes('video/mp4')) return 'mp4';
  if (mime.includes('video/webm')) return 'webm';
  return 'bin';
}

export interface FormatChoice {
  readonly format: YouTubeFormat;
  readonly note: string | undefined;
}

const TAGGABLE_AUDIO = 'm4a';
const AUDIO_OVERSHOOT = 1.2;

function audioKbps(format: YouTubeFormat): number {
  return Math.round((format.bitrate ?? 0) / 1000);
}

function selectAudio(formats: readonly YouTubeFormat[], targets: QualityTargets): FormatChoice | undefined {
  const audio = formats.filter((format) => format.mimeType?.startsWith('audio/') === true);
  if (audio.length === 0) return undefined;

  const choice = chooseByCeiling(audio, audioKbps, targets.audioKbps, AUDIO_OVERSHOOT);
  if (choice === undefined) return undefined;

  if (extensionFor(choice.item) === TAGGABLE_AUDIO) {
    return { format: choice.item, note: describeShortfall(choice, 'kbps', 'YouTube') };
  }

  const taggable = audio.filter((format) => extensionFor(format) === TAGGABLE_AUDIO);
  const preferred = chooseByCeiling(taggable, audioKbps, targets.audioKbps, AUDIO_OVERSHOOT);

  if (preferred !== undefined && preferred.satisfied) {
    return { format: preferred.item, note: describeShortfall(preferred, 'kbps', 'YouTube') };
  }
  return { format: choice.item, note: describeShortfall(choice, 'kbps', 'YouTube') };
}

function selectVideo(formats: readonly YouTubeFormat[], targets: QualityTargets): FormatChoice | undefined {
  const muxed = formats.filter(
    (format) => format.mimeType?.startsWith('video/') === true && format.audioQuality !== undefined,
  );
  if (muxed.length === 0) return undefined;

  const choice = chooseByCeiling(muxed, (format) => format.height ?? 0, targets.videoHeight);
  if (choice === undefined) return undefined;

  const adaptiveCeiling = Math.max(
    0,
    ...formats.filter((f) => f.mimeType?.startsWith('video/') === true).map((f) => f.height ?? 0),
  );

  const wantedMore = targets.videoHeight === MAX || targets.videoHeight > choice.value;
  const note =
    wantedMore && adaptiveCeiling > choice.value
      ? `${choice.value}p is the highest YouTube serves with audio included. Higher resolutions up to ${adaptiveCeiling}p exist only as separate video-only streams, which Vectrax does not multiplex.`
      : describeShortfall(choice, 'p', 'YouTube');

  return { format: choice.item, note };
}

export function selectFormat(
  formats: readonly YouTubeFormat[],
  media: MediaIntent,
  targets: QualityTargets,
): FormatChoice | undefined {
  const usable = formats.filter((format) => typeof format.url === 'string' && format.url !== '');
  if (usable.length === 0) return undefined;

  if (media === 'video') return selectVideo(usable, targets) ?? selectAudio(usable, targets);
  return selectAudio(usable, targets) ?? selectVideo(usable, targets);
}

const TITLE_NOISE =
  /\s*[([]\s*(?:(?:official|oficial|officiel|offizielles?)\s*)?(?:music\s*|musik\s*)?(?:video|audio|vídeo|videoclip|visualizer|visualiser|lyric[s]?(?:\s*video)?|letra|performance\s*video|clip)\s*(?:oficial|official|officiel)?\s*[)\]]/gi;

const QUALITY_NOISE = /\s*[([]\s*(?:hd|hq|4k|8k|full\s*hd|remaster(?:ed)?(?:\s*\d{4})?|\d{3,4}p|4k\s*remaster(?:ed)?)\s*[)\]]/gi;

function normaliseName(value: string): string {
  return value
    .toLowerCase()
    .replace(/\b(vevo|official|music|records|tv)\b/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

export function splitArtistTitle(name: string, channel: string | undefined): { artist?: string; title: string } {
  const cleaned = name
    .replace(TITLE_NOISE, ' ')
    .replace(QUALITY_NOISE, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s\-–—|]+|[\s\-–—|]+$/g, '')
    .trim();

  const separator = /\s+[-–—]\s+/.exec(cleaned);
  if (separator !== null && separator.index > 0) {
    const left = cleaned.slice(0, separator.index).trim();
    const right = cleaned.slice(separator.index + separator[0].length).trim();

    if (left !== '' && right !== '') {
      const channelKey = channel !== undefined ? normaliseName(channel) : '';
      if (channelKey !== '') {
        const leftMatches = normaliseName(left).includes(channelKey) || channelKey.includes(normaliseName(left));
        const rightCore = right.replace(/\s*(?:ft\.?|feat\.?|featuring|con)\s+.*$/i, '').trim();
        const rightMatches =
          normaliseName(rightCore).includes(channelKey) || channelKey.includes(normaliseName(rightCore));

        if (rightMatches && !leftMatches) return { artist: right, title: left };
      }
      return { artist: left, title: right };
    }
  }

  return { title: cleaned === '' ? name : cleaned, ...(channel !== undefined ? { artist: channel } : {}) };
}

function bestThumbnail(player: PlayerResponse): string | undefined {
  const thumbnails = player.videoDetails?.thumbnail?.thumbnails ?? [];
  const best = [...thumbnails].sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0];
  return best?.url;
}

function buildMetadata(player: PlayerResponse, watchUrl: string): TrackMetadata {
  const details = player.videoDetails ?? {};
  const { artist, title } = splitArtistTitle(details.title ?? 'video', details.author);
  const published =
    player.microformat?.playerMicroformatRenderer?.publishDate ??
    player.microformat?.playerMicroformatRenderer?.uploadDate;
  const year = Number.parseInt((published ?? '').slice(0, 4), 10);

  return {
    title,
    ...(artist !== undefined ? { artist } : {}),
    ...(details.author !== undefined ? { albumArtist: details.author } : {}),
    ...(Number.isFinite(year) && year > 0 ? { year } : {}),
    sourceUrl: watchUrl,
  };
}

const watchUrlFor = (videoId: string): string => `https://www.youtube.com/watch?v=${videoId}`;

export interface PlaylistEntry {
  videoId: string;
  title?: string | undefined;
  author?: string | undefined;
}

export function extractPlaylistEntries(data: unknown): PlaylistEntry[] {
  const entries: PlaylistEntry[] = [];
  const seen = new Set<string>();

  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (node === null || typeof node !== 'object') return;

    const record = node as Record<string, unknown>;

    const contentType = record['contentType'];
    if (
      typeof record['contentId'] === 'string' &&
      typeof contentType === 'string' &&
      contentType.includes('VIDEO')
    ) {
      add(record['contentId'], lockupTitle(record), lockupAuthor(record));
    }

    if (typeof record['videoId'] === 'string' && record['title'] !== undefined) {
      add(record['videoId'], readText(record['title']), readText(record['shortBylineText']));
    }

    Object.values(record).forEach(visit);
  };

  const add = (videoId: string, title?: string, author?: string): void => {
    if (!VIDEO_ID.test(videoId) || seen.has(videoId)) return;
    seen.add(videoId);
    entries.push({ videoId, title, author });
  };

  visit(data);
  return entries;
}

function lockupTitle(record: Record<string, unknown>): string | undefined {
  const metadata = record['metadata'] as Record<string, unknown> | undefined;
  const view = metadata?.['lockupMetadataViewModel'] as Record<string, unknown> | undefined;
  const title = view?.['title'] as Record<string, unknown> | undefined;
  return typeof title?.['content'] === 'string' ? title['content'] : undefined;
}

function lockupAuthor(record: Record<string, unknown>): string | undefined {
  const json = JSON.stringify(record['metadata'] ?? {});
  const match = /"metadataParts":\[\{"text":\{"content":"((?:[^"\\]|\\.)*)"/.exec(json);
  if (match?.[1] === undefined) return undefined;
  try {
    return JSON.parse(`"${match[1]}"`) as string;
  } catch {
    return undefined;
  }
}

function readText(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record['simpleText'] === 'string') return record['simpleText'];
  const runs = record['runs'];
  if (Array.isArray(runs)) {
    const text = runs
      .map((run) => (run as Record<string, unknown>)['text'])
      .filter((t): t is string => typeof t === 'string')
      .join('');
    return text === '' ? undefined : text;
  }
  return undefined;
}

export function parseInitialData(html: string): unknown {
  const match =
    /ytInitialData\s*=\s*(\{.+?\})\s*;\s*<\/script>/s.exec(html) ??
    /ytInitialData"\]\s*=\s*(\{.+?\})\s*;/s.exec(html);
  if (match?.[1] === undefined) return undefined;
  try {
    return JSON.parse(match[1]);
  } catch {
    return undefined;
  }
}

export function extractPlaylistTitle(data: unknown): string | undefined {
  const json = JSON.stringify(data ?? {});
  const match = /"microformatDataRenderer":\{"urlCanonical":"[^"]*","title":"((?:[^"\\]|\\.)*)"/.exec(json);
  if (match?.[1] === undefined) return undefined;
  try {
    return JSON.parse(`"${match[1]}"`) as string;
  } catch {
    return undefined;
  }
}

const PLAYLIST_RESOLVE_CONCURRENCY = 3;

export const youtubeProvider: Provider = {
  id: 'youtube',
  label: 'YouTube',

  supports(url: URL): boolean {
    return parseYouTubeUrl(url) !== undefined;
  },

  async resolve(url: URL, context: ProviderContext): Promise<ProviderResult> {
    const target = parseYouTubeUrl(url);
    if (target === undefined) {
      throw new VectraxError(`Not a recognisable YouTube URL: ${url.href}`, { code: 'E_URL_INVALID' });
    }

    if (target.videoId !== undefined) {
      const item = await resolveVideo(target.videoId, context);
      return { pageUrl: new URL(watchUrlFor(target.videoId)), items: [item], direct: true };
    }

    return resolvePlaylist(target.playlistId as string, context);
  },
};

function formatsOf(player: PlayerResponse): YouTubeFormat[] {
  return [...(player.streamingData?.formats ?? []), ...(player.streamingData?.adaptiveFormats ?? [])];
}

function hasCombinedVideo(formats: readonly YouTubeFormat[]): boolean {
  return formats.some(
    (format) =>
      format.mimeType?.startsWith('video/') === true &&
      format.audioQuality !== undefined &&
      typeof format.url === 'string',
  );
}

async function resolveVideo(videoId: string, context: ProviderContext): Promise<ResolvedMedia> {
  const player = await fetchPlayer(context.http, videoId, 'ios', context.signal);

  const status = player.playabilityStatus?.status;
  if (status !== undefined && status !== 'OK') throw playabilityError(videoId, player.playabilityStatus);

  let formats = formatsOf(player);

  if (context.media === 'video' && !hasCombinedVideo(formats)) {
    const combined = await fetchPlayer(context.http, videoId, 'androidVr', context.signal).catch(
      () => undefined,
    );
    if (combined !== undefined && combined.playabilityStatus?.status === 'OK') {
      formats = [...formatsOf(combined), ...formats];
    }
  }

  const choice = selectFormat(formats, context.media, context.quality);
  const chosen = choice?.format;

  if (chosen?.url === undefined) {
    const ciphered = formats.some((f) => f.signatureCipher !== undefined);
    throw new VectraxError(`No downloadable stream for YouTube video ${videoId}.`, {
      code: 'E_NO_MEDIA',
      exitCode: ExitCode.NoResults,
      hint: ciphered
        ? 'YouTube returned only signature-protected streams for this video.'
        : 'The video may be a live stream or otherwise unavailable for download.',
      details: { videoId },
    });
  }

  const watchUrl = watchUrlFor(videoId);
  const metadata = buildMetadata(player, watchUrl);
  const extension = extensionFor(chosen);
  const size = Number(chosen.contentLength);
  const duration = Number(player.videoDetails?.lengthSeconds);
  const artworkUrl = bestThumbnail(player);
  const displayTitle = player.videoDetails?.title ?? metadata.title ?? videoId;

  return {
    url: chosen.url,
    title: displayTitle,
    kind: chosen.mimeType?.startsWith('video/') === true ? 'video' : 'audio',
    extension,
    quality:
      chosen.qualityLabel ??
      (chosen.bitrate !== undefined ? `${Math.round(chosen.bitrate / 1000)}kbps` : detectQuality(displayTitle)),
    ...(choice?.note !== undefined ? { note: choice.note } : {}),
    source: 'direct',
    metadata,
    ...(artworkUrl !== undefined ? { artworkUrl } : {}),
    headers: { 'user-agent': IOS_USER_AGENT },
    failureHint:
      'YouTube served part of this file and then refused the rest. Some videos are capped to a short preview for clients that cannot attest themselves, and no amount of retrying or re-requesting lifts the cap. Audio from ordinary uploads is unaffected.',
    fallbackUrl: watchUrl,
    filename: buildFilename(metadata, displayTitle),
    ...(Number.isFinite(duration) && duration > 0 ? { durationSeconds: duration } : {}),
    ...(Number.isFinite(size) && size > 0 ? { size } : {}),
  };
}

function buildFilename(metadata: TrackMetadata, fallback: string): string {
  return metadata.artist !== undefined && metadata.title !== undefined
    ? `${metadata.artist} - ${metadata.title}`
    : (metadata.title ?? fallback);
}

async function resolvePlaylist(playlistId: string, context: ProviderContext): Promise<ProviderResult> {
  const pageUrl = new URL(`https://www.youtube.com/playlist?list=${playlistId}`);

  const { body } = await context.http.text(pageUrl, {
    headers: { 'user-agent': BROWSER_USER_AGENT, 'accept-language': 'en' },
    ...(context.signal !== undefined ? { signal: context.signal } : {}),
  });

  const data = parseInitialData(body);
  const entries = extractPlaylistEntries(data);

  if (entries.length === 0) {
    throw new VectraxError(`No videos found in YouTube playlist ${playlistId}.`, {
      code: 'E_NO_MEDIA',
      exitCode: ExitCode.NoResults,
      hint: 'The playlist may be private, empty, or a personal mix.',
      details: { playlistId },
    });
  }

  const limited = context.limit !== undefined ? entries.slice(0, context.limit) : entries;
  const warnings: string[] = [];
  if (limited.length < entries.length) {
    warnings.push(`Playlist has ${entries.length} videos; taking the first ${limited.length} (--limit).`);
  }

  const settled = await mapPool(
    limited,
    async (entry) => resolveVideo(entry.videoId, context),
    { limit: PLAYLIST_RESOLVE_CONCURRENCY, ...(context.signal !== undefined ? { signal: context.signal } : {}) },
  );

  const items: ResolvedMedia[] = [];
  settled.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      const position = index + 1;
      items.push({
        ...result.value,
        metadata: {
          ...result.value.metadata,
          album: extractPlaylistTitle(data) ?? result.value.metadata?.album,
          track: position,
          trackTotal: limited.length,
        },
      });
    } else {
      const entry = limited[index] as PlaylistEntry;
      warnings.push(`Skipped ${entry.title ?? entry.videoId}: ${describe(result.reason)}`);
    }
  });

  if (items.length === 0) {
    throw new VectraxError(`Every video in playlist ${playlistId} was unavailable.`, {
      code: 'E_NO_MEDIA',
      exitCode: ExitCode.NoResults,
      details: { playlistId, warnings },
    });
  }

  return {
    pageUrl,
    title: extractPlaylistTitle(data),
    items,
    direct: false,
    warnings,
  };
}

function describe(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
