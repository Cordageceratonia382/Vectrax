import { z } from 'zod';

interface UrlGuardOptions {
    allowPrivateHosts?: boolean;
    allowInsecure?: boolean;
}
declare function parseUrl(input: string, options?: UrlGuardOptions): URL;
declare function assertUrlAllowed(url: URL, options?: UrlGuardOptions): void;
declare function isPrivateHost(hostname: string): boolean;
declare function normalizeUrl(url: URL): string;

declare const DEFAULT_USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
interface HttpClientOptions {
    userAgent?: string;
    headers?: Record<string, string>;
    timeoutMs?: number;
    retries?: number;
    retryDelayMs?: number;
    maxRedirects?: number;
    guard?: UrlGuardOptions;
    onRetry?: (info: RetryInfo) => void;
}
interface RetryInfo {
    url: string;
    attempt: number;
    maxAttempts: number;
    delayMs: number;
    reason: string;
}
interface RequestOptions {
    method?: 'GET' | 'HEAD' | 'POST';
    headers?: Record<string, string>;
    body?: string | Uint8Array | undefined;
    signal?: AbortSignal | undefined;
    timeoutMs?: number;
    retries?: number;
    retryStatuses?: readonly number[];
    referer?: string | undefined;
}
interface HttpResponse {
    readonly response: Response;
    readonly url: URL;
}
declare class HttpClient {
    private readonly userAgent;
    private readonly baseHeaders;
    private readonly timeoutMs;
    private readonly retries;
    private readonly retryDelayMs;
    private readonly maxRedirects;
    private readonly guard;
    private readonly onRetry;
    constructor(options?: HttpClientOptions);
    request(target: URL | string, options?: RequestOptions): Promise<HttpResponse>;
    private backoff;
    private requestOnce;
    requestOk(target: URL | string, options?: RequestOptions): Promise<HttpResponse>;
    text(target: URL | string, options?: RequestOptions): Promise<{
        body: string;
        url: URL;
    }>;
    json<T = unknown>(target: URL | string, options?: RequestOptions): Promise<T>;
    buffer(target: URL | string, options?: RequestOptions & {
        maxBytes?: number;
        onProgress?: (received: number, total: number | undefined) => void;
    }): Promise<{
        data: Buffer;
        contentType: string | null;
    }>;
    probe(target: URL | string, options?: RequestOptions): Promise<ProbeResult>;
}
interface ProbeResult {
    url: URL;
    size: number | undefined;
    contentType: string | null;
    contentDisposition: string | null;
    etag: string | null;
    lastModified: string | null;
    supportsRanges: boolean;
}
declare function computeBackoff(attempt: number, baseMs: number, retryAfter: string | null): number;
declare function decodeBody(buffer: Buffer, contentType: string | null): string;

declare const MEDIA_KINDS: readonly ["audio", "video", "image", "archive", "document", "other"];
type MediaKind = (typeof MEDIA_KINDS)[number];
declare function extensionsForKinds(kinds: readonly MediaKind[]): string[];
declare function kindForExtension(extension: string | undefined): MediaKind;
type MediaSource = 'anchor' | 'media-tag' | 'embedded-json' | 'raw-scan' | 'direct';
interface MediaCandidate {
    readonly url: string;
    readonly title: string;
    readonly kind: MediaKind;
    readonly extension: string | undefined;
    readonly quality: string | undefined;
    readonly source: MediaSource;
}
declare function detectQuality(...sources: (string | undefined)[]): string | undefined;

interface ExtractOptions {
    baseUrl: URL;
    extensions: readonly string[];
    match?: RegExp | undefined;
}
interface ExtractResult {
    readonly pageTitle: string | undefined;
    readonly items: readonly MediaCandidate[];
    readonly likelyDynamic: boolean;
}
declare function decodeEntities(value: string): string;
declare function extractPageTitle(html: string): string | undefined;
declare function extractMedia(html: string, options: ExtractOptions): ExtractResult;

