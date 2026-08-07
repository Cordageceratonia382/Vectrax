export { HttpClient, DEFAULT_USER_AGENT, computeBackoff, decodeBody } from './core/http/client.js';
export type { HttpClientOptions, ProbeResult, RequestOptions, RetryInfo } from './core/http/client.js';

export { assertUrlAllowed, isPrivateHost, normalizeUrl, parseUrl } from './core/http/guard.js';
export type { UrlGuardOptions } from './core/http/guard.js';

export { extractMedia, extractPageTitle, decodeEntities } from './core/scrape/extract.js';
export type { ExtractOptions, ExtractResult } from './core/scrape/extract.js';
export { discover, probeSizes } from './core/scrape/discover.js';
export type { DiscoverOptions, DiscoveryResult, SizedCandidate } from './core/scrape/discover.js';
export { MEDIA_KINDS, detectQuality, extensionsForKinds, kindForExtension } from './core/scrape/media.js';
export type { MediaCandidate, MediaKind, MediaSource } from './core/scrape/media.js';

export { providers, providerFor, providerIds } from './core/providers/registry.js';
export { pageProvider } from './core/providers/page.js';
export { unsupportedProvider } from './core/providers/unsupported.js';
export { youtubeProvider, parseYouTubeUrl, selectFormat, splitArtistTitle } from './core/providers/youtube.js';
export type {
  Provider,
  ProviderContext,
  ProviderResult,
  ResolvedMedia,
} from './core/providers/types.js';

export {
  readTags,
  writeTags,
  readTagsFromBuffer,
  writeTagsToBuffer,
  supportsTagging,
  detectFormat,
  detectImageMime,
  toArtwork,
  readArtworkFile,
  artworkExtension,
} from './core/metadata/tags.js';
export { applyMetadata } from './core/metadata/embed.js';
export type { TaggingJob, TaggingOptions, TaggingReport } from './core/metadata/embed.js';
export { readId3, writeId3 } from './core/metadata/id3.js';
export { readFlac, writeFlac } from './core/metadata/flac.js';
export { readMp4, writeMp4 } from './core/metadata/mp4.js';
export {
  EDITABLE_FIELDS,
  FIELD_LABELS,
  isEmptyMetadata,
  mergeMetadata,
} from './core/metadata/types.js';
export type { Artwork, EditableField, TrackMetadata } from './core/metadata/types.js';

export { DownloadEngine } from './core/download/engine.js';
export type { DownloadEngineOptions } from './core/download/engine.js';
export type {
  ConflictPolicy,
  DownloadOutcome,
  DownloadRequest,
  TaskSnapshot,
  TaskState,
} from './core/download/types.js';
export { buildFilename, sanitizeFilename } from './core/download/filename.js';

export { mapPool } from './core/util/pool.js';
export type { PoolOptions, Settled } from './core/util/pool.js';
export * from './core/util/format.js';

export {
  ExitCode,
  VectraxError,
  UsageError,
  ConfigError,
  NetworkError,
  HttpError,
  FilesystemError,
  CancelledError,
  isVectraxError,
} from './core/errors.js';

export { configSchema, type Config, type ConfigInput } from './config/schema.js';
export { resolveConfig, configFilePath } from './config/store.js';

export {
  DEFAULT_QUALITY,
  QUALITY_PRESETS,
  chooseByCeiling,
  collapseDuplicateQualities,
  parseQuality,
} from './core/quality.js';
export type { MediaIntent, QualityPreset, QualityTargets } from './core/quality.js';

export { detectFallbackTool, runFallback, formatSelector } from './core/fallback/ytdlp.js';
export type { FallbackRequest, FallbackResult, FallbackTool } from './core/fallback/ytdlp.js';

export {
  AUDIO_FORMATS,
  VIDEO_FORMATS,
  KEEP_ORIGINAL,
  parseFormat,
  planConversion,
  targetFormatFor,
} from './core/convert/formats.js';
export type { AudioFormat, FormatChoice, MediaFormat, VideoFormat } from './core/convert/formats.js';
export { convertFile, detectToolchain, probeSource } from './core/convert/ffmpeg.js';
export type { Toolchain } from './core/convert/ffmpeg.js';

export { VERSION } from './version.js';