declare const ExitCode: {
    readonly Ok: 0;
    readonly Failure: 1;
    readonly UsageError: 2;
    readonly NetworkError: 3;
    readonly FilesystemError: 4;
    readonly NoResults: 5;
    readonly PartialFailure: 6;
    readonly Interrupted: 130;
};
type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];
type ErrorCode = 'E_USAGE' | 'E_CONFIG' | 'E_URL_INVALID' | 'E_URL_BLOCKED' | 'E_HTTP' | 'E_NETWORK' | 'E_TIMEOUT' | 'E_FS' | 'E_NO_MEDIA' | 'E_CANCELLED' | 'E_INTERNAL';
interface VectraxErrorOptions {
    code?: ErrorCode | undefined;
    exitCode?: ExitCodeValue | undefined;
    hint?: string | undefined;
    details?: Record<string, unknown> | undefined;
    cause?: unknown;
}
declare class VectraxError extends Error {
    readonly code: ErrorCode;
    readonly exitCode: ExitCodeValue;
    readonly hint: string | undefined;
    readonly details: Record<string, unknown> | undefined;
    constructor(message: string, options?: VectraxErrorOptions);
    toJSON(): Record<string, unknown>;
}
declare class UsageError extends VectraxError {
    constructor(message: string, options?: Omit<VectraxErrorOptions, 'code' | 'exitCode'>);
}
declare class ConfigError extends VectraxError {
    constructor(message: string, options?: Omit<VectraxErrorOptions, 'code' | 'exitCode'>);
}
declare class NetworkError extends VectraxError {
    constructor(message: string, options?: Omit<VectraxErrorOptions, 'exitCode'> & {
        code?: ErrorCode;
    });
}
declare class HttpError extends NetworkError {
    readonly status: number;
    constructor(status: number, url: string, options?: Omit<VectraxErrorOptions, 'code'>);
}
declare class FilesystemError extends VectraxError {
    constructor(message: string, options?: Omit<VectraxErrorOptions, 'code' | 'exitCode'>);
}
declare class CancelledError extends VectraxError {
    constructor(message?: string);
}
declare function isVectraxError(value: unknown): value is VectraxError;

type MediaIntent = 'audio' | 'video' | 'auto';
declare const QUALITY_PRESETS: readonly ["best", "high", "balanced", "small"];
type QualityPreset = (typeof QUALITY_PRESETS)[number];
declare const MAX: "max";
type Target = number | typeof MAX;
interface QualityTargets {
    readonly preset: QualityPreset;
    readonly audioKbps: Target;
    readonly videoHeight: Target;
}
declare const DEFAULT_QUALITY: QualityTargets;
declare function parseQuality(input: string): QualityTargets;
interface QualityChoice<T> {
    readonly item: T;
    readonly value: number;
    readonly target: Target;
    readonly satisfied: boolean;
    readonly bestAvailable: number;
}
declare function chooseByCeiling<T>(items: readonly T[], valueOf: (item: T) => number, target: Target, overshoot?: number): QualityChoice<T> | undefined;
interface QualityRanked {
    readonly title: string;
    readonly quality?: string | undefined;
    readonly extension?: string | undefined;
}
declare function collapseDuplicateQualities<T extends QualityRanked>(items: readonly T[], targets: QualityTargets): {
    kept: T[];
    collapsed: number;
};

interface Artwork {
    readonly mime: string;
    readonly data: Buffer;
    readonly description?: string | undefined;
}
interface TrackMetadata {
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
declare const EDITABLE_FIELDS: readonly ["title", "artist", "album", "albumArtist", "genre", "year", "track", "trackTotal", "disc", "discTotal", "composer", "comment"];
type EditableField = (typeof EDITABLE_FIELDS)[number];
declare const FIELD_LABELS: Record<EditableField, string>;
declare function isEmptyMetadata(metadata: TrackMetadata): boolean;
declare function mergeMetadata(base: TrackMetadata, updates: TrackMetadata): TrackMetadata;

interface ProviderContext {
    readonly http: HttpClient;
    readonly signal?: AbortSignal | undefined;
    readonly kinds: readonly MediaKind[];
    readonly extensions?: readonly string[] | undefined;
    readonly match?: RegExp | undefined;
    readonly media: MediaIntent;
    readonly quality: QualityTargets;
    readonly limit?: number | undefined;
}
interface ResolvedMedia extends MediaCandidate {
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
interface ProviderResult {
    readonly pageUrl: URL;
    readonly title?: string | undefined;
    readonly items: readonly ResolvedMedia[];
    readonly direct: boolean;
    readonly likelyDynamic?: boolean | undefined;
    readonly warnings?: readonly string[] | undefined;
}
interface Provider {
    readonly id: string;
    readonly label: string;
    supports(url: URL): boolean;
    resolve(url: URL, context: ProviderContext): Promise<ProviderResult>;
}

interface DiscoverOptions {
    kinds: readonly MediaKind[];
    extensions?: readonly string[];
    match?: RegExp | undefined;
    media?: MediaIntent | undefined;
    quality?: QualityTargets | undefined;
    limit?: number | undefined;
    signal?: AbortSignal | undefined;
}
interface DiscoveryResult {
    readonly pageUrl: URL;
    readonly pageTitle: string | undefined;
    readonly items: readonly ResolvedMedia[];
    readonly direct: boolean;
    readonly likelyDynamic: boolean;
    readonly provider: string;
    readonly warnings: readonly string[];
}
declare function discover(http: HttpClient, target: URL, options: DiscoverOptions): Promise<DiscoveryResult>;
interface SizedCandidate extends ResolvedMedia {
    size: number | undefined;
}
declare function probeSizes(http: HttpClient, items: readonly ResolvedMedia[], options: {
    concurrency: number;
    referer?: string | undefined;
    signal?: AbortSignal | undefined;
}): Promise<SizedCandidate[]>;

declare const providers: readonly Provider[];
declare function providerFor(url: URL): Provider;
declare const providerIds: readonly string[];

declare const pageProvider: Provider;

declare const unsupportedProvider: Provider;

interface YouTubeTarget {
    videoId?: string | undefined;
    playlistId?: string | undefined;
}
declare function parseYouTubeUrl(url: URL): YouTubeTarget | undefined;
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
interface FormatChoice$1 {
    readonly format: YouTubeFormat;
    readonly note: string | undefined;
}
declare function selectFormat(formats: readonly YouTubeFormat[], media: MediaIntent, targets: QualityTargets): FormatChoice$1 | undefined;
declare function splitArtistTitle(name: string, channel: string | undefined): {
    artist?: string;
    title: string;
};
declare const youtubeProvider: Provider;

type TagFormat = 'id3' | 'flac' | 'mp4';
declare function supportsTagging(filename: string): boolean;
declare function detectFormat(buffer: Buffer, filename: string): TagFormat | undefined;
declare function readTagsFromBuffer(buffer: Buffer, filename: string): TrackMetadata;
declare function writeTagsToBuffer(buffer: Buffer, filename: string, metadata: TrackMetadata): Buffer;
declare function readTags(file: string): Promise<TrackMetadata>;
declare function writeTags(file: string, metadata: TrackMetadata): Promise<void>;
declare function detectImageMime(data: Buffer): string | undefined;
declare function toArtwork(data: Buffer, description?: string): Artwork;
declare function artworkExtension(artwork: Artwork): string;
declare function readArtworkFile(file: string): Promise<Artwork>;

interface TaggingJob {
    readonly path: string;
    readonly metadata: TrackMetadata;
    readonly artworkUrl?: string | undefined;
}
interface TaggingOptions {
    readonly artwork?: boolean;
    readonly concurrency?: number;
    readonly signal?: AbortSignal | undefined;
    readonly maxArtworkBytes?: number;
}
interface TaggingReport {
    readonly tagged: number;
    readonly skipped: number;
    readonly warnings: readonly string[];
}
declare function applyMetadata(http: HttpClient, jobs: readonly TaggingJob[], options?: TaggingOptions): Promise<TaggingReport>;

declare function readId3(buffer: Buffer): TrackMetadata;
declare function writeId3(buffer: Buffer, metadata: TrackMetadata): Buffer;

declare function readFlac(buffer: Buffer): TrackMetadata;
declare function writeFlac(buffer: Buffer, metadata: TrackMetadata): Buffer;

declare function readMp4(buffer: Buffer): TrackMetadata;
declare function writeMp4(buffer: Buffer, metadata: TrackMetadata): Buffer;

interface DownloadRequest {
    readonly id: string;
    readonly url: string;
    readonly title: string;
    readonly outputDir: string;
    readonly referer?: string | undefined;
    readonly headers?: Readonly<Record<string, string>> | undefined;
    readonly expectedSize?: number | undefined;
    readonly filename?: string | undefined;
    readonly failureHint?: string | undefined;
}
type TaskState = 'queued' | 'probing' | 'downloading' | 'retrying' | 'completed' | 'skipped' | 'failed' | 'cancelled';
interface TaskSnapshot {
    readonly id: string;
    readonly title: string;
    readonly state: TaskState;
    readonly received: number;
    readonly total: number | undefined;
    readonly speed: number;
    readonly etaMs: number | undefined;
    readonly resumedFrom: number;
    readonly attempt: number;
    readonly destination: string | undefined;
    readonly error: string | undefined;
}
interface DownloadOutcome {
    readonly request: DownloadRequest;
    readonly state: Extract<TaskState, 'completed' | 'skipped' | 'failed' | 'cancelled'>;
    readonly path: string | undefined;
    readonly bytes: number;
    readonly durationMs: number;
    readonly resumed: boolean;
    readonly error: Error | undefined;
}
type ConflictPolicy = 'rename' | 'skip' | 'overwrite';

interface DownloadEngineOptions {
    concurrency?: number;
    retries?: number;
    retryDelayMs?: number;
    stallTimeoutMs?: number;
    conflict?: ConflictPolicy;
    resume?: boolean;
    dryRun?: boolean;
    onUpdate?: (snapshot: TaskSnapshot) => void;
}
declare class DownloadEngine {
    private readonly http;
    private readonly concurrency;
    private readonly retries;
    private readonly retryDelayMs;
    private readonly stallTimeoutMs;
    private readonly conflict;
    private readonly resume;
    private readonly dryRun;
    private readonly onUpdate;
    constructor(http: HttpClient, options?: DownloadEngineOptions);
    run(requests: readonly DownloadRequest[], signal?: AbortSignal): Promise<DownloadOutcome[]>;
    private publish;
    private runTask;
    private explain;
    private resolveDestination;
    private transferWithRetry;
    private resolveResumeOffset;
    private transfer;
    private finalize;
}

declare function sanitizeFilename(input: string, fallback?: string): string;
declare function buildFilename(options: {
    title?: string | undefined;
    url: URL;
    contentDisposition?: string | null | undefined;
    contentType?: string | null | undefined;
    defaultExtension?: string | undefined;
}): string;

type Settled<T> = {
    readonly status: 'fulfilled';
    readonly value: T;
} | {
    readonly status: 'rejected';
    readonly reason: unknown;
};
interface PoolOptions {
    limit: number;
    signal?: AbortSignal | undefined;
}
declare function mapPool<T, R>(items: readonly T[], worker: (item: T, index: number) => Promise<R>, options: PoolOptions): Promise<Settled<R>[]>;

declare function formatBytes(bytes: number, fractionDigits?: number): string;
declare function formatRate(bytesPerSecond: number): string;
declare function formatDuration(ms: number): string;
declare function formatEta(ms: number | undefined): string;
declare function formatPercent(ratio: number): string;
declare const displayWidth: (text: string) => number;
declare function truncate(text: string, maxWidth: number, ellipsis?: string): string;
declare function padEnd(text: string, width: number): string;
declare function padStart(text: string, width: number): string;
declare function renderBar(ratio: number, width: number, glyphs: {
    full: string;
    partial: readonly string[];
    empty: string;
}): string;
declare function pluralize(count: number, singular: string, plural?: string): string;

declare const configSchema: z.ZodObject<{
    outputDir: z.ZodDefault<z.ZodString>;
    concurrency: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
    retries: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
    timeoutMs: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
    stallTimeoutMs: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
    userAgent: z.ZodDefault<z.ZodString>;
    referer: z.ZodDefault<z.ZodString>;
    kinds: z.ZodDefault<z.ZodArray<z.ZodEnum<{
        audio: "audio";
        video: "video";
        image: "image";
        archive: "archive";
        document: "document";
        other: "other";
    }>>>;
    conflict: z.ZodDefault<z.ZodEnum<{
        rename: "rename";
        skip: "skip";
        overwrite: "overwrite";
    }>>;
    resume: z.ZodDefault<z.ZodBoolean>;
    allowPrivateHosts: z.ZodDefault<z.ZodBoolean>;
    allowInsecure: z.ZodDefault<z.ZodBoolean>;
    fallback: z.ZodDefault<z.ZodBoolean>;
}, z.core.$strip>;
type Config = z.infer<typeof configSchema>;
type ConfigInput = z.input<typeof configSchema>;

declare function configFilePath(): string;
interface ResolveConfigOptions {
    overrides?: Partial<ConfigInput>;
    file?: string;
    env?: NodeJS.ProcessEnv;
}
declare function resolveConfig(options?: ResolveConfigOptions): Promise<Config>;

interface FallbackTool {
    readonly binary: string;
    readonly version: string;
}
declare function detectFallbackTool(): Promise<FallbackTool | undefined>;
declare function formatSelector(media: MediaIntent, quality: QualityTargets, permissive?: boolean): string[];
interface FallbackRequest {
    readonly url: string;
    readonly outputDir: string;
    readonly filename: string;
    readonly media: MediaIntent;
    readonly quality: QualityTargets;
    readonly signal?: AbortSignal | undefined;
    readonly onProgress?: ((percent: number) => void) | undefined;
    readonly onRetry?: (() => void) | undefined;
    readonly timeoutMs?: number | undefined;
}
interface FallbackResult {
    readonly path: string;
    readonly tool: FallbackTool;
}
declare function runFallback(tool: FallbackTool, request: FallbackRequest): Promise<FallbackResult>;

declare const AUDIO_FORMATS: readonly ["mp3", "m4a", "flac", "wav", "opus", "ogg"];
declare const VIDEO_FORMATS: readonly ["mp4", "mkv", "webm"];
type AudioFormat = (typeof AUDIO_FORMATS)[number];
type VideoFormat = (typeof VIDEO_FORMATS)[number];
type MediaFormat = AudioFormat | VideoFormat;
type FormatIntent = 'original' | 'compatible' | 'archive';
interface FormatChoice {
    readonly intent: FormatIntent;
    readonly audio: AudioFormat | undefined;
    readonly video: VideoFormat | undefined;
}
declare const KEEP_ORIGINAL: FormatChoice;
declare function parseFormat(input: string): FormatChoice;
interface SourceProbe {
    readonly extension: string;
    readonly audioCodec: string | undefined;
    readonly videoCodec: string | undefined;
    readonly audioBitrate: number | undefined;
}
type ConversionAction = 'none' | 'remux' | 'transcode';
interface ConversionPlan {
    readonly action: ConversionAction;
    readonly target: MediaFormat;
    readonly args: readonly string[];
    readonly warning: string | undefined;
}
declare function targetFormatFor(choice: FormatChoice, probe: SourceProbe): MediaFormat | undefined;
declare function planConversion(probe: SourceProbe, target: MediaFormat): ConversionPlan;

interface Toolchain {
    readonly ffmpeg: string;
    readonly ffprobe: string | undefined;
}
declare function detectToolchain(): Promise<Toolchain | undefined>;
declare function probeSource(tools: Toolchain, file: string, signal?: AbortSignal): Promise<SourceProbe>;
interface ConversionOutcome {
    readonly path: string;
    readonly action: ConversionPlan['action'];
    readonly warning: string | undefined;
}
declare function convertFile(tools: Toolchain, source: string, target: MediaFormat, options?: {
    signal?: AbortSignal | undefined;
    onProgress?: ((seconds: number) => void) | undefined;
    metadata?: TrackMetadata | undefined;
}): Promise<ConversionOutcome>;

declare const VERSION: string;

export { AUDIO_FORMATS, type Artwork, type AudioFormat, CancelledError, type Config, ConfigError, type ConfigInput, type ConflictPolicy, DEFAULT_QUALITY, DEFAULT_USER_AGENT, type DiscoverOptions, type DiscoveryResult, DownloadEngine, type DownloadEngineOptions, type DownloadOutcome, type DownloadRequest, EDITABLE_FIELDS, type EditableField, ExitCode, type ExtractOptions, type ExtractResult, FIELD_LABELS, type FallbackRequest, type FallbackResult, type FallbackTool, FilesystemError, type FormatChoice, HttpClient, type HttpClientOptions, HttpError, KEEP_ORIGINAL, MEDIA_KINDS, type MediaCandidate, type MediaFormat, type MediaIntent, type MediaKind, type MediaSource, NetworkError, type PoolOptions, type ProbeResult, type Provider, type ProviderContext, type ProviderResult, QUALITY_PRESETS, type QualityPreset, type QualityTargets, type RequestOptions, type ResolvedMedia, type RetryInfo, type Settled, type SizedCandidate, type TaggingJob, type TaggingOptions, type TaggingReport, type TaskSnapshot, type TaskState, type Toolchain, type TrackMetadata, type UrlGuardOptions, UsageError, VERSION, VIDEO_FORMATS, VectraxError, type VideoFormat, applyMetadata, artworkExtension, assertUrlAllowed, buildFilename, chooseByCeiling, collapseDuplicateQualities, computeBackoff, configFilePath, configSchema, convertFile, decodeBody, decodeEntities, detectFallbackTool, detectFormat, detectImageMime, detectQuality, detectToolchain, discover, displayWidth, extensionsForKinds, extractMedia, extractPageTitle, formatBytes, formatDuration, formatEta, formatPercent, formatRate, formatSelector, isEmptyMetadata, isPrivateHost, isVectraxError, kindForExtension, mapPool, mergeMetadata, normalizeUrl, padEnd, padStart, pageProvider, parseFormat, parseQuality, parseUrl, parseYouTubeUrl, planConversion, pluralize, probeSizes, probeSource, providerFor, providerIds, providers, readArtworkFile, readFlac, readId3, readMp4, readTags, readTagsFromBuffer, renderBar, resolveConfig, runFallback, sanitizeFilename, selectFormat, splitArtistTitle, supportsTagging, targetFormatFor, toArtwork, truncate, unsupportedProvider, writeFlac, writeId3, writeMp4, writeTags, writeTagsToBuffer, youtubeProvider };
